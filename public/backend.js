/* Replaces the host's claude.use("user" | "db" | "sample" | "downloads") with calls to this server.
   The page code is unchanged: it still calls claude.use(...) and gets the same shapes back. */
(function () {
  'use strict';
  let me = null;
  let team = [];
  let es = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  // ---------- http ----------
  async function api(path, method, body) {
    const init = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch('/api' + path, init); }
    catch (e) { const x = new Error('Cannot reach the server'); x.code = 'network'; throw x; }
    let j = null;
    try { j = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) {
      const x = new Error((j && j.error) || 'Request failed (' + r.status + ')');
      x.code = (j && j.code) || 'http_' + r.status;
      x.status = r.status;
      if (r.status === 401 && me) location.reload(); // session expired: back to the sign-in dialog
      throw x;
    }
    return j;
  }

  // ---------- local cache with live updates (the page expects Firestore-style snapshots) ----------
  const KNOWN = new Set(['tickets', 'kb', 'known', 'corrections', 'audit']);
  const stores = {};
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function S(n) {
    return stores[n] || (stores[n] = { n, cache: new Map(), subs: new Set(), pending: 0, dirty: false, loaded: false });
  }
  function fire(s) { s.subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
  async function load(n) {
    const s = S(n);
    if (s.pending > 0) { s.dirty = true; return; } // our own writes are in flight; reload when they land
    const rows = await api('/c/' + n + (n === 'audit' ? '?limit=100' : ''));
    if (s.pending > 0) { s.dirty = true; return; }
    s.cache = new Map(rows.map((r) => [r.id, r.data]));
    s.loaded = true;
    fire(s);
  }
  function snap(s, q) {
    let rows = Array.from(s.cache).map(([id, d]) => ({ id, d }));
    if (q && q.f) {
      const m = q.dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => (a.d[q.f] > b.d[q.f] ? 1 : a.d[q.f] < b.d[q.f] ? -1 : 0) * m);
    }
    if (q && q.n) rows = rows.slice(0, q.n);
    return { docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.d })) };
  }
  async function write(n, id, method, body, local) {
    const s = S(n);
    local(s.cache); // show it immediately, like the host did
    s.pending++;
    fire(s);
    try { await api('/c/' + n + '/' + encodeURIComponent(id), method, body); }
    catch (e) { s.pending--; s.dirty = true; await load(n).catch(() => {}); throw e; }
    s.pending--;
    if (!s.pending && s.dirty) { s.dirty = false; load(n).catch(() => {}); }
  }
  function docRef(n, id) {
    const s = S(n);
    return {
      set: (data) => write(n, id, 'PUT', data, (c) => c.set(id, clone(data))),
      update: (patch) => write(n, id, 'PATCH', patch, (c) => { const cur = c.get(id); if (cur) c.set(id, Object.assign({}, cur, clone(patch))); }),
      delete: () => write(n, id, 'DELETE', undefined, (c) => c.delete(id)),
      get: async () => { await load(n); const d = s.cache.get(id); return { exists: d !== undefined, data: () => d }; },
      onSnapshot: (cb, err) => {
        const f = () => { const d = s.cache.get(id); cb({ exists: d !== undefined, data: () => d }); };
        s.subs.add(f);
        if (s.loaded) f(); else load(n).catch((e) => { s.subs.delete(f); if (err) err(e); });
        return () => s.subs.delete(f);
      },
    };
  }
  function stubCollection() { // names the server does not store (the old per-user private area): always empty
    const doc = () => ({ set: async () => {}, update: async () => {}, delete: async () => {}, get: async () => ({ exists: false, data: () => undefined }), onSnapshot: () => () => {} });
    return { doc, add: async () => {}, get: async () => ({ docs: [] }), orderBy() { return this; }, limit() { return this; }, onSnapshot: () => () => {} };
  }
  function collection(name) {
    if (!KNOWN.has(name)) return stubCollection();
    const s = S(name);
    const mk = (q) => ({
      orderBy: (f, dir) => mk(Object.assign({}, q, { f, dir: dir || 'asc' })),
      limit: (n) => mk(Object.assign({}, q, { n })),
      get: async () => { await load(name); return snap(s, q); },
      onSnapshot: (cb, err) => {
        const f = () => cb(snap(s, q));
        s.subs.add(f);
        if (s.loaded) f(); else load(name).catch((e) => { s.subs.delete(f); if (err) err(e); });
        return () => s.subs.delete(f);
      },
    });
    const ref = mk({});
    ref.doc = (id) => docRef(name, id);
    ref.add = async (data) => {
      if (name === 'audit') { await api('/c/audit', 'POST', data); return; }
      await docRef(name, newId()).set(data);
    };
    return ref;
  }
  function doc(path) { const [c, id] = String(path).split('/'); return KNOWN.has(c) ? docRef(c, id) : stubCollection().doc(); }

  // live updates from teammates; polling is the safety net if the stream drops
  const timers = {};
  function reloadSoon(n) { clearTimeout(timers[n]); timers[n] = setTimeout(() => load(n).catch(() => {}), 150); }
  function startEvents() {
    if (es || !window.EventSource) return;
    es = new EventSource('/api/events');
    es.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (stores[m.c] && stores[m.c].loaded) reloadSoon(m.c); } catch (e) { /* ignore */ } };
  }
  setInterval(() => { if (!document.hidden) Object.keys(stores).forEach((n) => { if (stores[n].loaded) reloadSoon(n); }); }, 45000);

  // ---------- the four host services ----------
  async function refreshTeam() { try { team = await api('/team'); } catch (e) { /* keep old list */ } }
  const userSvc = {
    id: async () => me.user.id,
    profiles: async (ids) => { await refreshTeam(); const out = {}; ids.forEach((i) => { const p = team.find((t) => t.id === i); if (p) out[i] = { name: p.name }; }); return out; },
    search: async () => { await refreshTeam(); return team.map((t) => ({ id: t.id, name: t.name })); },
  };
  const dbSvc = { collection, doc };

  const toB64 = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('Could not read the image'));
    fr.readAsDataURL(blob);
  });
  const sampleSvc = {
    async json(prompt, opts) {
      opts = opts || {};
      const images = [];
      for (const f of opts.images || []) images.push({ type: f.type, data: await toB64(f) });
      const r = await api('/analyze', 'POST', { prompt, tier: opts.modelTier || 'default', images });
      if (r.usage) { me.usage = r.usage; drawBar(); }
      return r.json;
    },
    async limits() { return { images: me.limits.maxImages > 0 ? { maxCount: me.limits.maxImages } : null }; },
  };
  const downloadsSvc = {
    save: async ({ filename, data }) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }));
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };

  window.claude = {
    use: async (name) => {
      await ready;
      if (name === 'user') return userSvc;
      if (name === 'db') return dbSvc;
      if (name === 'sample') return me.aiEnabled ? sampleSvc : null;
      if (name === 'downloads') return downloadsSvc;
      return null;
    },
  };

  // ---------- sign-in dialog, top bar, team dialog ----------
  const css = document.createElement('style');
  css.textContent = [
    '#tdbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between;background:var(--panel);border-bottom:1px solid var(--line);padding:6px 16px;font-size:13px;color:var(--mute)}',
    '#tdbar b{color:var(--ink);font-weight:600}',
    '#tdbar .grp{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.tdmeter{display:inline-block;width:90px;height:8px;background:var(--soft);border-radius:4px;overflow:hidden;vertical-align:middle}',
    '.tdmeter i{display:block;height:100%;background:var(--accent)}',
    '.tdmeter.hot i{background:var(--p2)}.tdmeter.full i{background:var(--p1)}',
    'dialog.td{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:20px;width:min(420px,calc(100vw - 32px))}',
    'dialog.td::backdrop{background:rgba(10,20,26,.55)}',
    'dialog.td h2{font-size:22px;margin-bottom:4px}',
    'dialog.td label{display:block;font-size:13px;color:var(--mute);margin:10px 0 3px}',
    'dialog.td input,dialog.td select{width:100%;border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--bg);color:var(--ink);font:inherit}',
    'dialog.td .err{color:var(--p1);font-size:14px;min-height:20px;margin-top:8px}',
    'dialog.td .acts{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap}',
    'dialog.td .link{background:none;border:0;padding:0;color:var(--accent);text-decoration:underline;font-weight:500}',
    'dialog.td .ok{color:var(--accent);font-size:14px;min-height:20px;margin-top:8px}',
    '#tdnote{background:var(--soft);border-bottom:1px solid var(--line);padding:6px 16px;font-size:13px;color:var(--ink)}',
    '#tdbar .warn{color:var(--p2);font-weight:600}',
    'dialog.td table{width:100%;min-width:0;margin-top:8px}',
  ].join('');
  document.head.appendChild(css);

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach((c) => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }
  function field(id, label, type, extra) {
    const input = el('input', Object.assign({ id, type: type || 'text', required: '' }, extra || {}));
    return [el('label', { for: id, text: label }), input];
  }

  function authDialog(initialNotice) {
    return new Promise((resolve) => {
      let mode = 'signin';
      let notice = initialNotice || '';
      const dlg = el('dialog', { class: 'td', 'aria-labelledby': 'tda-h' });
      dlg.addEventListener('cancel', (e) => e.preventDefault()); // cannot be dismissed without signing in
      const form = el('form');
      const err = el('div', { class: 'err', role: 'alert' });
      const fields = el('div');
      const forgot = el('button', { class: 'link', type: 'button', text: 'Forgot password?' });
      const title = el('h2', { id: 'tda-h' });
      const sub = el('p', { class: 'sub', style: 'margin:0 0 4px' });
      const submit = el('button', { class: 'primary', type: 'submit' });
      const toggle = el('button', { class: 'link', type: 'button' });
      function draw() {
        fields.textContent = '';
        const f = [];
        if (mode === 'signup') {
          f.push(...field('tda-org', 'Workspace name', 'text', { autocomplete: 'organization', maxlength: '80' }));
          f.push(...field('tda-name', 'Your name', 'text', { autocomplete: 'name', maxlength: '80' }));
        }
        f.push(...field('tda-email', 'Work email', 'email', { autocomplete: 'email', maxlength: '255' }));
        if (mode !== 'forgot') f.push(...field('tda-pw', mode === 'signup' ? 'Password (10 characters or more)' : 'Password', 'password',
          { autocomplete: mode === 'signup' ? 'new-password' : 'current-password', minlength: mode === 'signup' ? '10' : '1', maxlength: '200' }));
        f.forEach((n) => fields.appendChild(n));
        title.textContent = mode === 'signup' ? 'Create your workspace' : mode === 'forgot' ? 'Reset your password' : 'Sign in to Triage Desk';
        sub.textContent = mode === 'signup' ? 'Your team shares one private queue, knowledge base and audit log.'
          : mode === 'forgot' ? 'Enter your email and we will send you a link to choose a new password.'
          : 'Your queue, knowledge base and audit log are private to your workspace.';
        submit.textContent = mode === 'signup' ? 'Create workspace' : mode === 'forgot' ? 'Email me a link' : 'Sign in';
        toggle.textContent = mode === 'signup' ? 'I already have an account' : mode === 'forgot' ? 'Back to sign in' : 'Create a workspace';
        forgot.hidden = mode !== 'signin';
        err.className = 'err'; err.textContent = notice; notice = '';
        if (err.textContent) err.className = 'ok';
        const first = fields.querySelector('input');
        if (first) setTimeout(() => first.focus(), 0);
      }
      toggle.onclick = () => { mode = mode === 'signin' ? 'signup' : 'signin'; draw(); };
      forgot.onclick = () => { mode = 'forgot'; draw(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        submit.disabled = true; err.className = 'err'; err.textContent = '';
        const v = (id) => (form.querySelector('#' + id) || {}).value || '';
        try {
          if (mode === 'forgot') {
            await api('/password/forgot', 'POST', { email: v('tda-email') });
            err.className = 'ok'; err.textContent = 'If that address has an account, a reset link is on its way. It expires in one hour.';
            submit.disabled = false; return;
          }
          if (mode === 'signup') await api('/signup', 'POST', { orgName: v('tda-org'), name: v('tda-name'), email: v('tda-email'), password: v('tda-pw') });
          else await api('/login', 'POST', { email: v('tda-email'), password: v('tda-pw') });
          dlg.close(); dlg.remove(); resolve();
        } catch (x) { err.textContent = x.message; submit.disabled = false; }
      };
      form.append(title, sub, fields, err, el('div', { class: 'acts' }, [toggle, forgot, submit]));
      dlg.appendChild(form);
      document.body.appendChild(dlg);
      draw();
      dlg.showModal();
    });
  }

  // Opened from the link in the reset email (#reset=TOKEN). Resolves once the password is changed.
  function resetDialog(token) {
    return new Promise((resolve) => {
      const dlg = el('dialog', { class: 'td', 'aria-labelledby': 'tdr-h' });
      dlg.addEventListener('cancel', (e) => e.preventDefault());
      const form = el('form');
      const err = el('div', { class: 'err', role: 'alert' });
      const submit = el('button', { class: 'primary', type: 'submit', text: 'Change password' });
      const back = el('button', { class: 'link', type: 'button', text: 'Back to sign in' });
      back.onclick = () => { dlg.close(); dlg.remove(); resolve(false); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const p1 = form.querySelector('#tdr-pw').value, p2 = form.querySelector('#tdr-pw2').value;
        if (p1 !== p2) { err.textContent = 'The two passwords do not match'; return; }
        submit.disabled = true; err.textContent = '';
        try { await api('/password/reset', 'POST', { token, password: p1 }); dlg.close(); dlg.remove(); resolve(true); }
        catch (x) { err.textContent = x.message; submit.disabled = false; }
      };
      const pw = { autocomplete: 'new-password', minlength: '10', maxlength: '200' };
      form.append(el('h2', { id: 'tdr-h', text: 'Choose a new password' }),
        ...field('tdr-pw', 'New password (10 characters or more)', 'password', pw),
        ...field('tdr-pw2', 'Repeat the new password', 'password', pw),
        err, el('div', { class: 'acts' }, [back, submit]));
      dlg.appendChild(form);
      document.body.appendChild(dlg);
      dlg.showModal();
      setTimeout(() => form.querySelector('#tdr-pw').focus(), 0);
    });
  }

  // Links in emails carry a one-time token in the #fragment. Read it once and remove it from the address bar.
  function takeHashToken() {
    const m = /^#(reset|verify)=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
    if (m) history.replaceState(null, '', location.pathname + location.search);
    return m ? { kind: m[1], token: m[2] } : null;
  }
  // A link pasted into a tab that is already open only changes the hash: reload so boot sees it.
  window.addEventListener('hashchange', () => { if (/^#(reset|verify)=/.test(location.hash)) location.reload(); });
  function showNote(text) {
    const n = el('div', { id: 'tdnote', role: 'status', text });
    document.body.insertBefore(n, document.body.firstChild);
    setTimeout(() => n.remove(), 12000);
  }

  let bar;
  function fmtN(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n); }
  function drawBar() {
    if (!me) return;
    if (!bar) { bar = el('div', { id: 'tdbar' }); document.body.insertBefore(bar, document.body.firstChild); }
    bar.textContent = '';
    const left = el('div', { class: 'grp' }, [el('b', { text: me.org.name }), document.createTextNode(me.user.name + ' (' + me.user.role + ')')]);
    const u = me.usage;
    const ai = el('div', { class: 'grp' });
    if (me.email && me.email.enabled && !me.email.verified) {
      ai.appendChild(el('span', { class: 'warn', text: 'Confirm your email (' + me.user.email + ') to turn on AI analysis.' }));
      const rs = el('button', { class: 'chip', type: 'button', text: 'Resend link' });
      rs.onclick = async () => {
        rs.disabled = true;
        try { await api('/email/send-verification', 'POST', {}); rs.textContent = 'Sent. Check your inbox'; }
        catch (x) { rs.textContent = x.message; }
      };
      ai.appendChild(rs);
    } else if (!me.aiEnabled) {
      ai.appendChild(document.createTextNode(u && u.cap <= 0 ? 'Plan: ' + u.plan + ' (keyword rules only, AI analysis not included)' : 'AI analysis is not available on this server'));
    } else {
      const pct = Math.min(100, Math.round((100 * u.used) / u.cap));
      const m = el('span', { class: 'tdmeter' + (pct >= 100 ? ' full' : pct >= 80 ? ' hot' : ''), role: 'img', 'aria-label': pct + ' percent of the monthly AI allowance used' }, [el('i', { style: 'width:' + pct + '%' })]);
      ai.append(document.createTextNode('AI this month: ' + fmtN(u.used) + ' of ' + fmtN(u.cap) + ' tokens (' + u.plan + ')'), m);
      if (pct >= 100) ai.appendChild(el('b', { text: 'Limit reached: keyword rules still work' }));
    }
    const right = el('div', { class: 'grp' });
    if (me.user.role === 'admin') { const b = el('button', { class: 'chip', type: 'button', text: 'Team' }); b.onclick = teamDialog; right.appendChild(b); }
    const out = el('button', { class: 'chip', type: 'button', text: 'Sign out' });
    out.onclick = async () => { try { await api('/logout', 'POST', {}); } catch (e) { /* ignore */ } location.reload(); };
    right.appendChild(out);
    bar.append(left, ai, right);
  }

  async function teamDialog() {
    await refreshTeam();
    const dlg = el('dialog', { class: 'td', 'aria-labelledby': 'tdt-h' });
    const form = el('form', { method: 'dialog' });
    const list = el('div');
    const err = el('div', { class: 'err', role: 'alert' });
    function drawList() {
      list.textContent = '';
      const t = el('table');
      team.forEach((m) => {
        const tr = el('tr', {}, [el('td', { text: m.name + ' · ' + m.role }), el('td', { text: m.email })]);
        if (m.id !== me.user.id) {
          const b = el('button', { class: 'chip', type: 'button', text: 'Remove' });
          b.onclick = async () => { err.textContent = ''; try { await api('/team/' + encodeURIComponent(m.id), 'DELETE'); await refreshTeam(); drawList(); } catch (x) { err.textContent = x.message; } };
          tr.appendChild(el('td', {}, [b]));
        }
        t.appendChild(tr);
      });
      list.appendChild(t);
    }
    drawList();
    const role = el('select', { id: 'tdt-role' }, [el('option', { value: 'agent', text: 'Agent (can edit)' }), el('option', { value: 'viewer', text: 'Viewer (read-only)' }), el('option', { value: 'admin', text: 'Admin' })]);
    const add = el('button', { class: 'primary', type: 'button', text: 'Add teammate' });
    const f1 = field('tdt-name', 'Name', 'text', { maxlength: '80' }), f2 = field('tdt-email', 'Email', 'email'), f3 = field('tdt-pw', 'Temporary password (10 characters or more)', 'text', { minlength: '10' });
    add.onclick = async () => {
      err.textContent = '';
      const v = (id) => form.querySelector('#' + id).value;
      try {
        await api('/team', 'POST', { name: v('tdt-name'), email: v('tdt-email'), password: v('tdt-pw'), role: v('tdt-role') });
        ['tdt-name', 'tdt-email', 'tdt-pw'].forEach((i) => { form.querySelector('#' + i).value = ''; });
        await refreshTeam(); drawList();
      } catch (x) { err.textContent = x.message; }
    };
    const close = el('button', { type: 'submit', formnovalidate: '', text: 'Close' }); // must close even with empty fields
    form.append(el('h2', { id: 'tdt-h', text: 'Team' }), list, ...f1, ...f2, ...f3, el('label', { for: 'tdt-role', text: 'Role' }), role, err, el('div', { class: 'acts' }, [close, add]));
    dlg.appendChild(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  async function boot() {
    const link = takeHashToken();
    let note = '';
    if (link && link.kind === 'reset') {
      await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
      if (await resetDialog(link.token)) note = 'Password changed. Sign in with your new password.';
    } else if (link && link.kind === 'verify') {
      try { await api('/email/verify', 'POST', { token: link.token }); note = 'Email confirmed. Thank you.'; }
      catch (x) { note = x.message; }
    }
    try { me = await api('/me'); }
    catch (e) {
      if (e.code === 'network') { document.addEventListener('DOMContentLoaded', () => { document.body.insertBefore(el('div', { id: 'tdbar', text: 'Cannot reach the server. Reload to try again.' }), document.body.firstChild); }); return; }
      await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
      await authDialog(link && link.kind === 'reset' ? note : '');
      me = await api('/me');
      if (link && link.kind === 'reset') note = '';
    }
    await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
    drawBar();
    if (note) showNote(note);
    // Confirmed the address in another tab? Pick that up when this tab is shown again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !(me.email && me.email.enabled && !me.email.verified)) return;
      api('/me').then((m) => { if (m.email && m.email.verified) location.reload(); }).catch(() => {});
    });
    startEvents();
    setInterval(() => { if (!document.hidden) api('/usage').then((u) => { me.usage = u; drawBar(); }).catch(() => {}); }, 60000);
    readyResolve();
  }
  boot();
})();
