# tools/ — Build-time dataset generator

This directory contains **development-only** tooling that precomputes the brand
reference dataset. It is run once offline and its output — brand hashes, domain
allowlists, colour palettes, keywords — is bundled into the extension under
`src/assets/brands/` (`brands.json`).

The tooling is **not shipped** with the extension and has no runtime dependency.
At runtime the extension only reads `brands.json`.

---

## Setup (one-time)

Prerequisites: **Python 3** and **Node >= 22.6** (`scripts/hash-png.ts` relies on
`node --experimental-strip-types`).

Playwright is installed in the repo's **virtualenv** (`tools/.venv`) because the
system Python is PEP-668 "externally managed" and refuses `pip install` outside
a venv. Always run the tool through the wrapper so the venv Python is used:

```bash
# 1. Create the venv + install Playwright (once)
python3 -m venv tools/.venv
tools/.venv/bin/pip install -r tools/requirements.txt

# 2. Download the headless Chromium build (once)
tools/.venv/bin/python -m playwright install chromium

# 3. Run the generator via the wrapper (always use this, never bare `python3 tools/generate.py`)
tools/generate.sh --help
```

The bundled `dummybank` entry came from the local `demo/` page and is **not**
listed in `tools/config.json`, so `tools/generate.sh` won't refresh it. To
recapture it, start the local server and add a `dummybank` entry to the config:

```bash
cd demo && python3 -m http.server 8000 --bind 127.0.0.1
```

---

## How a run works

For every brand, at every viewport, `generate.py`:

1. **Captures** the page with headless Chromium (Playwright) as a viewport-only
   PNG (`tools/captures/<id>@<WxH>.png`) — the same capture semantics as
   `tabs.captureVisibleTab`.
2. **Waits for the page to actually be there** (a `settle()` step): bounded
   network-idle, retries through Cloudflare-style bot-checks (reload with
   backoff), an optional per-brand `waitForSelector`, and a DOM-stability poll
   (innerText length stable for 3 consecutive reads). The report line prints
   `title` / `textLen` / `retries` so a bad capture (challenge screen, spinner,
   blank) is obvious without opening the PNG.
3. **Computes the perceptual hash** by shelling out to
   `node --experimental-strip-types scripts/hash-png.ts captures/<id>@<WxH>.png`.
   The hash therefore comes from the *exact same* implementation the extension
   uses at runtime (`src/utils/phash.ts`), so the `<= phashThreshold` comparison
   transfers bit-for-bit. No separate Python hashing library is involved. The
   primary-viewport hash is stored as `phash`; every viewport is stored in
   `phashByViewport` so Layer 1 can match the closest window size.
4. **Extracts colours, keywords, and title** via one `page.evaluate()` on the
   live page: computed background colours of `body`/`header`/`nav`/`main` and
   logo-ish elements, top-frequency words from visible text, and the page title.
5. **Writes** `src/assets/brands/brands.json`, **merging per brand `id`** —
   existing entries are preserved, only the captured brands are updated.

`logoTemplate` is left empty for now — logo template extraction (Layer 3) is
deferred until the logo-matching pipeline exists.

---

## config.json

```jsonc
{
  "viewports": [
    { "width": 1280, "height": 800 },   // first entry = primary viewport
    { "width": 1366, "height": 768 },
    { "width": 1440, "height": 900 },
    { "width": 1536, "height": 864 },
    { "width": 1600, "height": 900 },
    { "width": 1920, "height": 1080 }
  ],
  "brands": [
    {
      "id": "idfcfirstbank",
      "name": "IDFC First Bank",
      "url": "https://www.idfcfirst.bank.in/",
      "allowedDomains": ["idfcfirst.bank.in"]
    }
  ]
}
```

### Per-brand fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique lowercase slug, no spaces. Used for capture filenames, the `brands.json` key, and `protectedBrands`. |
| `name` | no | Human-readable brand name (falls back to the page `<title>`). |
| `url` | yes | Page to capture. Prefer the **login page** over the homepage — the hash is a reference for whatever page you point here. |
| `allowedDomains` | yes | Manual allowlist. At runtime a hostname is official if it **equals** or is a **subdomain** of any entry — so `"vit.ac.in"` covers `vtopcc.vit.ac.in`. Use the registrable domain. |
| `waitForSelector` | no | Wait for this CSS selector (e.g. the login form) before capturing; capture anyway with a warning if it never appears. |
| `networkIdleMs` | no | Network-idle wait budget (default 8000; set `0` to disable). |
| `settleMs` | no | DOM-stability poll budget (default 2500). |
| `stabilitySamples` | no | Consecutive stable reads before the page counts as settled (default 3). |
| `maxRetries` | no | Bot-check reload retries (default 2). |
| `retryBackoffMs` | no | Base backoff between retries, scaled per attempt (default 2000). |
| `waitSelectorMs` | no | Timeout for `waitForSelector` (default 10000). |
| `phashThreshold` | no | Hamming-distance threshold for a Layer-1 match (default 7). Recapturing a brand overwrites its stored threshold with this default, so set it per brand to keep a custom value. |

---

## Workflows

### A. Full / first-time dataset build

```bash
tools/generate.sh
```

Captures **every** brand at **every** viewport and writes `brands.json`. Per
brand you'll see lines like:

```
[generate] github: capturing https://github.com/login
[generate]   1280x800 title='Sign in to GitHub · GitHub' textLen=282 retries=0
[generate]   phash=b333c98e6666cc98 viewports=['1280x800', '1366x768', '1440x900', '1536x864', '1600x900', '1920x1080'] colors=['#ffffff']
```

Sanity-check each brand: the title should be the real page title, `textLen`
non-trivial, `retries` 0 (or low). Open the PNG if anything looks off.

### B. Add a new brand

1. Add an entry to `config.json` (see the field table above).
2. Capture **only** that brand:

   ```bash
   tools/generate.sh --only idfcfirstbank
   ```

   `--only` accepts multiple ids: `tools/generate.sh --only idfcfirstbank anotherid`.
   Only the listed brands are captured; all other entries in `brands.json` are
   untouched.
3. Verify: a new `idfcfirstbank@<WxH>.png` under `tools/captures/`, and the new
   entry in `src/assets/brands/brands.json`.

> The id **must** exist in `config.json` — the tool iterates that list.

### C. Re-capture a single brand

The same command as B overwrites just that brand's captures and entry across
all viewports:

```bash
tools/generate.sh --only shopify
```

### D. Manual screenshot fallback (`--rehash`)

Use this when headless capture can't get a good page — a site that stays behind
a bot-check (e.g. Dropbox), or a capture that came out wrong:

1. Open the site in a **real browser** at roughly one of the reference viewports
   (1280x800 / 1366x768 / 1440x900 / 1536x864 / 1600x900 / 1920x1080).
2. Screenshot the visible page (DevTools → Cmd/Ctrl+Shift+P → *Capture
   screenshot*).
3. Re-hash that image **without launching a browser**:

   ```bash
   # From an explicit image file
   tools/generate.sh --rehash shopify --image ~/Downloads/shopify-good.png

   # Or: overwrite the primary-viewport capture first, then re-hash it
   tools/generate.sh --rehash shopify            # uses tools/captures/shopify@1280x800.png
   ```

   It recomputes the pHash with the same `scripts/hash-png.ts` code path and
   updates `brands.json`, printing `old -> new`. If the id isn't in
   `brands.json` yet it adds a minimal entry (name from `config.json` or the
   filename; `allowedDomains` from `config.json` or `[]`) — so a brand can be
   added purely from a manual screenshot.

> **Important caveat:** `--rehash` updates only the top-level `phash`;
> `phashByViewport` is left untouched and still participates in runtime
> matching. If the old viewport hashes came from a bot-check screen, they remain
> live until you regenerate them. After a manual rehash, run
> `tools/generate.sh --only <id>` to re-capture all viewports cleanly.

---

## Verifying

- **Capture quality**: check the report line, then open
  `tools/captures/<id>@<WxH>.png` and confirm it's the real page (not a
  challenge screen, spinner, or blank).
- **Hash parity**: stored hashes must equal a fresh run of the same code path:

  ```bash
  for f in tools/captures/*.png; do
    echo "$f: $(node --experimental-strip-types scripts/hash-png.ts "$f")"
  done
  ```

  Compare against the `phash` / `phashByViewport` values in
  `src/assets/brands/brands.json`.
- **Extension smoke test**: `pnpm dev`, resize the browser window to a reference
  viewport (e.g. 1280x800), and navigate to a *clone* of a captured brand (or
  `http://127.0.0.1:8000/` for the dummybank clone) — a red warning should
  appear and log to the service-worker console. A real brand domain should not
  be flagged.
- **Checks**: `pnpm compile`, `pnpm test:phash`, `pnpm test:visits`, and
  `pnpm test:blur-holes`. The warning layer's browser harness is
  `scripts/test-highlights.py` (see its docstring).

---

## Notes / caveats

- **Viewport dependence**: `phash` is layout-dependent (see the Layer 1 note in
  `docs/architecture.md`). References are captured at 1280x800 / 1366x768 /
  1440x900 / 1536x864 / 1600x900 / 1920x1080 and Layer 1 compares against the
  closest one, so matches are reliable when the browsing window is near one of
  those sizes.
- **Screenshots are gitignored** (`tools/captures/*`) — they're real third-party
  pages and shouldn't be committed.
- **Colours can be empty** for some pages (transparent/very minimal styling) —
  harmless. Runtime DOES use colours for the `color_scheme` signal, so an empty
  palette only means that signal is simply absent for that brand.
- **Bot-protected sites** may stay behind a challenge or show their own
  anti-bot messaging that trips the detector (Dropbox did). If a capture looks
  wrong, use the `--rehash` workflow.
- **Chromium-only runtime**: Layer 1 (and therefore detection) is skipped in
  Firefox (no `offscreen` API); the dataset tooling targets Chromium captures.
- **Network access is required** for non-local brands; per-brand failures are
  logged and skipped without aborting the run.