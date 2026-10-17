"""
Hostile-input browser tests for Triage Desk.

Start the server first:   E2E_PORT=3457 node --disable-warning=ExperimentalWarning test/e2e/xss-server.mjs
Run:                      python3 test/e2e/xss.py          (exit code 1 if any check fails)

How injection is detected (independent of the Content-Security-Policy):
  - every payload carries an inert <pwn-el> tag and a data-pwn attribute. If either shows up in the DOM, the page let
    attacker text become markup, even if a CSP then stopped it from running.
  - payloads also try to run script (img onerror, script tag, javascript: URLs). window.__pwned records any that ran.
  - any on* attribute or javascript: URL anywhere in the document is flagged (the page has none of its own).
"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3457/"
RUN = str(int(time.time()))
FAILS = []
PAGE_ERRORS = []


def X(v):
    """Polyglot: breaks out of element text, double-quoted and single-quoted attributes, and tries to run script."""
    return (f'x" data-pwn="{v}"><pwn-el data-pwn="{v}"></pwn-el><img src=x onerror=__pwned.push("{v}")>'
            f"'<i data-pwn='{v}'>")


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or not detail else "\n        " + str(detail)))
    if not ok:
        FAILS.append(name)


SCAN_JS = """() => {
  const out = [];
  document.querySelectorAll('pwn-el').forEach(e => out.push('tag:' + (e.getAttribute('data-pwn') || '?')));
  document.querySelectorAll('[data-pwn]').forEach(e => {
    if (e.tagName.toLowerCase() !== 'pwn-el') out.push('attr:' + e.getAttribute('data-pwn'));
  });
  document.querySelectorAll('*').forEach(e => {
    for (const a of e.attributes) {
      if (/^on/i.test(a.name)) out.push('handler:' + a.name + '@' + e.tagName.toLowerCase());
      if (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\\s*javascript:/i.test(a.value))
        out.push('jsurl:' + e.tagName.toLowerCase());
    }
  });
  (window.__pwned || []).forEach(v => out.push('ran:' + v));
  return [...new Set(out)];
}"""


def scan(page):
    page.wait_for_timeout(350)  # let async renders (live updates, debounced redraws) land
    return page.evaluate(SCAN_JS)


def until(fn, timeout=10, what=""):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return
        except Exception:
            pass
        time.sleep(0.15)
    raise AssertionError("timed out waiting for " + what)


def new_page(browser, tag):
    ctx = browser.new_context()
    page = ctx.new_page()
    page.add_init_script("window.__pwned = [];")
    page.on("pageerror", lambda e: PAGE_ERRORS.append(f"{tag}: {e}"))
    return ctx, page


def signup(page, org, name, email):
    page.goto(BASE)
    page.wait_for_selector("dialog.td[open]")
    page.click("text=Create a workspace")
    page.fill("#tda-org", org)
    page.fill("#tda-name", name)
    page.fill("#tda-email", email)
    page.fill("#tda-pw", "correct-horse-battery")
    page.click("text=Create workspace")
    page.wait_for_selector("#tdbar")


def triage(page, text, cust=""):
    page.fill("#txt", text)
    page.fill("#cust", cust)
    page.click("#go")
    page.wait_for_selector("#out .head h3")


def csv_bytes(rows):
    import csv, io
    b = io.StringIO()
    csv.writer(b).writerows(rows)
    return b.getvalue().encode()


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ------------------------------------------------------------------ the scanner itself works
    ctxA, pa = new_page(browser, "Ada")
    signup(pa, "Acme", "Ada", f"ada{RUN}@acme.test")
    pa.wait_for_selector("#qb")
    check("scanner: clean page has no findings", scan(pa) == [], scan(pa))
    pa.evaluate("document.body.insertAdjacentHTML('beforeend','<pwn-el data-pwn=\"selftest\"></pwn-el>')")
    check("scanner: detects an injected tag", "tag:selftest" in scan(pa))
    pa.evaluate("document.querySelectorAll('pwn-el').forEach(e => e.remove())")

    # ------------------------------------------------------------------ CSP is a backstop, not just a header
    csp = pa.request.get(BASE).headers.get("content-security-policy", "")
    directives = {d.strip().split(" ")[0]: d.strip().split(" ")[1:] for d in csp.split(";") if d.strip()}
    check("CSP: script-src has no 'unsafe-inline'", "'unsafe-inline'" not in directives.get("script-src", ["'unsafe-inline'"]), csp)
    check("CSP: object-src is none", directives.get("object-src") == ["'none'"], csp)
    check("CSP: form-action is self", directives.get("form-action") == ["'self'"], csp)
    pa.evaluate("""document.body.insertAdjacentHTML('beforeend','<img id=cspimg src=x onerror="__pwned.push(\\'csp-backstop\\')">')""")
    pa.wait_for_timeout(600)
    ran = pa.evaluate("window.__pwned")
    check("CSP: an injected inline handler does not run", "csp-backstop" not in ran, ran)
    pa.evaluate("document.getElementById('cspimg')?.remove(); window.__pwned = []")

    # ------------------------------------------------------------------ typed text, customer field, then queued and re-rendered
    triage(pa, "Checkout is down for all customers. " + X("free-text"), cust=X("cust"))
    check("typed text: result panel has no injected markup", scan(pa) == [], scan(pa))
    shown = pa.inner_text("#out")
    check("typed text: hostile customer name is shown as literal text", '<pwn-el data-pwn="cust">' in shown, shown[:300])
    for btn in ("#nsfull", "#nsesc", "#nstrk", "#nskn"):
        pa.click(btn)
        check(f"typed text: {btn} panel has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#add")
    pa.wait_for_selector("#qb tr td.t")
    check("typed text: queue row has no injected markup", scan(pa) == [], scan(pa))

    # ------------------------------------------------------------------ tracker link from localStorage must be https only
    pa.evaluate("""localStorage.setItem('td_tracker', 'javascript:__pwned.push("tracker")//{q}')""")
    triage(pa, "Checkout is down for all customers")
    pa.click("#nstrk")
    check("tracker: a javascript: link in storage is not turned into a link", scan(pa) == [], scan(pa))
    pa.evaluate("localStorage.removeItem('td_tracker')")

    # ------------------------------------------------------------------ pasted email: headers, HTML part, entity-encoded tags, attachment name
    eml = "\r\n".join([
        'From: <pwn-el data-pwn="email-from"></pwn-el><img src=x onerror=__pwned.push("email-from")> <a@b.test>',
        "To: support@acme.test",
        'Subject: Help <pwn-el data-pwn="email-subject"></pwn-el><img src=x onerror=__pwned.push("email-subject")>',
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="BND"',
        "",
        "--BND",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Nobody can log in</p><pwn-el data-pwn="email-html"></pwn-el>'
        " &lt;pwn-el data-pwn=&quot;email-entity&quot;&gt; &lt;img src=x onerror=__pwned.push(&quot;email-entity&quot;)&gt;",
        "--BND",
        "Content-Type: text/plain; name=<pwn-el data-pwn=email-attname><img src=x onerror=__pwned.push('email-attname')>.txt",
        "Content-Disposition: attachment",
        "",
        "attached",
        "--BND--",
        "",
    ])
    triage(pa, eml)
    check("email: result panel has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#add")
    check("email: queue has no injected markup", scan(pa) == [], scan(pa))

    # ------------------------------------------------------------------ attached file names
    attname = '"><pwn-el data-pwn="att-name"><img src=x onerror=__pwned.push(\'att-name\')>\' data-pwn=\'att-name\'.txt'
    pa.set_input_files("#att", [{"name": attname, "mimeType": "text/plain", "buffer": b"Nobody can log in since this morning"}])
    pa.wait_for_selector("#attl span")
    check("attachments: file name list has no injected markup", scan(pa) == [], scan(pa))
    pa.fill("#txt", "")
    pa.click("#go")
    pa.wait_for_selector("#out .head h3")
    check("attachments: result panel has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#add")
    check("attachments: queue has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#clr")

    # ------------------------------------------------------------------ bulk CSV import (rules): headers, cells
    pa.set_input_files("#file", [{"name": "tickets.csv", "mimeType": "text/csv", "buffer": csv_bytes([
        ["description", "customer", '<pwn-el data-pwn="csv-header"><img src=x onerror=__pwned.push(\'csv-header\')>'],
        ["Cannot log in " + X("csv-desc"), X("csv-cust"), "x"],
    ])}])
    pa.wait_for_selector("#bgo")
    check("csv import: column picker has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#bgo")
    until(lambda: "Triaged 1 tickets" in pa.inner_text("#bstat"), 10, "csv import to finish")
    check("csv import: queue has no injected markup", scan(pa) == [], scan(pa))

    # ------------------------------------------------------------------ hostile model output (a ticket that prompt-injects the model)
    pa.click("#clr")
    pa.fill("#txt", "EVIL-AI-OUTPUT checkout is down for every customer")
    pa.click("#ai")
    pa.wait_for_selector("#out .badge:has-text('Claude')", timeout=15000)
    check("AI output: result panel has no injected markup", scan(pa) == [], scan(pa))
    heading = pa.inner_text("#out .head h3")
    check("AI output: category 'constructor' is not accepted as a category", "constructor" not in heading, heading)
    for btn in ("#nsfull", "#nsesc", "#nstrk", "#nskn"):
        pa.click(btn)
        check(f"AI output: {btn} panel has no injected markup", scan(pa) == [], scan(pa))
    pa.click("#add")
    check("AI output: queue has no injected markup", scan(pa) == [], scan(pa))

    pa.set_input_files("#file", [{"name": "bulk.csv", "mimeType": "text/csv", "buffer": csv_bytes([
        ["description", "customer"], ["EVIL-AI-OUTPUT bulk cannot log in", "BulkCo"]])}])
    pa.wait_for_selector("#bgo")
    pa.check("#bai")
    pa.click("#bgo")
    until(lambda: "Triaged 1 tickets" in pa.inner_text("#bstat"), 15, "bulk AI import to finish")
    check("AI output (bulk): queue has no injected markup", scan(pa) == [], scan(pa))

    # ------------------------------------------------------------------ hostile data written straight to the API by a teammate
    # (the page must treat stored documents as untrusted: any agent can PUT arbitrary JSON, not just what the page would write)
    triage(pa, "Password reset email never arrives", cust="ControlCo")
    pa.click("#add")
    pa.wait_for_selector("#qb tr td.t")
    pa.click("#tdbar >> text=Team")
    pa.fill("#tdt-name", "Cy")
    pa.fill("#tdt-email", f"cy{RUN}@acme.test")
    pa.fill("#tdt-pw", "temporary-pass-1")
    pa.select_option("#tdt-role", "agent")
    pa.click("text=Add teammate")
    pa.wait_for_selector(f"dialog.td table >> text=cy{RUN}@acme.test")
    pa.click("dialog.td >> text=Close")

    ctxCy = browser.new_context()
    r = ctxCy.request.post(BASE + "api/login", data={"email": f"cy{RUN}@acme.test", "password": "temporary-pass-1"})
    assert r.ok, r.text()
    now = int(time.time() * 1000)

    def ticket(tid, **kw):
        d = {"id": tid, "pr": "P3", "primary": "Bug", "summary": "stored ticket", "cust": "StoredCo",
             "route": "Tier 1 (frontline support)", "status": "open", "createdAt": now, "text": "stored text",
             "source": "text", "assignee": "", "attNames": [], "signals": [], "notes": []}
        d.update(kw)
        return d

    def put(coll, doc_id, doc):
        r = ctxCy.request.put(BASE + f"api/c/{coll}/{doc_id}", data=doc)
        assert r.ok, (coll, doc_id, r.status, r.text())

    put("tickets", "t_pr_manual", ticket("t_pr_manual", pr=X("st-pr-manual"), manual=True))
    put("tickets", "t_pr", ticket("t_pr", pr=X("st-pr")))
    put("tickets", "t_primary", ticket("t_primary", primary=X("st-primary")))
    put("tickets", "t_fields", ticket(X("st-id"), summary=X("st-summary"), cust=X("st-cust"), route=X("st-route"),
                                      source=X("st-source"), assignee=X("st-assignee"), linkedTo=X("st-linked"),
                                      attNames=[X("st-att")]))
    put("tickets", "t_types", ticket("t_types", pr=5, primary={"a": 1}, summary=["x"], cust=None, text={"a": 1},
                                     createdAt="soon", status={"b": 2}, attNames="not-an-array", kb="nope",
                                     ctx="nope", signals="nope", notes="nope"))
    put("corrections", "all", {"items": [
        {"t": "payment checkout down corrtest", "c": "Bug", "p": X("st-corr-p")},
        {"t": "other words entirely", "c": X("st-corr-c"), "p": 2}]})
    put("kb", "k_evil", {"id": "k_evil", "title": X("st-kb-title"), "body": "body", "url": "javascript:__pwned.push('st-kb-url')", "updatedAt": now})
    put("kb", "k_evil2", {"id": "k_evil2", "title": "ok", "body": "body", "url": 'https://example.test/" data-pwn="st-kb-url2', "updatedAt": now})
    put("known", "n_evil", {"id": "n_evil", "title": X("st-kn-title"), "keywords": X("st-kn-kw-string"), "status": X("st-kn-status"), "url": "javascript:x", "updatedAt": now})
    put("known", "n_evil2", {"id": "n_evil2", "title": "ok", "keywords": [X("st-kn-kw")], "status": "open", "url": "", "updatedAt": now})
    ra = ctxCy.request.post(BASE + "api/c/audit", data={"act": "changed_pr", "tid": "t_pr", "d": X("st-audit-d")[:190]})
    assert ra.ok, ra.text()

    # live update path (Ada's page is already open and receives these over the event stream)
    pa.wait_for_timeout(1500)
    pa.click("#andet summary")
    pa.click("#audet summary")
    check("stored data, live update: no injected markup anywhere", scan(pa) == [], scan(pa))
    check("stored data, live update: the queue still renders the control ticket", "ControlCo" in pa.inner_text("#qb"), pa.inner_text("#qb")[:200])

    # fresh load path
    pa.reload()
    pa.wait_for_selector("#qb tr td.t", timeout=10000)
    pa.click("#andet summary")
    pa.click("#audet summary")
    check("stored data, fresh load: no injected markup anywhere", scan(pa) == [], scan(pa))
    check("stored data, fresh load: the queue still renders the control ticket", "ControlCo" in pa.inner_text("#qb"), pa.inner_text("#qb")[:200])
    check("stored data, fresh load: known-issue and KB lists still render", "ok" in pa.inner_text("#knl") and "ok" in pa.inner_text("#kbl"),
          (pa.inner_text("#knl")[:120], pa.inner_text("#kbl")[:120]))

    # a stored correction is applied when a similar ticket is triaged
    triage(pa, "payment checkout down corrtest")
    check("stored corrections: result panel has no injected markup", scan(pa) == [], scan(pa))

    # ------------------------------------------------------------------ workspace, user and teammate names
    ctxB, pb = new_page(browser, "Hostile org")
    signup(pb, '<pwn-el data-pwn="org-name">', "\"><img src=x onerror=__pwned.push('user-name')>", f"bo{RUN}@evil.test")
    check("names: top bar has no injected markup", scan(pb) == [], scan(pb))
    rb = ctxB.request.post(BASE + "api/team", data={"name": '"><pwn-el data-pwn="mate"><b data-pwn="mate">', "email": f"mate{RUN}@evil.test",
                                                    "password": "temporary-pass-1", "role": "agent"})
    assert rb.ok, rb.text()
    triage(pb, "Nobody can log in since this morning")
    pb.click("#add")
    pb.wait_for_selector("#qb tr td.t")
    pb.click("#audet summary")
    pb.click("#tdbar >> text=Team")
    pb.wait_for_selector("dialog.td table")
    check("names: team dialog, owner menu and audit log have no injected markup", scan(pb) == [], scan(pb))

    browser.close()

print()
print("uncaught page errors:", json.dumps(PAGE_ERRORS, indent=1) if PAGE_ERRORS else "none")
check("no uncaught page errors while rendering hostile data", not PAGE_ERRORS, PAGE_ERRORS[:5])
print()
print(f"{len(FAILS)} check(s) failed" if FAILS else "all checks passed")
sys.exit(1 if FAILS else 0)
