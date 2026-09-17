# phish_ext — Browser extension that detects brand-impersonation phishing pages

A Chromium browser extension (Manifest V3) that detects fake login pages impersonating known brands, explains *why* it thinks a page is fake, and tests different warning designs to see which makes users stop before entering credentials.

Everything runs **inside the browser**. There is no backend server, no remote inference, and no network calls during detection. All reference data is generated once at build time and bundled into the extension.

---

## Problem

Fake login pages that copy the look of real websites (banks, email, social media) trick users into entering their passwords. Two things are usually weak:

1. **Detection** — well-made clones often slip past simple checks.
2. **Warnings** — a generic "this site might be dangerous" banner is easy to ignore.

## What We're Building

A browser extension that:

- Scans the page you're on and checks it against known real websites using a three-layer detection pipeline (below).
- If it looks like a fake, shows a warning that explains *why* — highlighting the specific elements that gave it away.
- Tests **five** warning designs against each other to find which one actually makes people stop and think — including one that *progressively reveals more evidence* the longer the user seems to be ignoring it, adapting in real time to their behavior (see Progressive Reveal below). This is the project's core research contribution, not a side feature.

## Detection Pipeline

The detector combines three independent checks. Each catches cases the others miss, and the combination produces an explainable verdict rather than a bare yes/no.

### Layer 1 — Visual similarity (perceptual hashing)

On page load, capture the visible page and generate a perceptual hash (pHash, DCT-based). Compare against a pre-built reference set of 13 real brand login pages (14 configured in `tools/config.json`). A close hash match means "this looks like Brand X."

- Catches attacker pages copied pixel-for-pixel.
- Fast (<50 ms) and cheap.
- Reference hashes are generated at build time and bundled as static data.

### Layer 2 — Domain legitimacy check

If the visual match says "this looks like Brand X" but the actual domain is not on Brand X's known-domains allowlist, that is the core phishing signal.

- Also runs a homoglyph/lookalike check on the domain itself (Levenshtein distance + character substitution, e.g. `paypa1.com` vs `paypal.com`) to catch typosquatting even when visual similarity is imperfect.

### Layer 3 — Element-level localization

Determine *which* elements triggered the match so the warning can point at them:

- **DOM inspection** — read the actual page: presence and layout of login forms, logo `<img>` source vs. bundled brand logo templates, dominant color scheme, brand keywords in text.
- **Logo template matching** — canvas-based match of detected logo regions against bundled brand logo images.
- DOM inspection beats image-based analysis on screenshots because the actual elements are readable, which is what makes the result precise and explainable.

Pipeline output — not just a yes/no:

```json
{
  "riskScore": 0.0–1.0,
  "matchedBrand": "paypal" | null,
  "flaggedElements": ["logo", "form-field", "domain"],
  "reasoning": "This page's logo and layout match PayPal, but the domain paypa1.com is not an official PayPal domain."
}
```

### Why three layers

- Perceptual hashing alone is fast but coarse (misses partial clones).
- Domain checking alone misses pages hosted on compromised-but-otherwise-legitimate domains.
- Element localization alone is expensive and lacks the brand context of the other two.

Combined, they cover more cases than any single method and give the warning stage concrete evidence to point to.

## Standalone Architecture (No Backend)

The Python tools are **development-only** and never ship with the extension.

### Build time (Python, dev only)

A dataset-generation script (`tools/generate.py`) captures the brand login pages at six viewports
(1280x800 / 1366x768 / 1440x900 / 1536x864 / 1600x900 / 1920x1080) and precomputes:

- pHash of each brand login page, computed via `scripts/hash-png.ts` — the *exact* runtime
  implementation (`src/utils/phash.ts`), so hashes transfer bit-for-bit.
- Logo templates (cropped, downscaled, encoded as base64) — deferred until the Layer 3 logo pipeline.
- Brand color palettes and keywords (extracted from the live DOM).
- Domain allowlists and lookalike/homoglyph rules (manual, in `tools/config.json`).

Output: `assets/brands/brands.json` — 13 brands, bundled into the extension. No runtime
dependency on Python, OpenCV, or any server. See `tools/README.md` for usage.

### Runtime (100% in-extension)

- **Background service worker** — orchestrates the pipeline. On navigation to an `http(s)` page, captures a screenshot via `tabs.captureVisibleTab` and runs the domain check (pure JS).
- **Offscreen document** — canvas-based image processing: resize/grayscale and DCT pHash (logo template matching is a stub). (WXT supports an `offscreen.html` entrypoint.)
- **Content script** — extracts DOM features (login form, logo, colors, keywords), monitors user behavior once a warning is shown, and renders warnings with highlighted elements.
- **Packaged dataset** — `assets/brands/brands.json` loaded by the workers.

### Permissions (Manifest V3)

- `<all_urls>` host permission — required for automatic screenshot capture on any page. Install-time notice explains why a security extension needs it.
- `storage` — for scan history and warning-logging.
- `tabs` — detect tab navigation events and capture screenshots.
- `offscreen` — create offscreen document for canvas-based image processing.
- `webNavigation` — detect page navigation events.

## Warning Layer

Uses the pipeline output (`flaggedElements` + `reasoning`) to render warnings that point at the actual suspicious parts of the page.

### The five warning conditions

Four static formats plus one adaptive format, evaluated against each other:

| # | Condition | Behavior |
|---|---|---|
| 1 | **Banner** | Dismissible strip at the top of the page, non-blocking. |
| 2 | **Modal** | Full-screen interceptor, forces an explicit choice before proceeding. |
| 3 | **Passive Icon** | Small corner badge injected bottom-right; click to expand the reasoning. No interruption to the page. |
| 4 | **Contextual Tooltip** | Warning anchored directly to the password input field. |
| 5 | **Progressive Reveal** | *Adaptive.* Starts with minimal evidence, reveals more of the "why this is fake" reasoning step by step based on measured hesitation; UI container escalates alongside. |

### Progressive Reveal — how it works

This is the condition that differentiates the project from prior explainable-warning work (e.g. PhishXplain), which reveals its full reasoning at once regardless of whether the user is actually paying attention. Progressive Reveal's primary axis is **evidence depth**, not just interruption intensity — it starts with minimal explanation and reveals more of the "why this is fake" reasoning step by step, only escalating further if the user keeps showing signs of ignoring what's already been shown. The UI container (a toolbar badge → per-evidence popovers → a final modal) escalates alongside the evidence as a secondary, coupled effect, but the evidence-depth progression is the core mechanism.

**Signals tracked** (once a page is flagged and the initial minimal signal is showing):
- Dwell time since the warning first appeared.
- Mouse movement toward or away from the credential input field.
- Repeated focus/typing attempts on the password field while a warning is still active.

**Escalation stages** — each stage reveals one additional piece of evidence, paired with a UI container appropriate to that amount of information:

```
Stage 1 — Minimal signal, no evidence yet
  Toolbar badge only. Nothing is injected into the page; the system is
  still "watching" to see if the user notices and backs away on their own.

Stage 1 + k — One reveal stage per piece of evidence
  The k-th flagged element is outlined directly on the page with a one-line
  reason, and every element revealed before it stays outlined, so the picture
  builds up rather than being replaced.
  e.g. first the copied logo, then the unofficial domain, then the reused
  wording, then the matching colour palette.

Final stage — Full evidence, hard stop
  Everything stays outlined and a modal reveals the complete reasoning
  side by side with the real site, forcing an explicit decision.
```

**The ladder length is derived from the verdict, not fixed:**
`finalStage(total) = total + 2` — one watching stage, one reveal stage per
piece of evidence, one confirmation. Six pieces of evidence runs 8 stages;
two runs 4.

This is deliberate. The evidence count varies per page: one clone yields a
copied logo, a lookalike domain, reused wording, a matching palette and a
hotlinked asset; another yields two of those. A fixed four-stage ladder would
have to cram several pieces into one stage or pad out empty ones, and either
wrecks the measurement — the number of stages a participant sees is meant to
record *how much evidence they needed before reacting*, so it has to scale
with how much evidence there is.

A user who notices and backs away at an early stage never sees the fuller evidence or the confirmation — they were never confused enough to need it, and a terminal action halts the machine permanently. A user who keeps heading toward the password field gets progressively more explanation *and* a progressively harder-to-ignore container, in lockstep.

**Implementation:** a dedicated `behavior-monitor.ts` utility (see Project Structure below) owns the hesitation-tracking and the state machine, and calls back with each stage's evidence slice so the caller can render it, parameterized by how much of the `flaggedElements`/`reasoning` payload to reveal at that stage. Progressive Reveal *composes* the on-page evidence spotlight and the final confirmation modal with the detection pipeline's evidence data rather than duplicating either.

**Logging:** shares the common events (`shown` / `dismissed` / `proceeded` / `went-back` / `submitted` plus the `approached` / `focused` / `typed` micro-events), and adds `escalated` carrying the specific stage reached (i.e. how much evidence the user had been shown) at the time of the final action. This is the data point that lets the evaluation study ask not just "did the warning work" but "how much explanation did it actually take before the user reacted."

## Project Structure

```
phish_ext/
  src/
    entrypoints/            # WXT entrypoints
      background.ts         # pipeline orchestrator + domain check (Layer 2)
      content.ts            # DOM extraction + text brand signals (Layer 3) + warning UI dispatch
      offscreen/            # canvas pHash (Layer 1) + logo matching (Layer 3, stub)
      popup/                # status/settings UI + warning-condition selector
      logs/                 # study-log viewer (/logs.html) — history + JSON export
    lib/                    # shared types & interfaces
      types.ts              # data models + message types
      conditions.ts         # warning-condition selection (banner/modal/tooltip/icon/progressive)
    utils/
      phash.ts               # Layer 1 — perceptual hashing (pure TS)
      domain-check.ts        # Layer 2 — homoglyph + allowlist checks
      brands.ts              # reference dataset loader (cached)
      messaging.ts           # shared message types
      condition-assignment.ts # study condition + participant ID (assigned once per install)
      driver-highlight.ts    # Driver.js evidence tour over flagged elements
      interaction-log.ts     # warning interaction logging (storage.local)
      behavior-monitor.ts    # Progressive Reveal — dwell/mouse tracking + escalation state machine
      log-export.ts          # JSON payload builder for the study-log export
      visits.ts              # group events into visits + derive study metrics
    assets/brands/           # bundled reference dataset (generated by tools/)
    components/
      renderers/             # warning renderers: banner, modal, tooltip, icon (Progressive Reveal composes the Driver popover + final modal)
```

## Stretch Goal

CLIP-style embedding comparison (via `onnxruntime-web`, fully local) for recognizing logo/page variants that template matching misses. Deferred because of bundle size (~30–150 MB model) and CPU latency. Layer 3 will expose a clean `logoMatcher` interface so CLIP can be swapped in later without rearchitecting.

## Build Sequence

1. [done] Initialize WXT project (Vanilla TS + pnpm + `src/` layout).
2. [done] Scaffold entrypoints: `background`, `content`, `offscreen`, `popup`.
3. [done] Implement the three-layer detection pipeline in TypeScript
   (pHash, domain check, DOM/text localization).
   - Layer 1 (pHash) — done + validated (`pnpm test:phash`).
   - Layer 2 (domain legitimacy) — done + wired into the pipeline.
   - Layer 3 (DOM localization) — text/DOM signals wired into the verdict;
     canvas logo template matching still pending (`MATCH_LOGOS` stub).
4. [done] Write the build-time dataset generator in `tools/` (Playwright capture
   at six viewports, hashes via the exact runtime `phash.ts`). Dataset currently
   has 13 brands (14 configured).
5. [done] Build the four static warning renderers (banner, modal, tooltip, icon)
   with element highlighting + condition switching (popup selector,
   `storage.local['phish_condition_assignment']`).
6. [done] Build `behavior-monitor.ts` and wire up Progressive Reveal —
   hesitation tracking (dwell timer + cursor proximity to the credential field
   + focus/typing signals) and the toolbar badge → per-evidence Driver popover →
   final modal escalation, composing the renderers from step 5. Logs `escalated`
   events with the stage reached.
7. [done] Add interaction logging across all five conditions (`shown` / `dismissed` /
   `proceeded` / `went-back` / `left-page`, plus escalation stage + auto/manual
   trigger for Progressive Reveal, and `approached` / `focused` / `typed`
   engagement micro-events). `left-page` is recorded on `pagehide`.
8. [done] Build the participant-facing study-log viewer (`/logs.html`, opened from the popup):
   full history grouped by visit with derived metrics (time to react, engagement, stage
   reach, escalation/micro-event counts), a per-install participant ID, and a nested JSON
   export (`utils/log-export.ts`, `utils/visits.ts`) for researchers. Nothing leaves the
   device except via that export.
9. Evaluation study: recruit participants, run the between-subjects comparison
   across all five warning conditions.