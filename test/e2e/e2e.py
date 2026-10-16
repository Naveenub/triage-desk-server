import json, time, re
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3456/"
RUN = str(int(time.time()))
errors = []

def until(fn, timeout=10, what=""):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return
        except Exception:
            pass
        time.sleep(0.15)
    raise AssertionError("timed out waiting for " + what)

def rows(page):
    return page.locator("#qb tr td.t").count()

def watch(page, tag):
    page.on("pageerror", lambda e: errors.append(f"{tag} pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"{tag} console.{m.type}: {m.text}") if m.type == "error" else None)

def signup(page, org, name, email):
    page.goto(BASE)
    page.wait_for_selector("dialog.td[open]")
    page.click("text=Create a workspace")
    page.fill("#tda-org", org); page.fill("#tda-name", name)
    page.fill("#tda-email", email); page.fill("#tda-pw", "correct-horse-battery")
    page.click("text=Create workspace")
    page.wait_for_selector("#tdbar")

with sync_playwright() as p:
    b = p.chromium.launch()
    # ---- workspace A, first user
    ctxA = b.new_context(); pa = ctxA.new_page(); watch(pa, "A")
    pa.goto(BASE)
    assert pa.is_visible("dialog.td[open]"), "sign-in dialog should show when signed out"
    print("1 sign-in dialog shown when signed out: ok")
    signup(pa, "Acme", "Ada", f"ada{RUN}@acme.test")
    bar = pa.inner_text("#tdbar")
    assert "Acme" in bar and "AI this month" in bar, bar
    print("2 signed in, top bar:", bar.replace("\n", " | "))

    # AI path through the server
    pa.wait_for_selector("#ai:not([hidden])")
    pa.click("#samples button:has-text('Outage')")   # fills text and runs the rules triage
    pa.click("#ai")
    pa.wait_for_selector("#out .badge.P3:has-text('Claude')", timeout=15000)
    summary = pa.inner_text("#out p")
    assert "Mock summary" in summary, summary
    until(lambda: re.search(r"AI this month: [1-9]", pa.inner_text("#tdbar")), 8, "usage meter to move")
    print("3 Analyze with Claude went through /api/analyze, bar now:", pa.inner_text("#tdbar").replace("\n", " | "))

    pa.click("#add"); pa.wait_for_selector("#qb tr td.t")
    assert pa.locator("#qb tr").count() == 1
    until(lambda: "Shared with your team (1" in pa.inner_text("#sync"), 8, "sync label")
    print("4 ticket saved, sync label:", pa.inner_text("#sync"))

    pa.reload(); pa.wait_for_selector("#qb tr td.t", timeout=10000)
    assert pa.locator("#qb tr").count() == 1
    print("5 survives reload (session cookie + server storage): ok")

    # audit log shows who did what
    pa.click("#audet summary")
    pa.wait_for_selector("#audl table")
    assert "sent a ticket to Claude" in pa.inner_text("#audl") and "Ada" in pa.inner_text("#audl") or "You" in pa.inner_text("#audl")
    print("6 audit log populated from the server: ok")

    # ---- workspace B must see nothing
    ctxB = b.new_context(); pb = ctxB.new_page(); watch(pb, "B")
    signup(pb, "Globex", "Bo", f"bo{RUN}@globex.test")
    pb.wait_for_selector("#qb"); time.sleep(1)
    assert "No open tickets" in pb.inner_text("#qb"), pb.inner_text("#qb")
    print("7 other workspace sees an empty queue: ok")

    # ---- teammate in workspace A via the Team dialog, then live sync
    pa.click("#tdbar >> text=Team")
    pa.fill("#tdt-name", "Cy"); pa.fill("#tdt-email", f"cy{RUN}@acme.test"); pa.fill("#tdt-pw", "temporary-pass-1")
    pa.select_option("#tdt-role", "agent")
    pa.click("text=Add teammate"); pa.wait_for_selector(f"dialog.td table >> text=cy{RUN}@acme.test")
    pa.click("dialog.td >> text=Close")
    ctxC = b.new_context(); pc = ctxC.new_page(); watch(pc, "C")
    pc.goto(BASE); pc.wait_for_selector("dialog.td[open]")
    pc.fill("#tda-email", f"cy{RUN}@acme.test"); pc.fill("#tda-pw", "temporary-pass-1"); pc.click("button:has-text('Sign in')")
    pc.wait_for_selector("#qb tr td.t", timeout=10000)
    assert pc.locator("#qb tr").count() == 1
    print("8 teammate signs in and sees the team's ticket: ok")

    pa.fill("#txt", "How do I reset my password? Thanks"); pa.click("#go"); pa.click("#add")
    until(lambda: rows(pc) == 2, 8, "teammate to see 2 tickets")
    print("9 live update reached the teammate without a reload: ok")

    # ---- edit by teammate propagates back
    pc.locator("#qb tr").first.locator("button[data-res]").click()
    until(lambda: rows(pa) == 1, 8, "first user to see 1 open ticket")
    print("10 resolve by teammate propagated to the first user: ok")

    b.close()

print("\nbrowser errors:", json.dumps(errors, indent=1) if errors else "none")
