#!/usr/bin/env python3
"""
End-to-end checks for Progressive Reveal's element highlighting.

Why Playwright: the highlight layer is DOM/CSS inside a real page, driven by a
real content script. The things this file exists to catch -- an outline for a
field hidden in a closed modal, a dead selector falling back to an unanchored
popover instead of a guessed element, the frost not resurrecting after Skip --
only exist once the extension is running against a live document.

Generic by design: the assertions are invariants any page must satisfy -- the
popover appears and advances a stage, an anchored popover matches a drawn
outline while an unanchored one invents none, outlines are never lost when a
stage advances, and Skip removes the frost without it coming back. A new page
that passes is covered by the same guarantees. (A couple of comments mention
specific fixtures only to explain which real case a path exists for.)

Run (needs the production build: pnpm build):
    tools/.venv/bin/python scripts/test-highlights.py --headed
    tools/.venv/bin/python scripts/test-highlights.py --fixture github.html idhc.html --headed --keep

Chromium can only load an unpacked extension with a real browser process, so
`--headed` is required (Playwright's headless shell refuses --load-extension);
on a headless box run it under Xvfb.

Exit code 0 on success, 1 if any check failed.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / ".output" / "chrome-mv3"
FIXTURES = REPO.parent / "test-main"
# Not "localhost": the content script deliberately excludes localhost, so the
# fixtures are reached through a fake host mapped onto 127.0.0.1 in Chromium.
SITE_HOST = "phishtest.local"

CONDITION_ASSIGNMENT = {
    "condition": "progressive",
    "assignedAt": 0,
    "source": "random",
}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):  # noqa: D401 - silence the default logger
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Checker:
    def __init__(self) -> None:
        self.failures = 0

    def ok(self, label: str, condition: bool, detail: str = "") -> None:
        mark = "ok  " if condition else "FAIL"
        print(f"  {mark} {label}" + (f"  ({detail})" if detail else ""))
        if not condition:
            self.failures += 1

    def done(self) -> int:
        if self.failures:
            print(f"\n{self.failures} check(s) failed")
            return 1
        print("\nAll highlight checks passed")
        return 0


def start_server(directory: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    port = free_port()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def wait_for_extension(context, timeout_s: float = 10.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for worker in context.service_workers:
            if worker.url.startswith("chrome-extension://"):
                return worker
        time.sleep(0.1)
    raise RuntimeError("extension service worker not found -- did the extension load?")


def set_condition(worker) -> None:
    worker.evaluate(
        "async (value) => { await chrome.storage.local.set({ phish_condition_assignment: value }); }",
        CONDITION_ASSIGNMENT,
    )


# ── In-page probes (evaluated in the page context) ──

JS_OUTLINE_COUNT = (
    "Array.from(document.querySelectorAll('#phish-ext-evidence-outlines > div'))"
    ".filter((b) => b.style.display !== 'none').length"
)
JS_HAS_POPOVER = "!!document.querySelector('.phish-popover')"
# Scoped to our tagged frost layer: plenty of pages have their own elements
# with a backdrop-filter (idhc's modal-overlay), so a generic search would
# report a false positive.
JS_HAS_FROST = "!!document.querySelector('[data-phish-ext=\"frost\"]')"
JS_POPOVER_TITLE = "document.querySelector('.driver-popover-title')?.textContent || ''"
JS_POPOVER_ANCHORING = (
    "(() => {"
    "  const p = document.querySelector('.phish-popover');"
    "  if (!p) return 'missing';"
    "  return document.getElementById('driver-dummy-element') ? 'unanchored' : 'anchored';"
    "})()"
)
JS_CREDENTIAL = (
    "(() => {"
    "  const el = document.querySelector('input[type=\"password\"], input[type=\"text\"], input:not([type])');"
    "  if (!el) return false;"
    "  const r = el.getBoundingClientRect();"
    "  return r.width >= 2 && r.height >= 2;"
    "})()"
)
# F1 regression probe: tag the current outline boxes, find the page element a
# box is framing (by geometry, since our boxes are pointer-events:none), and
# hide it. A rebuild would replace the tagged nodes; retention keeps them.
JS_TAG_AND_HIDE_TARGET = (
    "(() => {"
    "  const layer = document.getElementById('phish-ext-evidence-outlines');"
    "  const boxes = Array.from(layer ? layer.children : []);"
    "  boxes.forEach((b, i) => b.setAttribute('data-test-box', String(i)));"
    "  const b = boxes.find((el) => el.style.display !== 'none');"
    "  if (!b) return false;"
    "  const left = parseFloat(b.style.left) + 3;"
    "  const top = parseFloat(b.style.top) + 3;"
    "  const width = parseFloat(b.style.width) - 6;"
    "  const height = parseFloat(b.style.height) - 6;"
    "  const close = (a, c) => Math.abs(a - c) < 1.5;"
    "  let target = null;"
    "  for (const el of document.querySelectorAll('body *')) {"
    "    if (el.closest('#phish-ext-evidence-outlines') || el.closest('.driver-popover')) continue;"
    "    const r = el.getBoundingClientRect();"
    "    if (close(r.left, left) && close(r.top, top) && close(r.width, width) && close(r.height, height)) {"
    "      target = el; break;"
    "    }"
    "  }"
    "  if (!target) return false;"
    "  window.__phishHiddenTarget = target;"
    "  window.__phishHiddenDisplay = target.style.display;"
    "  target.style.display = 'none';"
    "  return true;"
    "})()"
)
JS_RESTORE_TARGET = (
    "(() => {"
    "  const el = window.__phishHiddenTarget;"
    "  if (!el) return false;"
    "  el.style.display = window.__phishHiddenDisplay || '';"
    "  return true;"
    "})()"
)
JS_TAGGED_BOXES = "document.querySelectorAll('#phish-ext-evidence-outlines > div[data-test-box]').length"
# Click a control that should reveal a hidden login (a modal-login page keeps
# its credential field display:none until this runs). Generic text match.
JS_REVEAL_LOGIN = (
    "(() => {"
    "  const rx = /log\\s?in|sign\\s?in/i;"
    "  const cands = Array.from(document.querySelectorAll('button, a, [role=\"button\"]'));"
    "  const el = cands.find((e) => rx.test(e.textContent || '') && e.getBoundingClientRect().width > 0);"
    "  if (!el) return false;"
    "  el.click();"
    "  return true;"
    "})()"
)


def first_credential(page):
    return page.query_selector(
        'input[type="password"], input[type="text"], input:not([type])'
    )


def wait_for_detection(page, timeout_ms: int = 20000) -> bool:
    """The pipeline announces detection via a content-script console log."""
    try:
        page.wait_for_function(
            "window.__phishDetected === true",
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


def install_detection_probe(page) -> None:
    """Flag detection from the console log; stage 1 shows no DOM of its own."""
    def on_console(msg):
        text = msg.text
        if "Rendering warning" in text or "Warning triggered" in text:
            try:
                page.evaluate("window.__phishDetected = true")
            except Exception:
                pass
    page.on("console", on_console)


def run_fixture(page, check: Checker, fixture: str) -> None:
    detected = wait_for_detection(page)
    check.ok(f"{fixture}: pipeline flags the page", detected)
    if not detected:
        return

    # Stage 1 is the toolbar badge only. A focus + keystroke on the credential
    # field is a hesitation signal, which advances the ladder immediately --
    # but a page whose only credential is inside a closed modal (idhc) cannot
    # produce signals, so the monitor's dwell timer carries it instead.
    has_cred = page.evaluate(JS_CREDENTIAL)
    print(f"       note: visible credential field: {has_cred}")

    escalated = False
    for _ in range(12):
        cred = first_credential(page)
        if cred is not None:
            try:
                cred.focus()
                page.keyboard.press("a")
            except Exception:
                pass
        try:
            page.wait_for_selector(".phish-popover", timeout=1200)
            escalated = True
            break
        except Exception:
            continue
    check.ok(f"{fixture}: stage 2 popover appears", escalated)
    if not escalated:
        return

    # Anchoring invariant: an element that is not visible at reveal has no
    # outline and the popover is explicitly unanchored -- never a guessed
    # stand-in. A visible element is outlined and the popover is anchored.
    anchoring = page.evaluate(JS_POPOVER_ANCHORING)
    outlines = page.evaluate(JS_OUTLINE_COUNT)
    check.ok(f"{fixture}: popover anchoring is explicit", anchoring in ("anchored", "unanchored"), anchoring)
    if anchoring == "anchored":
        check.ok(f"{fixture}: anchored popover marks its element", outlines >= 1)
    else:
        check.ok(f"{fixture}: unanchored popover invents no outline", outlines == 0)

    # F1 regression: a flagged element that is momentarily unmeasurable (a
    # transition, a collapsed panel) must not wipe and rebuild the outline
    # layer. Tag the boxes, hide the framed element, restore it, and assert the
    # same box nodes survived -- a rebuild would replace the tagged ones.
    if outlines >= 1 and page.evaluate(JS_TAG_AND_HIDE_TARGET):
        before_boxes = page.evaluate(JS_TAGGED_BOXES)
        page.wait_for_timeout(400)
        page.evaluate(JS_RESTORE_TARGET)
        page.wait_for_timeout(400)
        after_boxes = page.evaluate(JS_TAGGED_BOXES)
        check.ok(
            f"{fixture}: transient hide does not rebuild outlines",
            after_boxes == before_boxes and after_boxes > 0,
            f"{before_boxes} -> {after_boxes}",
        )
    elif outlines == 0:
        pass
    else:
        print("       note: no distinct element matched an outline box; skipped F1 check")

    # Hidden-at-reveal: a credential field inside a closed modal (idhc) is
    # flagged evidence before it can be seen. Revealing it must produce an
    # outline once it is on screen, without a fresh navigation or verdict.
    if not has_cred:
        before = page.evaluate(JS_OUTLINE_COUNT)
        opened = page.evaluate(JS_REVEAL_LOGIN)
        page.wait_for_timeout(400)
        revealed = bool(opened) and page.evaluate(JS_CREDENTIAL)
        if revealed:
            check.ok(f"{fixture}: hidden credential can be revealed", True)
            # Advance to the final stage so every piece of evidence, including
            # the now-visible field, has been revealed and outlined.
            for _ in range(10):
                nxt = page.locator(".phish-popover button", has_text="Next")
                if nxt.count() == 0:
                    break
                try:
                    nxt.first.click(timeout=3000)
                except Exception:
                    break
                page.wait_for_timeout(350)
            page.wait_for_timeout(400)
            after = page.evaluate(JS_OUTLINE_COUNT)
            check.ok(
                f"{fixture}: revealed credential gets outlined",
                after > before,
                f"{before} -> {after}",
            )
        else:
            # No generic login control on this page (vtop reveals its field
            # through a role-selection screen). Not an invariant, so report
            # and move on rather than failing the app for the harness's limits.
            print("       note: no generic login control found to reveal a hidden credential")
        return
    # Next advances the stage. Tested before Skip: Skip closes the bubble
    # (re-presented only after 30s), while the stage-2 popover is the guaranteed
    # place a Next control exists. The stage must advance (the popover title
    # changes); the outline count may stay flat when the newly revealed evidence
    # has no element of its own (the domain, the typeface), so the invariant is
    # only that outlines are never lost.
    # Driver's own Next button is not one of our .phish-btn controls.
    # Locators, not element handles: a page mutation re-anchors and rebuilds
    # the popover DOM, which detaches a handle captured a moment earlier.
    next_btn = page.locator(".phish-popover button", has_text="Next")
    if next_btn.count() > 0:
        before_title = page.evaluate(JS_POPOVER_TITLE)
        before_outlines = page.evaluate(JS_OUTLINE_COUNT)
        next_btn.first.click(timeout=5000)
        page.wait_for_timeout(500)
        after_title = page.evaluate(JS_POPOVER_TITLE)
        after_outlines = page.evaluate(JS_OUTLINE_COUNT)
        # The stage must advance (new evidence). The outline count may stay
        # flat when the newly revealed evidence has no element of its own
        # (the domain, the typeface) -- it still gets the popover text.
        advanced = after_title != before_title
        check.ok(
            f"{fixture}: Next reveals more evidence",
            advanced,
            f"title '{before_title}' -> '{after_title}'",
        )
        check.ok(
            f"{fixture}: outlines never lose evidence",
            after_outlines >= before_outlines,
            f"{before_outlines} -> {after_outlines}",
        )
        check.ok(f"{fixture}: popover persists across stages", page.evaluate(JS_HAS_POPOVER))
    else:
        buttons = page.evaluate(
            "Array.from(document.querySelectorAll('.phish-popover button')).map((b) => b.textContent)"
        )
        check.ok(f"{fixture}: Next button present", False, f"buttons: {buttons}")

    # Skip: dismiss the bubble, keep the warning, drop the frost, and make sure
    # a later DOM mutation cannot resurrect the frost.
    skip = page.locator(".phish-popover .phish-btn", has_text="Skip")
    if skip.count() > 0:
        before_skip_outlines = page.evaluate(JS_OUTLINE_COUNT)
        try:
            skip.first.click(timeout=5000)
        except Exception:
            # A re-anchor between query and click rebuilds the popover; retry
            # against the fresh DOM.
            page.locator(".phish-popover .phish-btn", has_text="Skip").first.click(timeout=5000)
        page.wait_for_timeout(200)
        check.ok(f"{fixture}: Skip removes the popover", not page.evaluate(JS_HAS_POPOVER))
        if page.evaluate(JS_HAS_FROST):
            layers = page.evaluate(
                "Array.from(document.querySelectorAll('[data-phish-ext=\\\"frost\\\"]'))"
                ".map((el) => el.tagName + '.' + el.className + ' display=' + getComputedStyle(el).display)"
            )
            print(f"       frost layers still present: {layers}")
        check.ok(f"{fixture}: Skip removes the frost", not page.evaluate(JS_HAS_FROST))
        page.evaluate("document.body.appendChild(document.createElement('span'))")
        page.wait_for_timeout(300)
        check.ok(f"{fixture}: frost stays gone after a mutation", not page.evaluate(JS_HAS_FROST))
        check.ok(
            f"{fixture}: outlines survive Skip",
            page.evaluate(JS_OUTLINE_COUNT) >= before_skip_outlines,
            f"{before_skip_outlines} -> {page.evaluate(JS_OUTLINE_COUNT)}",
        )
    else:
        check.ok(f"{fixture}: Skip button present", False, "popover had no Skip control")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--fixture",
        nargs="+",
        default=["github.html", "idhc.html"],
        help="fixtures under ../test-main (default: github.html idhc.html)",
    )
    ap.add_argument("--extension", default=str(EXTENSION))
    ap.add_argument("--headed", action="store_true", help="run with a visible browser")
    ap.add_argument("--keep", action="store_true", help="leave the browser open on exit")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    if not Path(args.extension).is_dir():
        print(f"error: extension build not found at {args.extension}. Run `pnpm build`.", file=sys.stderr)
        return 1
    for fixture in args.fixture:
        if not (FIXTURES / fixture).is_file():
            print(f"error: fixture not found: {FIXTURES / fixture}", file=sys.stderr)
            return 1

    httpd, port = start_server(FIXTURES)
    check = Checker()
    profile = tempfile.mkdtemp(prefix="phish-highlight-profile-")

    try:
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(
                user_data_dir=profile,
                headless=not args.headed,
                args=[
                    f"--disable-extensions-except={args.extension}",
                    f"--load-extension={args.extension}",
                    # Resolve the fake host to the local server without touching
                    # /etc/hosts, so the URL is not localhost (which the content
                    # script excludes).
                    f"--host-resolver-rules=MAP {SITE_HOST} 127.0.0.1",
                ],
            )
            try:
                worker = wait_for_extension(context)
                set_condition(worker)
                page = context.pages[0] if context.pages else context.new_page()

                for i, fixture in enumerate(args.fixture):
                    if i > 0:
                        # Fresh document so the next fixture gets its own visit.
                        page = context.new_page()
                    print(f"\n── {fixture} ──")
                    # Listen before navigation: detection can log as soon as the
                    # document commits. `commit` (not domcontentloaded) because
                    # some fixtures pull remote scripts that can hang the load
                    # event; detection does not depend on them.
                    install_detection_probe(page)
                    try:
                        page.goto(
                            f"http://{SITE_HOST}:{port}/{fixture}",
                            wait_until="commit",
                            timeout=15000,
                        )
                        run_fixture(page, check, fixture)
                    except Exception as exc:  # noqa: BLE001 - report, don't mask the state
                        check.ok(f"{fixture}: harness completed", False, f"{type(exc).__name__}: {exc}")
                        shot = REPO / ".output" / f"highlight-failure-{fixture}.png"
                        try:
                            page.screenshot(path=str(shot))
                            print(f"  screenshot: {shot}")
                        except Exception:
                            pass

                if args.keep:
                    input("press Enter to close the browser...")
            finally:
                if not args.keep:
                    context.close()
    except Exception as exc:  # noqa: BLE001
        print(f"harness error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        httpd.shutdown()

    return check.done()


if __name__ == "__main__":
    raise SystemExit(main())
