# Architecture & Design Decisions

## Three-layer pipeline

The detector combines three independent checks. Each catches cases the others miss.

- **Layer 1: Visual similarity** (perceptual hashing in the offscreen document). Captures a screenshot, computes a DCT-based pHash via canvas, compares against pre-built brand reference hashes. Catches pixel-for-pixel clones.

- **Layer 2: Domain legitimacy** (background service worker). If the visual match says "this looks like Brand X" but the domain is not on that brand's allowlist, that is the core phishing signal. Also runs homoglyph/Levenshtein checks to catch typosquatting (e.g. `paypa1.com`).

- **Layer 3: Element localization** (content script + background text identification, **mostly wired**). Reads the actual page DOM for login forms, logo candidates, colors, brand keywords, external-asset hotlinks, and font family; the background identifies the brand from page text and the warning points at the concrete elements that gave it away. The remaining piece — canvas-based logo *template matching* (`MATCH_LOGOS` in the offscreen worker) — is still a stub and does not yet participate in the verdict.

> **Viewport sensitivity note (Layer 1):** Screenshot-based perceptual hashing is
> layout-dependent: resizing the browser window reflows the page and can shift a same-page hash by
> several bits (observed ~8 in testing), well above pure capture noise (0–4). To mitigate this, the
> dataset tooling captures each brand at six viewports (`1280x800`, `1366x768`, `1440x900`,
> `1536x864`, `1600x900`, `1920x1080`) and
> Layer 1 compares the live capture against the *closest* of a brand's reference hashes
> (`BrandReference.phashByViewport`), so matches remain reliable when the browsing window is near one
> of those sizes. Because a clone and the real page shift identically under a resize, this never
> creates false positives — a mismatched window size only lowers Layer 1's recall, which Layers 2 and 3
> compensate for. Per-brand threshold calibration remains a possible future refinement.

### Why three layers

- pHash alone is fast but coarse (misses partial page clones).
- Domain checking alone misses pages on compromised-but-legitimate domains.
- Element localization alone is expensive and lacks brand context.

Combined, they cover more cases than any single method and produce an **explainable** verdict with concrete evidence to point at in the warning UI.

## Communication flow

```
Background SW ----> Offscreen Doc     (COMPUTE_PHASH -> PHASH_RESULT)
Background SW ----> Content Script    (DETECTED)
Background SW ----> Content Script    (GET_FEATURES -> FEATURES_RESULT)
Background SW ----> Content Script    (EXTENSION_DISABLED)
Content Script ---> Background SW     (PAGE_READY, SET_BADGE, GO_BACK, LEFT_PAGE, SUBMITTED)
Popup ------------> Background SW     (RESCAN, GET_ENABLED/SET_ENABLED,
                                       GET_TAB_STATUS, REPORT_FALSE_POSITIVE)
Popup ------------> Logs tab          (browser.tabs.create -> /logs.html)
```

- pHash runs in an **offscreen document** (canvas access). Logo template matching
  (`MATCH_LOGOS`) lives there too but is still a stub — see Layer 3 above.
- Domain checks run in the **background service worker** (pure strings).
- DOM extraction and warning UI run in the **content script** (page access).
- The **logs page** (`/logs.html`, opened from the popup) reads storage directly in
  its own extension context — it needs no messaging.

> `PAGE_READY` is now vestigial: the background *pulls* DOM features on demand via
> `GET_FEATURES` instead of relying on the push, which raced the navigation event.

## Logs & study data (privacy model)

Detection makes **no network calls**: every warning interaction is recorded into
`storage.local` and stays on the device. There are exactly two ways data can
leave, both explicitly triggered by the participant and anonymous:

- The participant-facing **study log** page (`src/entrypoints/logs/`, opened
  from the popup) shows the record. The participant can export a JSON payload
  (`src/utils/log-export.ts`) to hand to a researcher, or press **Send to
  study**, which uploads the current filtered view to the submission site
  (`/api/upload`, origin set in `wxt.config.ts`).
- The popup's **Report false positive** button POSTs the flagged verdict to the
  same site (`/api/report`) for researcher review.

Both uploads carry only study fields (participant ID, assigned condition,
extension version, detection snapshot) — no device or browser fingerprinting.

- Data lives under `storage.local['phish_interactions']` (bounded to the most
  recent 500 events; see `src/utils/interaction-log.ts`). Every event carries a
  **`visitId`** grouping all events of one flagged page-load into a single
  visit (one per warning shown; a rescan starts a new one). Events without a
  `visitId` (old-format data, or stale content scripts that survived a reload)
  are **ignored** by the visitor and the export — they cannot be grouped into a
  meaningful visit (`src/utils/visits.ts`).
- Each event carries a **sanitized detection snapshot** (`result`): the raw
  Layer 1/2/3 signals (screenshot pHash, hamming distance, matched keywords,
  domain hostname + typosquat edit distance), the flagged-element list, the
  reasoning, and the official-vs-actual domain. The base64 reference thumbnail
  and per-element CSS selectors are stripped so events stay ~1 KB. The snapshot
  is stored **once per visit, on the `shown` event** — later `escalated` and
  terminal events omit it to avoid duplicating it per stage. The logs page's
  expandable rows surface all of it; expanding a later event explains that the
  detail lives on the visit's first event.
- **Engagement micro-events** (`approached` / `focused` / `typed` /
  `submitted`), logged for **all five** conditions, record the participant
  heading for the credentials despite the warning: cursor entering the field's
  120 px zone, focusing the password field, the first keystroke of a focus
  session, and actually submitting the form. They carry no detection snapshot
  — they're small by design, and the `escalated` event records whether the
  participant pulled the next stage (`trigger: 'manual'`) or was pushed
  (`'auto'`). A `reported` event records a false-positive report from the popup.
- **Visits** (`src/utils/visits.ts`) group events by `visitId` and derive the
  study metrics: `timeToReactMs` (shown → terminal action), `engagedMs`
  (shown → last event), `timeToFirstSignalMs`, `stagesReached`,
  `escalationCount`, `manualAdvances`, per-signal counts, and `terminalType`.
  A visit's `complete` flag says whether a filtered export included it whole.
- Each install mints a stable **participant ID** (`storage.local['phish_participant']`,
  see `src/utils/condition-assignment.ts`), embedded in every export so a
  researcher can attribute a participant's exports across sessions.
- The study **condition assignment** is stored once per install under
  `phish_condition_assignment` and never re-randomised (see the warning banner in
  `condition-assignment.ts`).
- Exports (`src/utils/log-export.ts`, schema v3) carry only study fields —
  participant ID, assigned condition, extension version, export time, and the
  **visits** (nested events + metrics) — no device or browser fingerprinting.
- `left-page` is sent fire-and-forget to the background on `pagehide`, so a
  participant who reacts by simply navigating away is still counted. Like
  `submitted` and the approach/focus/typing micro-events, it is a non-click
  signal.

## Build-time dataset (Python, dev-only)

`tools/generate.py` generates the brand reference data once, offline. It captures each brand's page
with headless Chromium (Playwright) at six viewports (1280x800, 1366x768, 1440x900, 1536x864,
1600x900, 1920x1080) and precomputes:

- Perceptual hashes of each capture, computed by shelling out to
  `scripts/hash-png.ts` — the *exact same* `src/utils/phash.ts` implementation the extension uses at
  runtime, so hashes transfer bit-for-bit (no separate Python hashing library).
- Brand color palettes and keywords, extracted from the live DOM.
- Domain allowlists (manual, in `tools/config.json`).

`logoTemplate` (cropped/encoded logo images) and logo template matching are deferred until the
Layer 3 logo pipeline exists. See `tools/README.md` for usage.

Output: `assets/brands/brands.json`, bundled as a static file. Python never runs at runtime.

## Key permissions

| Permission | Why |
|-----------|-----|
| `<all_urls>` host permission | `tabs.captureVisibleTab` for automatic screenshot on any page |
| `storage` | Store scan history and warning-interaction analytics |
| `tabs` | Detect tab navigation events |
| `offscreen` | Create offscreen document for canvas-based image processing |
| `webNavigation` | Detect page navigation events to trigger the pipeline |

### Why `<all_urls>` instead of `activeTab`

`activeTab` requires the user to click the extension icon to grant tab access — that means no automatic scanning on page load. A security extension can justify `<all_urls>` in its store listing.

## CLIP (stretch goal)

CLIP (by OpenAI) maps images and text into the same vector space — useful for recognizing logo variants that template matching would miss. Deferred because:

- Requires bundling `onnxruntime-web` + a ~30-150 MB model in the extension.
- CPU inference takes seconds; WebGPU is faster but adds compatibility issues.
- Layer 3 exposes a clean `logoMatcher` interface so CLIP can be swapped in later without rearchitecting.
