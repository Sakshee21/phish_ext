# Testing Guide — phash.ts Validation

> **Testing the warning conditions** (the five delivery formats) is in
> `docs/testing-warning-layer.md`. **Serving the clones under realistic
> hostnames** — so the URL doesn't give the page away and Layer 2 becomes
> testable — is in `SETUP.md`.
>
> ⚠️ **The study clones and their hostnames are local-only.** Pages like
> `paypa1.com` / `idfcfirst-secure.in` (see `SETUP.md`) impersonate real brands
> for detection testing and resolve to `127.0.0.1` **only** on a machine that
> ran `scripts/setup-hosts.ps1`. They are **not** registered, published, or
> reachable from the internet, and are **not** live phishing pages. Don't treat
> a fake hostname resolving on your own machine as evidence it exists anywhere
> else — it doesn't.

This doc covers how to validate Layer 1 (perceptual hashing). The implementation
passes both a synthetic self-check and a real-screenshot validation; this guide
is how to re-run it and stress-test the `<= 7` Hamming-distance threshold with
more real-world screenshot pairs. The dataset generator that Layer 1 compares
against at runtime now exists in `tools/` (see `tools/README.md`); the
`test-images/` workflow below is for validating the hashing threshold itself,
independent of the dataset.

---

## 1. Pull the latest code

```bash
git checkout main
git pull origin main
```

Make sure you're on the commit that includes `src/utils/phash.ts`, `scripts/test-phash.ts`, and the `pngjs` dependency in `package.json`.

## 2. Environment setup — read this before running anything

**If you're on WSL (Windows + Ubuntu/etc.), this part matters.** `pnpm install` will fail with a cryptic `EPERM`/junction error if your project folder or your Node install is being accessed through the Windows↔WSL bridge (`\\wsl.localhost\...` or `/mnt/c/...`) instead of natively inside WSL. If you hit that error, don't fight it — fix it like this:

```bash
# Install Node natively inside WSL via nvm (skip if you already have this)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install --lts

# Confirm Node is coming from .nvm, NOT /mnt/c/... or /usr/lib
which node
```

Also make sure your project folder itself lives on the **Linux side** of the filesystem (e.g. `~/phish_ext`), not something like `/mnt/c/Users/.../phish_ext` — that cross-filesystem access is what triggers the junction error in the first place.

If you're on native Linux or Mac, you can likely skip all of this and go straight to step 3.

## 3. Install dependencies

```bash
cd ~/phish_ext   # or wherever your Linux-native clone lives
pnpm install
```

This should complete cleanly — you'll see `wxt prepare` run at the end and a summary listing `pngjs`, `driver.js`, and the rest of the dependencies. If it fails with anything other than a normal network hiccup, stop and check step 2 again before troubleshooting further.

## 4. Run the existing test (no screenshots needed yet)

```bash
pnpm test:phash
```

This runs `scripts/test-phash.ts`, which does two things automatically:
- **Synthetic self-check** — generates test patterns in code, confirms identical images hash to distance 0, a noisy variant stays close, and a different pattern sits near the ~32-bit ceiling.
- **Real-image validation** — reads three PNGs from `test-images/` (see step 5) and reports real Hamming distances.

If `test-images/` is empty, the real-image section will fail or skip — that's expected until you add screenshots (next step).

## 5. Add your own real screenshot pairs

The goal here is to stress-test the `≤7` threshold (the value shipped in
`brands.json`, defined in `src/utils/phash.ts`) against a few real site pairs,
not just one sample.

For each pair, you need three files in `test-images/`:

| Filename | What it is |
|---|---|
| `same-1.png` | Screenshot of any real login/landing page |
| `same-2.png` | Reload the *same* page, screenshot again (this is the noise test) |
| `different.png` | Screenshot of a genuinely different site |

**How to screenshot (Chrome):**
1. Open the page.
2. Press `Ctrl+Shift+P` → type "screenshot" → choose **"Capture screenshot"** (visible area) — use the same option every time, don't mix visible-area and full-page captures.
3. Repeat for the reload (`same-2.png`) and the different page (`different.png`).

**Sites worth specifically testing:**
- The IDHC test-bank clone: `https://divcenter4.github.io/test/idhc.html` — it has an autoplay video background, which is a good stress test for frame-to-frame noise.
- At least one plain static page (no animation) as a contrast.
- One real bank/login-style page if you can find a public one, since that's closer to what the real pipeline will encounter.

Move your PNGs into `test-images/`, overwriting the previous set, then re-run:
```bash
pnpm test:phash
```

## 6. What "pass" looks like

- `Hamming(same-1, same-2)` should be **comfortably ≤7** (recent runs landed at 0–2 — single digits at most).
- `Hamming(same-1, different)` should be **clearly larger** — expect somewhere in the 25-40 range.
- There should be a large, obvious gap between the two numbers — no case where a "same page" pair creeps close to a "different page" pair.

**If any same-page pair comes back higher than 5** (especially with a video-background page), note it down with the exact numbers and site used — that's a real signal we may need to either loosen the threshold slightly or improve capture consistency (e.g. waiting for video to reach a consistent frame before capturing). Don't just re-run until you get a good number — a bad number is useful data, not a failure to hide.

## 7. Report back

Once you've run a few pairs, share:

- The exact Hamming distances for each pair you tested.
- Which sites you used.
- Anything that looked off (e.g. a same-page pair with an unexpectedly high distance).

The reference hashes the extension compares against at runtime are built by the
dataset generator in `tools/` (see `tools/README.md`), which captures brand pages
at fixed viewports — its hashes come from the same `src/utils/phash.ts` code
path, so a threshold that holds here transfers to the real pipeline.