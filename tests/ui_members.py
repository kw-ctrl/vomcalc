#!/usr/bin/env python3
"""End-to-end UI test of the live EV member area (headless Chromium via Playwright).

Run with the interpreter that has playwright:  /opt/homebrew/bin/python3 tests/ui_members.py

It drives the REAL deployed site: gate -> code -> course -> lesson -> resources -> partners,
and fails loudly if any step does not render. Screenshots land in /tmp/ev_member_ui/.
"""
import os, sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("MEMBER_URL", "https://www.vomcalc.com/members/")
CODE = os.environ.get("MEMBER_CODE", "ESCAPE-VELOCITY")
SHOTS = "/tmp/ev_member_ui"
os.makedirs(SHOTS, exist_ok=True)

results = []


def step(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"  ok   {name}")
    except Exception as e:
        results.append((name, False, str(e)[:300]))
        print(f"  FAIL {name}\n       {str(e)[:300]}")


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto(BASE, wait_until="domcontentloaded")

    def gate_blocks_anonymous():
        expect(page.locator("#gate")).to_be_visible(timeout=8000)
        expect(page.locator("#content")).to_be_hidden()
        # the pill is uppercased by CSS, so compare case-insensitively
        assert "members only" in page.inner_text("#gate").lower()
    step("anonymous visitor sees the gate, not the courses", gate_blocks_anonymous)

    def bad_code_rejected():
        page.fill("#code", "NOPE")
        page.click("#gatebtn")
        page.wait_for_function("document.querySelector('#gatem').className.includes('err')", timeout=8000)
        assert "not valid" in page.inner_text("#gatem")
        page.screenshot(path=f"{SHOTS}/1-gate-bad-code.png")
    step("a wrong code is refused in the UI", bad_code_rejected)

    def good_code_unlocks():
        page.fill("#code", CODE)
        page.click("#gatebtn")
        page.wait_for_selector("#content:not(.hidden)", timeout=15000)
        page.wait_for_selector(".course-card", timeout=15000)
        cards = page.locator(".course-card")
        assert cards.count() >= 2, f"expected course cards, got {cards.count()}"
        text = page.inner_text("#content")
        assert "Airbnb Playbook" in text and "Tax Playbook" in text, "course titles missing"
        page.screenshot(path=f"{SHOTS}/2-courses-unlocked.png", full_page=True)
    step("the community code unlocks the course catalogue", good_code_unlocks)

    def tax_course_renders():
        page.click("text=Open course → >> nth=1") if page.locator("text=Open course →").count() > 1 \
            else page.goto(BASE.replace("/members/", "/members/course.html?c=tax"))
        page.wait_for_selector(".module", timeout=15000)
        mods = page.locator(".module").count()
        assert mods >= 6, f"only {mods} modules rendered"
        text = page.inner_text("#course").lower()
        assert "section 179" in text, "the Section 179 module is missing from the tax course"
        assert "cost segregation" in text, "cost segregation module missing"
        lessons = page.locator(".lesson").count()
        assert lessons > 40, f"only {lessons} lessons rendered"
        page.screenshot(path=f"{SHOTS}/3-tax-course.png", full_page=False)
        return lessons
    step("the tax course renders modules and lessons", tax_course_renders)

    def lesson_expands_with_source():
        first = page.locator(".lesson").first
        first.locator("button").click()
        page.wait_for_selector(".lesson.open .body", timeout=5000)
        body = page.inner_text(".lesson.open .body").lower()
        assert "the rule" in body, "lesson body has no rule"
        link = page.locator(".lesson.open .src a").first
        href = link.get_attribute("href")
        assert href and ("drive.google.com" in href), f"source link looks wrong: {href}"
        page.screenshot(path=f"{SHOTS}/4-lesson-open.png")
    step("a lesson expands with its rule and a source recording link", lesson_expands_with_source)

    def clips_play_inline():
        """The lesson videos must be OUR clips (blob storage), and they must actually play —
        not just exist. A Drive link would be a regression: Kassidy asked for embedded sections."""
        n = page.evaluate("() => document.querySelectorAll('video.clip').length")
        assert n > 0, "no embedded lesson video on the page at all"
        assert page.locator(".lesson video.clip[src^='https://']").count() == n, \
            "a clip is not served over https"
        drives = page.evaluate(
            "() => [...document.querySelectorAll('video.clip')].filter(v => v.src.includes('drive.google.com')).length")
        assert drives == 0, f"{drives} video element(s) still point at Drive"

        # open the FIRST lesson that actually has a clip, and screenshot it — evidence must show
        # the player, not a lesson that legitimately has none yet
        opened = page.evaluate("""() => {
            const v = document.querySelector('video.clip');
            const lesson = v.closest('.lesson');
            lesson.classList.add('open');
            const btn = lesson.querySelector('button');
            if (btn) btn.setAttribute('aria-expanded', 'true');
            lesson.scrollIntoView({ block: 'center' });
            return lesson.querySelector('h3').innerText;
        }""")
        page.wait_for_timeout(500)

        page.wait_for_function(
            "() => { const v = document.querySelector('video.clip'); return v && (v.readyState >= 1 || v.error); }",
            timeout=25000)
        info = page.evaluate("""() => { const v = document.querySelector('video.clip');
            return { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
                     err: v.error ? v.error.message : null, src: v.currentSrc.slice(0, 90) }; }""")
        assert not info["err"], f"video error: {info['err']}"
        assert info["w"] > 0 and info["h"] > 0, f"no video dimensions: {info}"

        # and it must actually advance (real playback, not a poster)
        page.evaluate("""() => { const v = document.querySelector('video.clip');
            v.muted = true; v.play().catch(() => {}); }""")
        page.wait_for_timeout(3000)
        played = page.evaluate("() => document.querySelector('video.clip').currentTime")
        assert played > 0.2, f"video did not play (currentTime={played})"
        page.screenshot(path=f"{SHOTS}/7-clip-embed.png")
        print(f"       playing inline from {info['src']} — lesson: {opened[:60]}")
    step("lesson video clips are embedded from our host and actually play", clips_play_inline)

    def course_switcher_works():
        page.wait_for_selector("#switcher .card", timeout=8000)
        assert page.locator("#switcher .card").count() >= 2, "switcher cards missing"
        page.click("text=Switch to this course")
        page.wait_for_selector(".module", timeout=15000)
        assert "Airbnb Playbook" in page.inner_text("#head"), "did not switch course"
    step("switching to the other course works", course_switcher_works)

    def resources_page():
        page.goto(BASE.replace("/members/", "/members/resources.html"))
        page.wait_for_selector(".res-item", timeout=15000)
        n = page.locator(".res-item").count()
        assert n >= 20, f"only {n} resources rendered"
        assert page.locator(".res-item a[href^='https://']").count() >= 20
        page.screenshot(path=f"{SHOTS}/5-resources.png", full_page=True)
    step("resources render with real links", resources_page)

    def partners_page():
        page.goto(BASE.replace("/members/", "/members/affiliates.html"))
        page.wait_for_selector(".res-item.vendor", timeout=15000)
        rows = page.locator(".res-item.vendor").count()
        assert rows >= 20, f"only {rows} vendor rows"
        cards = page.locator("#affs .course-card").count()
        assert cards >= 6, f"only {cards} partner programme cards"
        text = page.inner_text("#content")
        for expected in ("Somerled", "Karlton Dennis", "KBKG", "Madison SPECS", "Tarantino CPA",
                         "Cell Brokerage", "Hospitable", "Turno", "PriceLabs"):
            assert expected.lower() in text.lower(), f"partners page is missing {expected}"
        # a credit term must only appear where one is agreed, and it must be visible
        assert page.locator(".benefit").count() >= 2, "no member-credit blocks rendered"
        page.screenshot(path=f"{SHOTS}/6-partners.png", full_page=True)
    step("partner directory and affiliate programmes render", partners_page)

    def signed_in_state_shows():
        who = page.inner_text("#who")
        assert "EV community code" in who or "@" in who, f"header does not show the member: {who!r}"
    step("the header shows who is signed in", signed_in_state_shows)

    def signout_works():
        page.click("#signout")
        page.wait_for_selector("#gate", timeout=15000)
        expect(page.locator("#content")).to_be_hidden()
    step("sign out re-locks the area", signout_works)

    def no_js_errors():
        # A deliberate bad code POST answers 401, which Chromium logs as a console error —
        # that is the gate working, not a bug. Only unexpected errors fail this check.
        real = [e for e in errors
                if "favicon" not in e.lower()
                and "401" not in e
                and "Failed to load resource" not in e]
        assert not real, f"console/page errors: {real[:3]}"
    step("no unexpected JavaScript errors in the flow", no_js_errors)

    browser.close()

ok = sum(1 for _, p_, _ in results if p_)
print(f"\n{ok}/{len(results)} UI checks passed — screenshots in {SHOTS}")
if ok != len(results):
    for n, p_, err in results:
        if not p_:
            print(f"  FAILED: {n} :: {err}")
    sys.exit(1)
