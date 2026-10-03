# PhishOff

**Explainable, on-device phishing detection with behavior-adaptive warnings.**

PhishOff is a Manifest V3 Chromium extension that detects brand-impersonation
login pages and explains *why* a page is judged fake — pointing at the specific
elements (logo, domain, reused wording, colours, credential form) that gave it
away, instead of returning a bare "unsafe" verdict. Everything runs client-side:
reference brand data is bundled at build time, and there are **no network calls
at detection time, no backend, and no third-party APIs**.

**→ [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/phishoff/ppbnhjdmkkekbinecoifdphgafpplpbk)**

> **Free to install and use** as a real, on-device phishing detector — and also a
> **research project**: beyond detection, PhishOff implements and compares **five
> warning designs** in a between-subjects study, logging interaction metrics
> locally for that research.

---

## What it does

- **Explainable detection** — every flagged page yields a risk score, the
  impersonated brand, and an ordered list of the exact elements responsible,
  each with a plain-language reason.
- **Three-layer, on-device pipeline** — visual, domain, and DOM analysis
  combined into a single verdict (below).
- **Five warning designs, compared** — the research contribution: banner, modal,
  tooltip, passive icon, and **Progressive Reveal**, a novel adaptive warning
  that paces how much evidence it shows to the user's real-time behaviour.
- **Private by design** — page content and screenshots never leave the device
  during detection.

## How detection works

| Layer | Question | Method |
|-------|----------|--------|
| **1 — Visual** | Does the page *look* like a known brand? | DCT perceptual hash (64-bit) of the top 700 CSS-px band; Hamming distance ≤ 7 to a bundled per-viewport reference. |
| **2 — Domain** | Is the host legitimate for that brand? | Allowlist / subdomain match; otherwise homoglyph normalisation and Levenshtein ≤ 2 to flag typosquats and look-alikes. |
| **3 — DOM / text** | Which brand, and what's the evidence? | Credential-gated brand identification from page text, logos, colours and fonts; localises the specific flagged elements for highlighting. |

Layers 1 and 3 run independently and are reconciled before Layer 2 gates the
risk score, so a single capture or viewport failure can't blind the pipeline.
Reference data for **13 brands** is bundled as one `brands.json` (per-viewport
hashes, allowlists, keywords, colours, thumbnails), generated offline by a
Playwright tool — no model download, no runtime fetch.

## The five warning conditions

Each install is randomly assigned **one** condition (persisted, never
re-randomised), so a participant only ever experiences one design. All five
render the *same* evidence and leave the page fully usable — only the
presentation and interruption level differ.

- **Banner** — dismissible red strip at the top of the page.
- **Modal** — full-screen blocking interceptor (deliberately minimal; the
  control condition).
- **Tooltip** — red bubble anchored to the credential field.
- **Passive icon** — corner badge that expands detail on click.
- **Progressive Reveal** — *adaptive.* Escalates evidence depth and interruption
  together, driven by dwell time, cursor proximity to the password field, and
  focus/typing. A briefly-glancing user sees only a minimal cue; a user actively
  attempting to proceed is shown progressively more evidence, up to a full
  evidence-complete modal.

## Install

**Users:** [Chrome Web Store → PhishOff](https://chromewebstore.google.com/detail/phishoff/ppbnhjdmkkekbinecoifdphgafpplpbk).

**From source (development):**

```bash
pnpm install
pnpm dev          # live-reload dev build
# or a production build:
pnpm build        # → .output/chrome-mv3
```

Then open `chrome://extensions`, enable **Developer mode**, and **Load unpacked**
on the output folder. For the pilot/testing build (which exposes a
warning-condition picker) and other workflows, see the
[Development Guide](docs/development.md).

## Privacy

No backend, no third-party APIs, no remote blocklist. Detection reads the page
and a screenshot entirely on-device. The only outbound requests are
**participant-initiated** — a false-positive report or a study-log export,
triggered manually from the popup or logs page. Logs are keyed by a random
per-install identifier; no browsing history, page content, or device fingerprint
is collected.

## Tech stack

Manifest V3 · [WXT](https://wxt.dev) + Vite · TypeScript (strict) · vanilla
HTML/CSS/TS UI (no framework) · pnpm · [driver.js](https://driverjs.com) for
on-page highlighting. Dev-only dataset tooling: Python + Playwright.

## Documentation

- [Architecture & Design Decisions](docs/architecture.md)
- [Development Guide](docs/development.md)
- [Full Project Plan](docs/plan.md)
- [Local Study Clones (hostnames)](SETUP.md)
- [Testing the Warning Layer](docs/testing-warning-layer.md)
- [Testing Layer 1 (phash)](TESTING.md)
- [Dataset Generator Tooling](tools/README.md)

## Contributors

1. Sakshee Ujjwal Kumat
2. Sidpara Parth Kalpeshbhai

---

*Research project — v0.0.5. The brand clones under `test-pages/` are local-only
study stimuli, not live sites. Not affiliated with any brand whose login page it
helps protect. No open-source license is currently attached — please contact the
authors regarding reuse.*
