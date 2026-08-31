import type { DetectionResult, DetectionSignals, BrandReference, DOMFeatures, ExtensionMessage, FlaggedElement } from '@/lib/types';
import { loadBrands } from '@/utils/brands';
import { checkDomainLegitimacy, levenshtein } from '@/utils/domain-check';
import { hammingDistance } from '@/utils/phash';
import { ensureAssigned } from '@/utils/condition-assignment';
import { logInteraction } from '@/utils/interaction-log';

export default defineBackground(() => {
  console.log('[phish_ext] Background service worker started');

  // Assign the participant's study condition before they can reach a flagged
  // page. Never overwrites an existing assignment -- see condition-assignment.
  void ensureAssigned();

  // ── Brand dataset loader ──
  // Loaded from bundled assets/brands/brands.json at startup. Fetch + caching
  // live in utils/brands (loadBrands) so they're independent of this entrypoint.

  // ── Layer 2: Domain legitimacy check ──
  // Pure string logic lives in utils/domain-check (checkDomainLegitimacy) so it
  // can be unit-tested in isolation; runPipeline below just calls it.

  // ── Layer 1 plumbing: capture screenshot, hand to offscreen for pHash ──

  /**
   * Ensure the offscreen document exists. Created once and reused across scans —
   * it's the only context with canvas access, so it does the pixel decoding and
   * pHash computation (see entrypoints/offscreen/worker.ts).
   */
  async function ensureOffscreenDocument(): Promise<boolean> {
    try {
      if (await browser.offscreen.hasDocument()) return true;
      await browser.offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: [browser.offscreen.Reason.BLOBS],
        justification:
          'Decode captured screenshots and compute perceptual hashes for phishing detection.',
      });
      return true;
    } catch (err) {
      console.warn('[phish_ext] Failed to create offscreen document:', err);
      return false;
    }
  }

  /**
   * Capture the visible tab and compute its perceptual hash (Layer 1 input).
   * Returns null — never throws — on any failure so the pipeline can degrade
   * to a safe no-match. Offscreen is Chromium-only; Firefox skips Layer 1.
   */
  async function captureAndHash(tabId: number, devicePixelRatio?: number): Promise<string | null> {
    try {
      if (!browser.offscreen) {
        console.warn('[phish_ext] offscreen API unavailable — skipping Layer 1');
        return null;
      }
      if (!(await ensureOffscreenDocument())) return null;

      const tab = await browser.tabs.get(tabId);
      if (tab.windowId == null) {
        console.warn('[phish_ext] Tab has no window to capture:', tabId);
        return null;
      }

      // captureVisibleTab grabs whatever tab is active in the window *at the
      // moment of the call*, not the tab we were asked about. If the user
      // switched tabs while we waited for the page to settle, capturing now
      // would either hash the wrong page or fail outright (a restricted page
      // like chrome:// reports the permission as not in effect). Skip Layer 1
      // instead -- the text layer still identifies the brand without it.
      if (!tab.active) {
        console.debug('[phish_ext] Tab not foreground at capture time, skipping Layer 1:', tabId);
        return null;
      }

      // captureVisibleTab captures the visible tab of a window.
      const imageData = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

      // The offscreen worker answers COMPUTE_PHASH with PHASH_RESULT directly.
      const message = {
        type: 'COMPUTE_PHASH',
        imageData,
        ...(devicePixelRatio != null ? { devicePixelRatio } : {}),
      } satisfies ExtensionMessage;
      let response: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await browser.runtime.sendMessage(message);
          break;
        } catch (err) {
          // The offscreen doc may still be initializing on the first scan —
          // give it a moment and retry once before giving up.
          if (attempt > 0) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      const res = response as { type?: string; hash?: string };
      return res?.type === 'PHASH_RESULT' ? res.hash || null : null;
    } catch (err) {
      console.warn('[phish_ext] Screenshot capture failed for tab:', tabId, err);
      return null;
    }
  }

  /**
   * How long to let a page settle after `onCompleted` before screenshotting.
   *
   * The reference hashes in brands.json are taken by tools/generate.py *after*
   * a settle step (network-idle + DOM-stability polling). Capturing the live
   * page the instant navigation completes can catch it mid-render — images not
   * yet painted, fonts still swapping — which produces a hash that will not
   * match a reference taken of the same page fully rendered.
   */
  const CAPTURE_SETTLE_MS = 1200;

  /**
   * Extra wait before re-extracting DOM features when the first pull found no
   * login form. Clone kits frequently mount their form (and brand text) via
   * JavaScript after navigation completes; this grace period lets that render
   * land before the text layer gives up on the page.
   */
  const LATE_FORM_GRACE_MS = 2500;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── Layer 3 (text): DOM features pulled from the content script ──

  /**
   * Ask the content script for the page's DOM features. Pulled on demand
   * rather than read from the PAGE_READY push, which races the navigation
   * event. Returns null if the content script isn't reachable (e.g. a
   * restricted page) — the pipeline then degrades to Layer 1 only.
   */
  async function fetchDOMFeatures(tabId: number): Promise<DOMFeatures | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = (await browser.tabs.sendMessage(tabId, {
          type: 'GET_FEATURES',
        } satisfies ExtensionMessage)) as { type?: string; features?: DOMFeatures };
        if (res?.type === 'FEATURES_RESULT' && res.features) return res.features;
      } catch {
        // Content script not injected yet — retry once.
      }
      await delay(300);
    }
    return null;
  }

  /**
   * Identify which brand a page is presenting itself as, from its title and
   * content words alone.
   *
   * This is the viewport-independent counterpart to Layer 1: a screenshot hash
   * only matches when the window size is close to a captured reference, but
   * page *text* is the same at any window size. Keywords come from the same
   * extraction algorithm the dataset generator uses, so they're comparable to
   * `BrandReference.keywords`.
   *
   * Requires a credential field: a page merely mentioning a brand isn't
   * impersonation, but a login form claiming to be that brand is exactly the
   * threat model — and requiring it keeps false positives down.
   */
  /** Shortest brand/page token length eligible for lookalike matching. */
  const NAME_FUZZ_MIN_LEN = 4;
  /** Edit distance treated as "a near-copy of the brand name". */
  const NAME_FUZZ_MAX_DISTANCE = 1;
  /** Brand keywords a lookalike name must also be backed by. */
  const FUZZY_KEYWORD_CORROBORATION = 3;
  /**
   * Brand-distinctive keywords required when the brand isn't named in the
   * page title. Naming a brand once (an OAuth "Continue with GitHub" button,
   * say) is not impersonation; a page that is actually pretending to be the
   * brand either says so in its title or reuses several of its distinctive
   * words.
   */
  const DISTINCTIVE_KEYWORD_MIN = 3;

  interface TextMatch {
    brand: BrandReference;
    matchedKeywords: string[];
    /**
     * 'exact' - the brand's own name appears; 'lookalike' - a near-copy does;
     * 'context' - the brand is never named, but its distinctive wording is
     * reused and corroborated by its colour palette and typeface.
     */
    nameMatch: 'exact' | 'lookalike' | 'context';
    /** For a lookalike, which brand token and which page word. */
    lookalike?: { brandToken: string; pageWord: string };
  }

  /**
   * Keywords unique to one brand in the dataset.
   *
   * The reference pages are login pages, so the generated keyword lists are
   * heavy with generic login vocabulary ("password", "email", "continue",
   * "apple") that several brands share. Matching those says nothing about
   * *which* brand a page is imitating, so only keywords belonging to exactly
   * one brand count towards identification.
   */
  function distinctiveKeywords(brand: BrandReference, brands: BrandReference[]): Set<string> {
    const shared = new Map<string, number>();
    for (const b of brands) {
      for (const k of new Set(b.keywords.map((x) => x.toLowerCase()))) {
        shared.set(k, (shared.get(k) ?? 0) + 1);
      }
    }
    return new Set(brand.keywords.map((k) => k.toLowerCase()).filter((k) => shared.get(k) === 1));
  }

  function identifyBrandByText(features: DOMFeatures, brands: BrandReference[]): TextMatch | null {
    const collectsCredentials = features.hasCredentialField ?? features.hasLoginForm;

    /**
     * Hosts this page pulls content from, for the impersonation check below.
     */
    const externalHosts = features.elements
      .filter((e) => e.kind === 'external-asset' && e.detail)
      .map((e) => e.detail!.toLowerCase());

    /** Does the page serve content from this brand's own domains? */
    const hotlinksBrand = (brand: BrandReference): boolean =>
      brand.allowedDomains.some((d) => {
        const domain = d.toLowerCase();
        return externalHosts.some((h) => h === domain || h.endsWith(`.${domain}`));
      });

    const titleWords = new Set<string>(features.title.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const pageWords = new Set<string>([
      ...features.pageKeywords.map((k) => k.toLowerCase()),
      ...titleWords,
    ]);

    let exact: TextMatch | null = null;
    let lookalike: TextMatch | null = null;

    for (const brand of brands) {
      /**
       * Naming a brand is not enough on its own -- that describes every review,
       * tutorial and news article on the web. The page must also be doing
       * something a page merely *about* the brand would not:
       *
       *  - collecting credentials, or
       *  - serving its content from the brand's own servers.
       *
       * The second matters because clones are built by copying markup, which
       * drags the original's absolute URLs along with it. A page on some other
       * domain loading its images from paypalobjects.com is not writing about
       * PayPal, it is wearing it -- and unlike a screenshot hash, this holds at
       * any window size.
       */
      if (!collectsCredentials && !hotlinksBrand(brand)) continue;
      const idToken = brand.id.toLowerCase();
      const nameTokens = [...new Set(
        brand.name.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z]/g, '')).filter((t) => t.length >= 3),
      )];
      const matchedKeywords = brand.keywords.filter((k) => pageWords.has(k.toLowerCase()));

      // Exact: the brand id appears, or at least two words of a multi-word
      // name do -- one generic word like "bank" isn't enough on its own.
      const exactHits = nameTokens.filter((t) => pageWords.has(t));
      if (pageWords.has(idToken) || exactHits.length >= 2) {
        // Naming the brand is necessary but not sufficient: plenty of honest
        // login pages mention a brand (OAuth buttons, "powered by" notices).
        // Require either the brand in the page title -- what an impersonating
        // page almost always does -- or several of its distinctive keywords.
        const namedInTitle = titleWords.has(idToken) || nameTokens.some((t) => titleWords.has(t));
        const distinctive = distinctiveKeywords(brand, brands);
        const distinctiveHits = matchedKeywords.filter((k) => distinctive.has(k.toLowerCase()));
        if (!namedInTitle && distinctiveHits.length < DISTINCTIVE_KEYWORD_MIN) continue;

        if (!exact || matchedKeywords.length > exact.matchedKeywords.length) {
          exact = { brand, matchedKeywords, nameMatch: 'exact' };
        }
        continue;
      }

      // Lookalike: a brand token one edit from a word on the page, e.g. a page
      // calling itself "IDHC" while copying IDFC. On its own this is far too
      // weak -- a short token is one edit from plenty of ordinary words
      // ("stop" vs "vtop") -- so it carries three guards.
      if (matchedKeywords.length < FUZZY_KEYWORD_CORROBORATION) continue;
      // A brand token that also appears in the brand's own keywords is a word
      // that is simply common on that page ("bank", "first"), not something
      // that identifies the brand. Only distinctive tokens are worth fuzzing.
      const commonWords = new Set(brand.keywords.map((k) => k.toLowerCase()));
      for (const brandToken of [idToken, ...nameTokens]) {
        if (brandToken.length < NAME_FUZZ_MIN_LEN || commonWords.has(brandToken)) continue;
        for (const pageWord of pageWords) {
          if (pageWord.length < NAME_FUZZ_MIN_LEN) continue;
          const distance = levenshtein(brandToken, pageWord);
          // Must be a near-MISS. An exact hit is the 'exact' path's business,
          // which deliberately requires two name tokens rather than one.
          if (distance < 1 || distance > NAME_FUZZ_MAX_DISTANCE) continue;
          if (!lookalike || matchedKeywords.length > lookalike.matchedKeywords.length) {
            lookalike = { brand, matchedKeywords, nameMatch: 'lookalike', lookalike: { brandToken, pageWord } };
          }
        }
      }
    }

    // A page that names the brand outright is stronger evidence than one that
    // only resembles it, so exact always wins.
    return exact ?? lookalike;
  }

  /**
   * Distinctive keyword hits a context match must reach on its own: the brand
   * is never named (its logo is an image, say), so the wording evidence has to
   * stand without a name to point at.
   */
  const CONTEXT_DISTINCTIVE_MIN = 3;
  /**
   * Distinctive hits needed when the weaker route runs: there the keyword
   * evidence is thinner, so the page must also wear the brand's colours and
   * typeface before it counts.
   */
  const CONTEXT_DISTINCTIVE_WITH_STYLING_MIN = 2;
  /** Keyword matches (any, not just distinctive) for the styling-backed route. */
  const CONTEXT_KEYWORDS_WITH_STYLING_MIN = 6;

  /**
   * Identify a brand from wording + styling when the page never names it.
   *
   * A convincing clone often draws the brand name only inside its logo image,
   * so `identifyBrandByText` finds nothing to match. This fallback instead
   * asks whether the page reuses the brand's distinctive wording in volume,
   * and, on the weaker route, backs that up with its colour palette and
   * typeface. Distinctive keywords carry the weight because generic login
   * vocabulary is shared by every brand in the dataset.
   */
  function identifyBrandByContext(features: DOMFeatures, brands: BrandReference[]): TextMatch | null {
    // Same credential gate as the name-based path: the wording evidence must
    // describe a page that could *take* something from the visitor. Unlike
    // that path, a hotlinked brand asset is not enough here -- an unnamed
    // match rests on wording alone, and an article or fan page that embeds
    // the brand's own images could clear it.
    if (!(features.hasCredentialField ?? features.hasLoginForm)) return null;

    const titleWords = new Set<string>(features.title.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const pageWords = new Set<string>([
      ...features.pageKeywords.map((k) => k.toLowerCase()),
      ...titleWords,
    ]);

    let best: { match: TextMatch; score: number } | null = null;
    for (const brand of brands) {
      const matchedKeywords = brand.keywords.filter((k) => pageWords.has(k.toLowerCase()));
      if (matchedKeywords.length === 0) continue;
      const distinctive = distinctiveKeywords(brand, brands);
      const distinctiveHits = matchedKeywords.filter((k) => distinctive.has(k.toLowerCase()));

      const colorsMatch = matchingColors(features.dominantColors, brand.colors).length > 0;
      const fontMatch =
        !!features.fontFamily?.trim() &&
        !!brand.fontFamily?.trim() &&
        features.fontFamily.trim().toLowerCase() === brand.fontFamily.trim().toLowerCase();

      const strongEnough =
        distinctiveHits.length >= CONTEXT_DISTINCTIVE_MIN ||
        (distinctiveHits.length >= CONTEXT_DISTINCTIVE_WITH_STYLING_MIN &&
          matchedKeywords.length >= CONTEXT_KEYWORDS_WITH_STYLING_MIN &&
          colorsMatch &&
          fontMatch);
      if (!strongEnough) continue;

      // Distinctive words are worth much more than shared login vocabulary.
      const score = distinctiveHits.length * 2 + matchedKeywords.length;
      if (!best || score > best.score) {
        best = { match: { brand, matchedKeywords, nameMatch: 'context' }, score };
      }
    }
    return best?.match ?? null;
  }

  /** Parse "#rrggbb" into RGB, or null if it isn't a hex colour. */
  function hexToRgb(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * Page colours that match the brand's palette. Compared with a tolerance
   * rather than exactly: the same brand colour renders slightly differently
   * across pages (opacity, gradients, subpixel blending), so an exact hex
   * match would almost never fire.
   */
  function matchingColors(pageColors: string[], brandColors: string[], tolerance = 24): string[] {
    return pageColors.filter((pc) => {
      const a = hexToRgb(pc);
      if (!a) return false;
      return brandColors.some((bc) => {
        const b = hexToRgb(bc);
        return b != null && Math.abs(a[0] - b[0]) <= tolerance
          && Math.abs(a[1] - b[1]) <= tolerance
          && Math.abs(a[2] - b[2]) <= tolerance;
      });
    });
  }

  // ── Layer 1: nearest-brand comparison for a computed screenshot hash ──

  /** All reference hashes for a brand (primary + any viewport variants). */
  function brandHashes(brand: BrandReference): string[] {
    const hashes = new Set<string>();
    if (brand.phash) hashes.add(brand.phash);
    if (brand.phashByViewport) {
      for (const h of Object.values(brand.phashByViewport)) if (h) hashes.add(h);
    }
    return [...hashes];
  }

  function findVisualBrandMatch(
    hash: string,
    brands: BrandReference[],
  ): { brand: BrandReference; distance: number } | null {
    let best: { brand: BrandReference; distance: number } | null = null;
    for (const brand of brands) {
      for (const refHash of brandHashes(brand)) {
        if (refHash.length !== hash.length) continue; // hammingDistance() would throw
        const distance = hammingDistance(hash, refHash);
        if (distance <= brand.phashThreshold && (!best || distance < best.distance)) {
          best = { brand, distance };
        }
      }
    }
    return best;
  }

  // ── Pipeline orchestrator: runs when a page finishes loading ──

  async function runPipeline(tabId: number, url: string): Promise<DetectionResult> {
    const brands = await loadBrands();

    // The first feature pull comes before the capture: the hash band is
    // measured in CSS pixels, so Layer 1 needs the page's devicePixelRatio
    // (reported by the content script) to convert the screenshot correctly.
    // This pull is deliberately without the late-form grace period -- the
    // screenshot should happen promptly after the settle wait; the retry
    // runs further down, after the capture.
    let features: DOMFeatures | null = await fetchDOMFeatures(tabId);

    // Layer 1 (visual): screenshot -> pHash -> nearest brand within threshold.
    // Viewport-dependent: only matches when the window is close in size to one
    // of the captured references.
    const hash = await captureAndHash(tabId, features?.devicePixelRatio);
    const visual = hash ? findVisualBrandMatch(hash, brands) : null;

    // Layer 3 (text): identify the brand from page text. Deliberately runs
    // independently of Layer 1 -- a viewport mismatch or a failed screenshot
    // must not blind the whole pipeline, which is what happens if the visual
    // match is treated as a gate.
    // Second chance for late-rendered credential forms: kit-built clone pages
    // often mount their fields (and their brand text) via JavaScript after the
    // initial extraction. If the first look found no credential field, give
    // the page one grace period and re-extract before concluding anything. One
    // retry only, so ordinary pages without a form don't pay the delay twice.
    // Email-first logins (hasCredentialField) count, so they skip the wait.
    const collectsCredentials = features
      ? (features.hasCredentialField ?? features.hasLoginForm)
      : false;
    if (features && !collectsCredentials) {
      await delay(LATE_FORM_GRACE_MS);
      features = (await fetchDOMFeatures(tabId)) ?? features;
    }
    // The name-based match is preferred; the context fallback only runs when
    // the page never names the brand in its text.
    const textual = features
      ? (identifyBrandByText(features, brands) ?? identifyBrandByContext(features, brands))
      : null;

    const matchedBrand = visual?.brand ?? textual?.brand ?? null;

    if (!matchedBrand) {
      if (hash) {
        // Unmatched hash - log it so it can be seeded as a brand reference
        // (see scripts/hash-png.ts).
        console.log('[phish_ext] Page pHash (no brand match):', hash);
      }
      return {
        riskScore: 0,
        matchedBrand: null,
        flaggedElements: [],
        reasoning: 'No match against known brands.',
      };
    }

    const signalSummary = [
      visual ? `visual (hamming ${visual.distance})` : null,
      textual ? `text/${textual.nameMatch} (${textual.matchedKeywords.length} keywords)` : null,
    ].filter(Boolean).join(' + ');
    console.log(`[phish_ext] Brand "${matchedBrand.id}" identified by: ${signalSummary}`);

    // Layer 2 (domain): is this host legitimate for the identified brand?
    const domain = checkDomainLegitimacy(url, matchedBrand);

    // Layer 3: point the warning at the actual elements. Ordered most-direct
    // first, because Progressive Reveal reveals them one stage at a time.
    const flaggedElements: FlaggedElement[] = [];
    if (domain.isSuspicious) {
      const logo = features?.elements.find((e) => e.kind === 'logo');
      if (logo) {
        flaggedElements.push({
          element: 'logo',
          reason: 'logo_match',
          selector: logo.selector,
          title: `This logo is not ${matchedBrand.name}'s`,
          note:
            `The page presents itself as ${matchedBrand.name}, but it is served from ` +
            `"${domain.hostname}".`,
        });
      }

      flaggedElements.push({
        element: 'domain',
        reason: domain.flagReason ?? 'domain_mismatch',
        title: domain.flagReason === 'typosquatting' ? 'Domain is a lookalike' : 'Unofficial domain',
        note: domain.reason,
      });

      if (textual?.nameMatch === 'lookalike' && textual.lookalike) {
        flaggedElements.push({
          element: 'brand name',
          reason: 'typosquatting',
          title: `"${textual.lookalike.pageWord}" imitates "${textual.lookalike.brandToken}"`,
          note:
            `This page calls itself "${textual.lookalike.pageWord}" - one character away from ` +
            `${matchedBrand.name}'s "${textual.lookalike.brandToken}", while reusing its wording and layout.`,
        });
      }

      if (textual?.matchedKeywords.length) {
        const brandText = features?.elements.find((e) => e.kind === 'brand-text');
        flaggedElements.push({
          element: 'page text',
          reason: 'brand_keywords',
          selector: brandText?.selector,
          title: `Text reuses ${matchedBrand.name} wording`,
          note:
            `Wording from ${matchedBrand.name}'s real page appears here: ` +
            `${textual.matchedKeywords.slice(0, 6).join(', ')}.`,
        });
      }

      // Font is a good disproof when it differs: a clone rarely licenses the
      // brand's typeface, so it substitutes a lookalike stack.
      const pageFont = features?.fontFamily?.trim();
      const brandFont = matchedBrand.fontFamily?.trim();
      if (pageFont && brandFont && pageFont.toLowerCase() !== brandFont.toLowerCase()) {
        flaggedElements.push({
          element: 'typeface',
          reason: 'color_scheme',
          title: 'Different typeface to the real site',
          note: `This page sets ${pageFont}. ${matchedBrand.name} uses ${brandFont}.`,
        });
      }

      const colors = features ? matchingColors(features.dominantColors, matchedBrand.colors) : [];
      if (colors.length) {
        const colorBlock = features?.elements.find((e) => e.kind === 'color-block');
        flaggedElements.push({
          element: 'colour scheme',
          reason: 'color_scheme',
          selector: colorBlock?.selector,
          title: `Colours copy ${matchedBrand.name}`,
          note: `The page uses ${matchedBrand.name}'s palette (${colors.join(', ')}).`,
        });
      }

      if (visual) {
        flaggedElements.push({
          element: 'page layout',
          reason: 'visual_similarity',
          title: `Layout copies ${matchedBrand.name}`,
          note:
            `The page's layout is a close perceptual match for ${matchedBrand.name}'s real ` +
            `page (${visual.distance} bits different out of 64).`,
        });
      }

      // Assets pulled from the brand's own servers: the page is literally
      // loading the real site's files. Strong, pointable, and viewport-proof.
      const brandHosts = matchedBrand.allowedDomains.map((d) => d.toLowerCase());
      const hotlinked = (features?.elements ?? []).filter(
        (e) => e.kind === 'external-asset'
          && e.detail
          && brandHosts.some((d) => e.detail === d || e.detail!.endsWith(`.${d}`)),
      );
      for (const asset of hotlinked) {
        flaggedElements.push({
          element: 'copied asset',
          reason: 'logo_match',
          selector: asset.selector,
          title: `Loaded from ${matchedBrand.name}'s own server`,
          note:
            `This page pulls content directly from "${asset.detail}" -- ${matchedBrand.name}'s ` +
            `real domain -- while being served from "${domain.hostname}".`,
        });
      }

      const loginForm = features?.elements.find((e) => e.kind === 'login-form');
      if (loginForm) {
        flaggedElements.push({
          element: 'login form',
          reason: 'form_layout',
          selector: loginForm.selector,
          title: 'This sign-in form is not official',
          note: `The form is laid out like ${matchedBrand.name}'s, but it is hosted on "${domain.hostname}".`,
        });
      }

      const passwordField = features?.elements.find((e) => e.kind === 'password-field');
      if (passwordField) {
        flaggedElements.push({
          element: 'password field',
          reason: 'form_layout',
          selector: passwordField.selector,
          title: 'Your details would be sent here',
          note:
            `Anything typed here goes to "${domain.hostname}", not to ${matchedBrand.name}.`,
        });
      }
    }

    // Two independent signals agreeing is stronger than either alone. Text
    // alone is weakest (no visual confirmation) but still worth warning about.
    let riskScore = 0.05;
    if (domain.isSuspicious) {
      if (visual && textual) riskScore = 0.9;
      else if (visual) riskScore = 0.85;
      // Lookalike and context matches are the weaker text routes: a name one
      // edit away, or no name at all with only wording + styling to go on.
      else if (textual?.nameMatch === 'lookalike' || textual?.nameMatch === 'context') riskScore = 0.6;
      else riskScore = 0.7;
    }

    const reasoning = domain.isSuspicious
      ? `This page matches ${matchedBrand.name}'s look and branding, but the domain ` +
        `"${domain.hostname}" is not an official ${matchedBrand.name} domain. ${domain.reason}`
      : `The page matches ${matchedBrand.name} and its domain is legitimate.`;

    // The raw signals behind the verdict, for the study log. The warning UI
    // never reads these; they exist so a researcher can see which layers fired
    // and how hard (hash distance, keyword corroboration, domain distance).
    const signals: DetectionSignals = {
      ...(hash ? { phash: hash } : {}),
      ...(visual ? { visualDistance: visual.distance } : {}),
      ...(textual
        ? {
            nameMatch: textual.nameMatch,
            matchedKeywords: textual.matchedKeywords,
            ...(textual.lookalike ? { lookalike: textual.lookalike } : {}),
          }
        : {}),
      domain: {
        hostname: domain.hostname,
        ...(domain.flagReason ? { flagReason: domain.flagReason } : {}),
        ...(domain.matchedAllowedDomain ? { matchedAllowedDomain: domain.matchedAllowedDomain } : {}),
        ...(domain.distance != null ? { distance: domain.distance } : {}),
      },
    };

    const result: DetectionResult = {
      riskScore,
      matchedBrand: matchedBrand.id,
      flaggedElements,
      reasoning,
      signals,
      comparison: domain.isSuspicious
        ? {
            name: matchedBrand.name,
            officialDomain: matchedBrand.allowedDomains[0] ?? '',
            actualDomain: domain.hostname,
            thumbnail: matchedBrand.referenceThumbnail || undefined,
            colors: matchedBrand.colors,
            fontFamily: matchedBrand.fontFamily || undefined,
          }
        : undefined,
    };

    // Hand the verdict to the content script -> warning UI.
    browser.tabs
      .sendMessage(tabId, { type: 'DETECTED', result } satisfies ExtensionMessage)
      .catch(() => {
        // No receiver (e.g. tabs where the content script isn't present) - ignore.
      });

    return result;
  }

  // ── Listen for completed page navigation ──

  browser.webNavigation?.onCompleted.addListener(
    (details) => {
      if (details.frameId !== 0) return; // Only main frame
      if (!details.url?.startsWith('http')) return;
      console.log('[phish_ext] Page loaded:', details.url);
      delay(CAPTURE_SETTLE_MS)
        .then(() => runPipeline(details.tabId, details.url))
        .catch((err) => {
          console.error('[phish_ext] Pipeline failed for:', details.url, err);
        });
    },
    { url: [{ schemes: ['http', 'https'] }] },
  );

  // ── Manual re-scan: keyboard shortcut → re-run the pipeline on the active tab ──
  // Ctrl+Shift+H (see wxt.config.ts `commands`). The pipeline also auto-runs on
  // navigation; this is just a convenient way to trigger a fresh scan.

  async function rescanActiveTab(): Promise<void> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
      const result = await runPipeline(tab.id, tab.url ?? '');
      console.log('[phish_ext] Manual scan result:', result);
    } catch (err) {
      console.error('[phish_ext] Manual scan failed:', err);
    }
  }

  browser.commands?.onCommand.addListener((command) => {
    if (command !== 'rescan') return;
    void rescanActiveTab();
  });

  // ── Listen for messages from content script / offscreen / popup ──

  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender) => {
    if (message.type === 'PAGE_READY') {
      console.log('[phish_ext] Content script ready:', message.url);
      // TODO: Use the DOM features from the content script in layer 3
    } else if (message.type === 'GO_BACK') {
      // Warning-banner action: send the user back to the previous page.
      if (sender.tab?.id != null) {
        browser.tabs.goBack(sender.tab.id).catch((err) => {
          console.warn('[phish_ext] Could not navigate back:', err);
        });
      }
    } else if (message.type === 'SET_BADGE') {
      // Progressive Reveal stage 1 is a toolbar badge change and nothing else:
      // no page interruption, nothing for the participant to hunt for or click.
      const tabId = sender.tab?.id;
      if (tabId != null) {
        void browser.action?.setBadgeText({ tabId, text: message.text ?? '' });
        if (message.text) {
          void browser.action?.setBadgeBackgroundColor({ tabId, color: '#b3261e' });
        }
      }
    } else if (message.type === 'LEFT_PAGE') {
      // The content script sent this fire-and-forget on pagehide: the page
      // context is being torn down, so it cannot write to storage itself.
      void logInteraction('left-page', message.result, message.url, {
        condition: message.condition,
        visitId: message.visitId,
        stage: message.stage,
        includeResult: false,
      });
    } else if (message.type === 'SUBMITTED') {
      // Fire-and-forget from the content script: the page is navigating away.
      void logInteraction('submitted', message.result, message.url, {
        condition: message.condition,
        visitId: message.visitId,
        stage: message.stage,
        includeResult: false,
      });
    } else if (message.type === 'RESCAN') {
      // Popup condition change → re-run the pipeline so the new warning
      // condition takes effect on the current tab without navigating away.
      void rescanActiveTab();
    }
  });
});
