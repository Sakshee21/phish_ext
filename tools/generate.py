#!/usr/bin/env python3
"""Build-time brand dataset generator.

Dev-only. Captures each brand's login page with headless Chromium (Playwright)
at every viewport in config.json's `viewports` list, computes the perceptual
hash using the *exact* runtime implementation (shells out to
scripts/hash-png.ts), extracts DOM colours / keywords / title, and upserts the
results into src/assets/brands/brands.json.

Two workflows:

1. Capture (default): visit each brand URL and screenshot the settled page.
   A `settle()` step waits for network-idle, retries through Cloudflare-style
   bot-checks, optionally waits for a per-brand selector, and polls until the
   DOM stops changing — so the capture isn't a loader/challenge interstitial.

2. Rehash: `--rehash <id> [--image <png>]` recomputes the pHash of an
   existing PNG (default the primary-viewport capture) and updates brands.json.
   Escape hatch for sites whose challenge can't be passed headless: screenshot
   the page in a real browser, drop it over the capture, rehash.

Captures are taken at every viewport in config.json's `viewports` list, saved
as tools/captures/<id>@<WxH>.png, and stored in brands.json under
`phashByViewport` (keyed "WxH") with `phash` set from the primary viewport.

Usage:
    pip install -r tools/requirements.txt
    python3 -m playwright install chromium
    python3 tools/generate.py                  # capture all brands
    python3 tools/generate.py --only vtop      # capture just vtop
    python3 tools/generate.py --rehash shopify            # rehash a capture
    python3 tools/generate.py --rehash shopify --image ~/Downloads/good.png
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
HASH_SCRIPT = ROOT_DIR / "scripts" / "hash-png.ts"
BRANDS_FILE = ROOT_DIR / "src" / "assets" / "brands" / "brands.json"
CAPTURES_DIR = TOOLS_DIR / "captures"

PHASH_THRESHOLD = 5

# Reference thumbnail: a small picture of the *real* brand page, bundled so the
# warning can show it beside the suspicious page. Detection makes no network
# calls, so the only way to show a user what the genuine site looks like is to
# ship it. device_scale_factor shrinks the pixels while leaving the CSS
# viewport (and therefore the desktop layout) untouched -- ~23 KB per brand.
THUMBNAIL_SCALE = 0.4
THUMBNAIL_QUALITY = 60

# A real desktop UA + de-automation flag: headless Chrome with the default UA
# is far more likely to be flagged by Cloudflare/bot-checks in the first place.
DESKTOP_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)


def compute_phash(png_path: Path) -> str:
    """Return the 16-char hex pHash via the extension's own TS implementation."""
    proc = subprocess.run(
        ["node", "--experimental-strip-types", str(HASH_SCRIPT), str(png_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    phash = proc.stdout.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{16}", phash):
        raise RuntimeError(f"Unexpected pHash output: {phash!r}")
    return phash


CHALLENGE_DETECT_JS = r"""
() => {
  const bodyText = (document.body && document.body.innerText || '').slice(0, 2000);
  const lower = (bodyText + ' ' + (document.title || '')).toLowerCase();
  const hasElement =
    !!document.querySelector(
      '#challenge-form, .cf-browser-verification, .cf-challenge, [id*="challenge"], [class*="challenge"]'
    );
  const patterns = [
    'just a moment',
    'checking your browser before accessing',
    'verify you are human',
    'verifying you are human',
    'attention required!',
    'enable javascript and cookies to continue',
    'please turn javascript on and reload the page',
  ];
  return hasElement || patterns.some((p) => lower.includes(p));
}
"""


def is_challenge_page(page) -> bool:
    """True if the page currently shows a Cloudflare-style bot-check."""
    try:
        return bool(page.evaluate(CHALLENGE_DETECT_JS))
    except Exception:  # noqa: BLE001 - evaluate may race navigation
        return False


def settle(page, opts: dict) -> dict:
    """Wait until the page is in a capturable state.

    Order: bounded network-idle → bot-check retry loop → optional selector →
    DOM-stability poll. Returns a small report for the console.
    """
    report = {"retries": 0}

    network_idle_ms = opts.get("networkIdleMs", 8000)
    if network_idle_ms:
        try:
            page.wait_for_load_state("networkidle", timeout=network_idle_ms)
        except Exception:  # noqa: BLE001 - pages with persistent connections
            pass  # never block the capture on network-idle

    max_retries = opts.get("maxRetries", 2)
    for attempt in range(max_retries + 1):
        if not is_challenge_page(page):
            break
        if attempt >= max_retries:
            print("[generate]     !! still behind a bot-check after retries — capturing anyway")
            break
        report["retries"] = attempt + 1
        print(f"[generate]     bot-check detected — retrying ({attempt + 1}/{max_retries})")
        page.wait_for_timeout(opts.get("retryBackoffMs", 2000) * (attempt + 1))
        try:
            page.reload(wait_until="load")
            if network_idle_ms:
                page.wait_for_load_state("networkidle", timeout=network_idle_ms)
        except Exception:  # noqa: BLE001
            pass

    sel = opts.get("waitForSelector")
    if sel:
        try:
            page.wait_for_selector(sel, timeout=opts.get("waitSelectorMs", 10_000))
        except Exception:  # noqa: BLE001
            print(f"[generate]     !! selector {sel!r} never appeared — capturing anyway")

    # DOM-stability poll: the page is "settled" once innerText length stops
    # changing for `stabilitySamples` consecutive reads and is non-blank.
    settle_ms = opts.get("settleMs", 2500)
    samples = opts.get("stabilitySamples", 3)
    stable = 0
    prev_len = None
    deadline = time.monotonic() + settle_ms / 1000
    while time.monotonic() < deadline:
        cur_len = page.evaluate("() => (document.body && document.body.innerText || '').length")
        if cur_len == prev_len and cur_len > 0:
            stable += 1
            if stable >= samples:
                break
        else:
            stable = 0
        prev_len = cur_len
        page.wait_for_timeout(400)

    report["textLen"] = prev_len or 0
    return report


DOM_EXTRACT_JS = r"""
() => {
  const rgbToHex = (r, g, b) =>
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  const computedBgColor = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const a = m[1].split(',').map((s) => parseFloat(s.trim()));
    if (a.length === 4 && a[3] === 0) return null; // fully transparent
    return rgbToHex(a[0], a[1], a[2]);
  };

  const colors = [];
  const seen = new Set();
  const els = [
    document.body,
    document.querySelector('header'),
    document.querySelector('nav'),
    document.querySelector('main'),
    document.querySelector('[class*="logo"],[id*="logo"],[class*="brand"],[id*="brand"]'),
  ];
  for (const el of els) {
    const c = computedBgColor(el);
    if (c && !seen.has(c)) { seen.add(c); colors.push(c); }
    if (colors.length >= 5) break;
  }

  const stopWords = new Set([
    'the','a','an','and','or','for','to','in','on','of','at','is','are','you','your',
    'we','our','this','that','it','with','by','from','as','please','new','get','use',
    'using','more','all','menu','search','login','log','in','out','sign','up','not',
    'if','have','has','had','been','will','can','may','www','http','https','com',
  ]);
  const title = (document.title || '').toLowerCase();
  const body = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, 1500);
  const freq = {};
  for (const w of (body + ' ' + title).match(/[a-z]{3,}/g) || []) {
    if (stopWords.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);

  return { colors, keywords, title: document.title, hostname: window.location.hostname,
           fontFamily: getComputedStyle(document.body).fontFamily };
}
"""


def capture_thumbnail(browser, url: str, viewport: dict, brand: dict) -> str:
    """Small JPEG of the real brand page, as a data URL. "" on failure."""
    try:
        page = browser.new_page(
            viewport=viewport,
            device_scale_factor=THUMBNAIL_SCALE,
            user_agent=DESKTOP_UA,
        )
        page.goto(url, wait_until="load", timeout=30_000)
        settle(page, brand)
        raw = page.screenshot(type="jpeg", quality=THUMBNAIL_QUALITY, full_page=False)
        page.close()
        return "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    except Exception as err:  # noqa: BLE001 - a missing thumbnail must not fail the brand
        print(f"[generate]   !! thumbnail failed: {err}", file=sys.stderr)
        return ""


def extract_dom(page) -> dict:
    """Colors / keywords / title from the live page."""
    return page.evaluate(DOM_EXTRACT_JS)


def load_brands() -> dict:
    if not BRANDS_FILE.exists():
        return {}
    try:
        entries = json.loads(BRANDS_FILE.read_text())
    except (json.JSONDecodeError, TypeError):
        return {}
    return {b.get("id"): b for b in entries if isinstance(b, dict)}


def write_brands(merged: dict, brand_by_id: dict, prefix: str = "[generate]") -> None:
    """Write brands.json, keeping config order first then any leftovers."""
    ordered = [bid for bid in brand_by_id if bid in merged]
    for bid in merged:
        if bid not in ordered:
            ordered.append(bid)
    output = [merged[bid] for bid in ordered]
    BRANDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    BRANDS_FILE.write_text(json.dumps(output, indent=2) + "\n")
    print(f"{prefix} Wrote {len(output)} brand(s) to {BRANDS_FILE.relative_to(ROOT_DIR)}")


def viewport_key(viewport: dict) -> str:
    return f"{viewport['width']}x{viewport['height']}"


def default_capture_path(brand_id: str, config: dict) -> Path:
    """The capture file for the primary (first) viewport."""
    viewports = config.get("viewports") or [config.get("viewport") or {"width": 1280, "height": 800}]
    return CAPTURES_DIR / f"{brand_id}@{viewport_key(viewports[0])}.png"


def cmd_rehash(brand_id: str, image: str | None, brand_by_id: dict, config: dict) -> int:
    """Recompute the pHash of an existing image and update brands.json."""
    if image:
        image_path = Path(image)
    else:
        image_path = default_capture_path(brand_id, config)
        if not image_path.exists():
            legacy = CAPTURES_DIR / f"{brand_id}.png"
            if legacy.exists():
                image_path = legacy
    if not image_path.exists():
        print(f"[rehash] !! no image at {image_path}", file=sys.stderr)
        return 1

    new_hash = compute_phash(image_path)
    merged = load_brands()

    if brand_id in merged:
        old = merged[brand_id].get("phash")
        merged[brand_id]["phash"] = new_hash
        print(f"[rehash] {brand_id}: {old} -> {new_hash} (from {image_path})")
    else:
        cfg = brand_by_id.get(brand_id, {})
        merged[brand_id] = {
            "id": brand_id,
            "name": cfg.get("name") or image_path.stem,
            "phash": new_hash,
            "phashThreshold": cfg.get("phashThreshold", PHASH_THRESHOLD),
            "allowedDomains": cfg.get("allowedDomains", []),
            "protectedBrands": [brand_id],
            "colors": [],
            "keywords": [],
            "logoTemplate": "",
        }
        print(f"[rehash] {brand_id}: added new entry with phash {new_hash} (from {image_path})")

    write_brands(merged, brand_by_id, prefix="[rehash]")
    return 0


def cmd_capture(config: dict, only: set[str] | None) -> int:
    viewports = config["viewports"]
    CAPTURES_DIR.mkdir(exist_ok=True)

    from playwright.sync_api import sync_playwright

    merged = load_brands()
    captured = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        for brand in config["brands"]:
            brand_id = brand["id"]
            if only and brand_id not in only:
                continue

            url = brand["url"]
            print(f"[generate] {brand_id}: capturing {url}")
            hashes: dict[str, str] = {}
            dom = None
            for vp in viewports:
                key = viewport_key(vp)
                try:
                    page = browser.new_page(
                        viewport=vp,
                        device_scale_factor=1,
                        user_agent=DESKTOP_UA,
                    )
                    page.goto(url, wait_until="load", timeout=30_000)
                    report = settle(page, brand)
                    png_path = CAPTURES_DIR / f"{brand_id}@{key}.png"
                    page.screenshot(path=png_path, full_page=False)
                    if dom is None:
                        dom = extract_dom(page)
                        print(
                            f"[generate]   {key} title={dom['title']!r} "
                            f"textLen={report['textLen']} retries={report['retries']}"
                        )
                    page.close()
                except Exception as err:  # noqa: BLE001 - one bad viewport shouldn't kill the brand
                    print(f"[generate]   !! {key} failed for {brand_id}: {err}", file=sys.stderr)
                    continue
                hashes[key] = compute_phash(png_path)

            if not hashes or dom is None:
                print(f"[generate]   !! no viewport captured for {brand_id}", file=sys.stderr)
                continue

            keys_ordered = [viewport_key(v) for v in viewports]
            primary_key = next((k for k in keys_ordered if k in hashes), next(iter(hashes)))
            phash = hashes[primary_key]
            primary_vp = next(v for v in viewports if viewport_key(v) == primary_key)
            thumbnail = capture_thumbnail(browser, url, primary_vp, brand)
            merged[brand_id] = {
                "id": brand_id,
                "name": brand.get("name") or dom.get("title") or brand_id,
                "phash": phash,
                "phashByViewport": {k: hashes[k] for k in keys_ordered if k in hashes},
                "phashThreshold": brand.get("phashThreshold", PHASH_THRESHOLD),
                "allowedDomains": brand["allowedDomains"],
                "protectedBrands": [brand_id],
                "colors": dom.get("colors") or [],
                "keywords": dom.get("keywords") or [],
                "logoTemplate": "",
                "referenceThumbnail": thumbnail,
                "fontFamily": dom.get("fontFamily") or "",
            }
            captured.append(brand_id)
            print(f"[generate]   phash={phash} viewports={list(hashes)} colors={merged[brand_id]['colors']}")

        browser.close()

    if not captured:
        print("[generate] Nothing captured — exiting without writing brands.json", file=sys.stderr)
        return 1

    write_brands(merged, {b["id"]: b for b in config["brands"]})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the brand reference dataset.")
    parser.add_argument("--only", nargs="*", help="Restrict capture to specific brand ids.")
    parser.add_argument(
        "--rehash",
        metavar="ID",
        help="Recompute the pHash of an existing image (default the primary-viewport "
        "capture under tools/captures/) and update brands.json. No browser is launched.",
    )
    parser.add_argument("--image", help="Image to rehash from (requires --rehash).")
    args = parser.parse_args()

    config = json.loads((TOOLS_DIR / "config.json").read_text())
    brand_by_id = {b["id"]: b for b in config["brands"]}

    if args.rehash:
        if args.only:
            parser.error("--only cannot be combined with --rehash")
        return cmd_rehash(args.rehash, args.image, brand_by_id, config)

    return cmd_capture(config, set(args.only) if args.only else None)


if __name__ == "__main__":
    sys.exit(main())
