import type { DOMFeatures, DetectedMessage, ElementLocation, ExtensionMessage } from '@/lib/types';
import { logInteraction } from '@/utils/interaction-log';
import { clearHighlight, hidePopover, highlightEvidence, isPopoverVisible } from '@/utils/driver-highlight';
import {
  createBehaviorMonitor,
  type BehaviorMonitor,
  type EscalationStage,
  type EscalationTrigger,
} from '@/utils/behavior-monitor';
import { renderers, type Renderer } from '@/components/renderers';
import { modalRenderer } from '@/components/renderers/modal';
import { resolveCondition } from '@/utils/condition-assignment';
import { createEngagementTracker, credentialField, CREDENTIAL_SELECTOR, type EngagementTracker } from '@/utils/engagement-tracker';
import { isEnabled } from '@/utils/enabled';
import type { WarningCondition } from '@/lib/conditions';

export default defineContentScript({
  matches: ['*://*/*'],
  excludeMatches: ['*://localhost/*'],

  main() {
    console.log('[phish_ext] Content script loaded on:', window.location.href);

    // ── DOM feature extraction (Layer 3 data source) ──

    /**
     * Stop words excluded from page keywords. Mirrors the list in
     * tools/generate.py so a page's keywords are drawn from the same
     * vocabulary as the brand keywords stored in brands.json.
     */
    const STOP_WORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'at', 'is', 'are', 'you', 'your',
      'we', 'our', 'this', 'that', 'it', 'with', 'by', 'from', 'as', 'please', 'new', 'get', 'use',
      'using', 'more', 'all', 'menu', 'search', 'login', 'log', 'out', 'sign', 'up', 'not',
      'if', 'have', 'has', 'had', 'been', 'will', 'can', 'may', 'www', 'http', 'https', 'com',
      // Generic login/web vocabulary pruned from brands.json: matching these
      // says nothing about *which* brand a page imitates, and they false-flag
      // ordinary login pages. Must stay identical to tools/generate.py.
      'account', 'accounts', 'password', 'passwords', 'username', 'user', 'email',
      'cookie', 'cookies', 'continue', 'continuing', 'passkey', 'forgot', 'remember',
      'register', 'registered', 'welcome', 'enter', 'agree', 'accept', 'skip', 'create',
      'access', 'personal', 'contact', 'help', 'information', 'business', 'service',
      'services', 'policy', 'privacy', 'terms', 'conditions', 'agreement', 'secure',
      'secured', 'security', 'details', 'free', 'now', 'next', 'need', 'app', 'mobile',
      'number', 'address', 'code', 'click', 'clicking', 'read', 'view', 'content',
      'notice', 'best', 'always', 'visit', 'products', 'started', 'work', 'send',
      'features', 'resources', 'partners', 'apple', 'google', 'facebook', 'whatsapp',
      'microsoft', 'bank', 'banking', 'card', 'cards', 'credit', 'loans', 'net',
      'kindly', 'html', 'browser', 'compatibility', 'only', 'without', 'here', 'set',
      'reset', 'main', 'don', 'its',
    ]);

    /**
     * Most frequent content words on the page. Same algorithm as
     * `DOM_EXTRACT_JS` in tools/generate.py (title + first 3000 chars of
     * visible text, words of 3+ letters, stop words removed, top 30 by
     * frequency) so these are directly comparable to `BrandReference.keywords`.
     *
     * The cap deliberately exceeds the reference lists' 12 entries: matching
     * is a set-membership test against `BrandReference.keywords` in the
     * background, so a larger page-side pool only raises recall -- a clone
     * whose boilerplate pushes a brand word out of its top slots still gets
     * matched.
     */
    const KEYWORD_WINDOW_CHARS = 3000;
    const KEYWORD_POOL_SIZE = 30;

    function extractKeywords(): string[] {
      const title = (document.title || '').toLowerCase();
      const body = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, KEYWORD_WINDOW_CHARS);
      const freq = new Map<string, number>();
      for (const word of `${body} ${title}`.match(/[a-z]{3,}/g) ?? []) {
        if (STOP_WORDS.has(word)) continue;
        freq.set(word, (freq.get(word) ?? 0) + 1);
      }
      return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEYWORD_POOL_SIZE)
        .map(([word]) => word);
    }

    // ── Element localization (Layer 3) ──

    /** Attributes that suggest an element is a brand logo. */
    const LOGO_HINT = /logo|brand|wordmark|masthead/i;

    /**
     * A CSS selector that resolves to exactly this element.
     *
     * Prefers a unique id, otherwise walks up building an `nth-of-type` path,
     * stopping early at the nearest unique-id ancestor. Capped at 5 levels:
     * the warning only needs to find the element again on this same page, so a
     * short, readable selector beats a maximally-specific one.
     */
    function buildSelector(el: Element): string {
      const uniqueId = (e: Element) =>
        e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1;

      if (uniqueId(el)) return `#${CSS.escape(el.id)}`;

      const parts: string[] = [];
      let node: Element | null = el;
      while (node && parts.length < 5) {
        const parent: Element | null = node.parentElement;
        let part = node.tagName.toLowerCase();
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        if (!parent) break;
        if (uniqueId(parent)) {
          parts.unshift(`#${CSS.escape(parent.id)}`);
          break;
        }
        node = parent;
      }
      return parts.join(' > ');
    }

    /**
     * Best guess at the page's brand logo: an element whose own id/class/alt
     * says "logo"/"brand", else the first image in a header or nav.
     */
    function findLogo(): HTMLElement | null {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('img, svg, [class*="logo"], [id*="logo"], [class*="brand"], [id*="brand"]'),
      );
      for (const el of candidates) {
        const haystack = [
          el.id,
          el.getAttribute('class') ?? '',
          el.getAttribute('alt') ?? '',
          el.getAttribute('aria-label') ?? '',
        ].join(' ');
        if (LOGO_HINT.test(haystack)) return el;
      }
      return document.querySelector<HTMLElement>('header img, nav img, header svg, nav svg') ?? candidates[0] ?? null;
    }

    function rgbToHex(color: string): string | null {
      const m = color.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]!.split(',').map((v) => parseFloat(v.trim()));
      if (parts.length === 4 && parts[3] === 0) return null; // fully transparent
      const [r, g, b] = parts as [number, number, number];
      return (
        '#' +
        [r, g, b]
          .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
          .join('')
      );
    }

    /** How far a colour sits from grey. */
    function saturationOf(color: string): number | null {
      const m = color.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]!.split(',').map((v) => parseFloat(v.trim()));
      if (parts.length === 4 && (parts[3] ?? 1) < 0.5) return null;
      const [r, g, b] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max === 0 ? 0 : (max - min) / max;
    }

    /**
     * The page's most brand-identifying colours.
     *
     * Must stay identical to DOM_EXTRACT_JS in tools/generate.py -- the two
     * lists are compared directly, so drift between them silently breaks the
     * colour signal.
     *
     * Backgrounds alone are not enough: login pages are overwhelmingly white
     * or near-black, so nearly every brand ended up with #ffffff, which
     * matches anything and therefore evidences nothing. Buttons and links
     * carry the accent colour that actually identifies a brand, and ranking
     * by saturation puts it ahead of the page background.
     */
    function extractColors(): string[] {
      const seen = new Map<string, number>();
      const consider = (color: string | null | undefined): void => {
        if (!color) return;
        const sat = saturationOf(color);
        if (sat === null) return;
        const hex = rgbToHex(color);
        if (hex && !seen.has(hex)) seen.set(hex, sat);
      };

      for (const sel of ['body', 'header', 'nav', 'main', '[class*="logo"],[id*="logo"],[class*="brand"],[id*="brand"]']) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) consider(getComputedStyle(el).backgroundColor);
      }
      const accents = document.querySelectorAll<HTMLElement>(
        'button, [type="submit"], a.button, .btn, [class*="button"], [class*="cta"], a',
      );
      for (const el of Array.from(accents).slice(0, 60)) {
        const cs = getComputedStyle(el);
        consider(cs.backgroundColor);
        consider(cs.color);
      }

      return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex]) => hex);
    }

    /**
     * Elements loading their content from a *different* host than the page.
     *
     * A clone that hotlinks the real brand's images/fonts instead of
     * re-hosting them is pointing straight at who it is imitating -- and
     * unlike keywords or a screenshot hash, it is unaffected by window size.
     * One element per external host, so a page pulling 11 files from one
     * server yields one piece of evidence rather than eleven.
     */
    function locateExternalAssets(): ElementLocation[] {
      const here = window.location.hostname;
      const seen = new Set<string>();
      const located: ElementLocation[] = [];

      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>('img[src], script[src], link[href], video[src], source[src]'),
      )) {
        const raw = el.getAttribute('src') ?? el.getAttribute('href');
        if (!raw) continue;
        let host: string;
        try {
          host = new URL(raw, window.location.href).hostname;
        } catch {
          continue;
        }
        if (!host || host === here || seen.has(host)) continue;
        seen.add(host);
        located.push({ selector: buildSelector(el), kind: 'external-asset', detail: host });
      }
      return located;
    }

    /**
     * Is this element actually on screen?
     *
     * Login forms are routinely inside a collapsed panel or modal, so
     * querySelector finds them while they render 0x0. Outlining one draws an
     * invisible box, and naming it as evidence points at nothing -- so hidden
     * elements are not recorded as locations at all.
     */
    function isVisible(el: HTMLElement): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    /** The visible element carrying the most of the page's own keywords. */
    function findBrandTextElement(keywords: string[]): HTMLElement | null {
      if (keywords.length === 0) return null;
      const top = keywords.slice(0, 5).map((k) => k.toLowerCase());
      let best: { el: HTMLElement; hits: number } | null = null;
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>('h1, h2, h3, header p, main p, .hero, [class*="tagline"]'),
      )) {
        if (!isVisible(el)) continue;
        const text = (el.textContent ?? '').toLowerCase();
        const hits = top.filter((k) => text.includes(k)).length;
        if (hits > 0 && (!best || hits > best.hits)) best = { el, hits };
      }
      return best?.el ?? null;
    }

    /** The visible block that carries the page's dominant colour. */
    function findColorBlock(): HTMLElement | null {
      for (const selector of ['header', 'nav', '[class*="hero"]', 'main']) {
        const el = document.querySelector<HTMLElement>(selector);
        if (el && isVisible(el) && rgbToHex(getComputedStyle(el).backgroundColor)) return el;
      }
      return null;
    }

    /** Locate the elements a warning can point at. */
    function locateElements(passwordField: HTMLElement | null, keywords: string[]): ElementLocation[] {
      const located: ElementLocation[] = [];

      const logo = findLogo();
      if (logo && isVisible(logo)) {
        located.push({
          selector: buildSelector(logo),
          kind: 'logo',
          detail: logo.getAttribute('src') ?? logo.getAttribute('alt') ?? undefined,
        });
      }

      const brandText = findBrandTextElement(keywords);
      if (brandText) {
        located.push({ selector: buildSelector(brandText), kind: 'brand-text' });
      }

      const colorBlock = findColorBlock();
      if (colorBlock) {
        located.push({
          selector: buildSelector(colorBlock),
          kind: 'color-block',
          detail: rgbToHex(getComputedStyle(colorBlock).backgroundColor) ?? undefined,
        });
      }

      // Whatever field actually takes the credentials -- the password box when
      // there is one, otherwise the identifier field of a two-step login.
      //
      // A visible field is preferred, but a hidden one is recorded rather than
      // dropped: on a modal login (IDHC) every credential field is display:none
      // until the participant opens the modal, and that field is the single
      // most important thing to mark once it appears. Its selector is stable
      // whether or not it is showing, and the outline layer re-checks
      // visibility at render time -- it only draws a box once the element is
      // actually on screen -- so recording a currently-hidden field cannot
      // produce a 0x0 outline pointing at nothing.
      const credentialCandidates = [
        ...(passwordField ? [passwordField] : []),
        ...Array.from(document.querySelectorAll<HTMLElement>(CREDENTIAL_SELECTOR)),
      ];
      const credentialTarget = credentialCandidates.find(isVisible) ?? credentialCandidates[0] ?? null;
      if (credentialTarget) {
        located.push({ selector: buildSelector(credentialTarget), kind: 'password-field' });
        const form = credentialTarget.closest<HTMLElement>('form');
        if (form) located.push({ selector: buildSelector(form), kind: 'login-form' });
      }

      located.push(...locateExternalAssets());
      return located;
    }

    function extractDOMFeatures(): DOMFeatures {
      const passwordFields = document.querySelectorAll<HTMLElement>('input[type="password"]');
      const credentialFields = document.querySelectorAll<HTMLElement>(CREDENTIAL_SELECTOR);
      const logo = findLogo();
      const keywords = extractKeywords();
      return {
        url: window.location.href,
        hasLoginForm: passwordFields.length > 0,
        passwordFieldCount: passwordFields.length,
        hasCredentialField: credentialFields.length > 0,
        logoCandidates: logo?.getAttribute('src') ? [logo.getAttribute('src')!] : [],
        dominantColors: extractColors(),
        pageKeywords: keywords,
        title: document.title,
        devicePixelRatio: window.devicePixelRatio || 1,
        fontFamily: getComputedStyle(document.body).fontFamily,
        elements: locateElements(passwordFields[0] ?? null, keywords),
      };
    }

    // ── Warning rendering (condition dispatch) ──
    // Renders the participant's assigned condition. The four static
    // conditions each render exactly one thing and nothing else -- assigned to
    // 'banner' means a banner, always, with no escalation and no spotlight.
    // 'progressive' is one self-contained condition whose four stages reuse
    // those same renderers as containers.

    let activeRenderer: Renderer | null = null;
    let activeMonitor: BehaviorMonitor | null = null;
    let activeEngagement: EngagementTracker | null = null;
    /**
     * The last Progressive Reveal stage this visit reached, kept after the
     * monitor is gone.
     *
     * Engagement tracking outlives the warning, so a participant can dismiss
     * at stage 2 and then type. Without this, those later events carry no
     * stage and "of the people who bailed at stage N, how many typed anyway"
     * needs a manual join on visitId to answer.
     *
     * Stays null for banner/modal/tooltip/icon: they have no escalation model,
     * so a stage number would be meaningless there and the field is omitted
     * entirely rather than filled with a placeholder.
     */
    let finalStageReached: number | null = null;

    /**
     * The warning currently on screen, for the pagehide handler. Set whenever
     * a warning is rendered; cleared by teardown. Terminal actions (dismiss /
     * proceed / go back) all teardown, so a participant who acts gets exactly
     * one terminal event; only a warning still active when the page goes away
     * produces `left-page`.
     */
    interface ActiveWarning {
      result: DetectedMessage['result'];
      condition: WarningCondition;
      /** Groups every event of this flagged page-load into one visit. */
      visitId: string;
    }
    let currentWarning: ActiveWarning | null = null;

    /** A per-visit id, stable for the lifetime of this warning. */
    function generateVisitId(): string {
      try {
        return crypto.randomUUID();
      } catch {
        // Non-secure context (plain http on a LAN IP, say) has no randomUUID.
        return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      }
    }

    /** Remove whatever warning UI is on screen, including the spotlight (which
     *  lives outside the renderers' own DOM) and any running monitor. */
    /**
     * Send to the background without ever throwing into the page.
     *
     * A content script outlives its extension whenever the extension is
     * reloaded with the tab still open. From then on `browser.runtime.*`
     * throws "Extension context invalidated" -- and it throws *synchronously*,
     * so attaching `.catch()` is not enough on its own.
     */
    function sendToBackground(message: ExtensionMessage): void {
      try {
        const sent = browser.runtime.sendMessage(message) as Promise<unknown> | undefined;
        void sent?.catch?.(() => {});
      } catch {
        // Stale content script: nothing useful left to do from this page.
      }
    }

    /** Set or clear the toolbar badge (the background owns `action.*`). */
    function setBadge(text: string | null): void {
      sendToBackground({ type: 'SET_BADGE', text } satisfies ExtensionMessage);
    }

    function teardownWarning(): void {
      currentWarning = null;
      activeRenderer?.destroy();
      activeRenderer = null;
      if (activeMonitor) {
        finalStageReached = activeMonitor.currentStage();
        activeMonitor.destroy();
        activeMonitor = null;
      }
      clearHighlight();
      setBadge(null);
      // Engagement tracking deliberately survives this. Dismissing a warning
      // ends the *warning*, not the measurement: what the participant does
      // next -- approach the field, type, submit -- is the study's primary
      // outcome, and is often the most interesting part of the visit.
    }

    /** Stop engagement tracking. Only when the page goes away, or a new
     *  warning replaces this one. */
    function stopEngagement(): void {
      activeEngagement?.destroy();
      activeEngagement = null;
    }

    function renderWarning(result: DetectedMessage['result'], visitId?: string): void {
      console.log('[phish_ext] Warning triggered:', result);
      if (result.riskScore > 0.5) {
        // Full off: never render while protection is disabled (e.g. a verdict
        // computed just before the participant toggled it off).
        void isEnabled()
          .catch(() => true)
          .then((enabled) => {
            if (enabled) void showWarning(result, visitId);
          });
      }
    }

    /** A verdict carrying only the evidence a given stage has revealed. */
    function withEvidence(
      result: DetectedMessage['result'],
      evidence: DetectedMessage['result']['flaggedElements'],
      full: boolean,
    ): DetectedMessage['result'] {
      return {
        ...result,
        flaggedElements: evidence,
        // Until the final stage the participant sees only the reasons for the
        // evidence revealed so far, not the complete write-up.
        reasoning: full
          ? result.reasoning
          : evidence.map((f) => [f.title, f.note].filter(Boolean).join(' — '))
              .filter(Boolean)
              .join(' ')
              .trim() || 'This page may not be safe.',
      };
    }

    async function showWarning(result: DetectedMessage['result'], backgroundVisitId?: string): Promise<void> {
      if (!(await isEnabled().catch(() => true))) return;
      const condition = await resolveCondition();
      if (!condition) {
        // resolveCondition already logged why. Rendering anyway would produce
        // an interaction we cannot attribute to a condition, which is worse
        // for the study than a missing data point.
        return;
      }
      console.log('[phish_ext] Rendering warning (condition:', condition + ')');

      teardownWarning();
      // The visit id is minted by the background when it computed the verdict,
      // so the popup's false-positive report references the same visit. The
      // local generator covers messages predating that field.
      const visitId = backgroundVisitId ?? generateVisitId();
      currentWarning = { result, condition, visitId };

      // Engagement tracking runs for every condition, identically. Whether the
      // participant went for the credentials anyway is the study's primary
      // outcome, so it cannot be measured only where the UI happens to use it.
      // 'submitted' is sent via the background: the page starts unloading on
      // submit, so a storage write from here would not finish.
      stopEngagement();
      finalStageReached = null;
      activeEngagement = createEngagementTracker((signal) => {
        // While the monitor is alive its current stage wins; once it is gone,
        // fall back to the stage this visit reached. Undefined for the static
        // conditions, where neither exists.
        const stage = activeMonitor?.currentStage() ?? finalStageReached ?? undefined;
        if (signal === 'submitted') {
          sendToBackground({
            type: 'SUBMITTED',
            result,
            condition,
            visitId,
            stage,
            url: window.location.href,
          } satisfies ExtensionMessage);
        } else {
          void logInteraction(signal, result, window.location.href, {
            condition,
            visitId,
            stage,
            includeResult: false,
          });
        }
        // Progressive Reveal is the only condition that also *acts* on these.
        activeMonitor?.noteHesitation(signal === 'submitted' ? 'typed' : signal);
      });

      if (condition === 'progressive') {
        await logInteraction('shown', result, window.location.href, { condition, visitId, stage: 1 });
        startProgressiveReveal(result);
        return;
      }

      await logInteraction('shown', result, window.location.href, { condition, visitId });
      activeRenderer = renderers[condition]();
      activeRenderer.show(result, {
        onGoBack: () => {
          teardownWarning();
          void logInteraction('went-back', result, window.location.href, {
            condition,
            visitId,
            includeResult: false,
          });
          sendToBackground({ type: 'GO_BACK' } satisfies ExtensionMessage);
        },
        onProceed: () => {
          teardownWarning();
          void logInteraction('proceeded', result, window.location.href, {
            condition,
            visitId,
            includeResult: false,
          });
        },
        onDismiss: () => {
          teardownWarning();
          void logInteraction('dismissed', result, window.location.href, {
            condition,
            visitId,
            includeResult: false,
          });
        },
      });
    }

    // ── Progressive Reveal: stage containers ──
    // The monitor decides *when* and *how much*; this decides what that looks
    // like, by reusing the same renderers the static conditions use rather
    // than duplicating any rendering per stage.

    function startProgressiveReveal(result: DetectedMessage['result']): void {
      const url = window.location.href;
      const visitId = currentWarning?.visitId ?? generateVisitId();

      /** Terminal actions carry the stage reached -- i.e. how much evidence had
       *  been revealed when the participant acted. This is the measurement the
       *  whole condition exists to produce. */
      const actionsForStage = (stage: EscalationStage) => ({
        onGoBack: () => {
          teardownWarning();
          void logInteraction('went-back', result, url, {
            condition: 'progressive',
            visitId,
            stage,
            includeResult: false,
          });
          sendToBackground({ type: 'GO_BACK' } satisfies ExtensionMessage);
        },
        onProceed: () => {
          teardownWarning();
          void logInteraction('proceeded', result, url, {
            condition: 'progressive',
            visitId,
            stage,
            includeResult: false,
          });
        },
        onDismiss: () => {
          teardownWarning();
          void logInteraction('dismissed', result, url, {
            condition: 'progressive',
            visitId,
            stage,
            includeResult: false,
          });
        },
      });

      const SKIP_RESHOW_MS = 30_000;
      let skipReShowTimer: number | null = null;

      activeMonitor = createBehaviorMonitor({
        flaggedElements: result.flaggedElements,
        // Signals are only possible when the page actually exposes a
        // credential field the detector can see. When it does not, the monitor
        // falls back to letting dwell carry the ladder -- otherwise such a
        // page would dead-end at the first reveal.
        canHesitate: () => credentialField() != null,
        onEscalate: (stage, evidence, trigger) => {
          // One container per stage: replace the previous rather than layering.
          // The highlight layers are NOT torn down here -- highlightEvidence
          // updates them in place, which is what keeps stage transitions from
          // blinking the blur and outlines off and back on.
          if (skipReShowTimer != null) {
            clearTimeout(skipReShowTimer);
            skipReShowTimer = null;
          }
          activeRenderer?.destroy();
          activeRenderer = null;

          const actions = actionsForStage(stage);
          const partial = withEvidence(result, evidence, activeMonitor?.isFinalStage() ?? false);
          // Offer "Next" while evidence remains, so a participant can pull the
          // next piece instead of waiting for escalation to push it. Derived
          // from the stage rather than the monitor handle: this callback runs
          // once before `activeMonitor` has been assigned.
          const onNext = () => activeMonitor?.advance();

          // The badge stays lit for the whole session, at every stage.
          setBadge('!');

          const isFinal = activeMonitor?.isFinalStage() ?? false;

          if (stage === 1) {
            // Watching. Toolbar badge only -- nothing injected into the page,
            // nothing to find and click; escalation is driven by behaviour.
          } else if (!isFinal) {
            // One more piece of evidence, marked on the page. Everything
            // already revealed stays outlined, so the picture builds up.
            const stageOptions = {
              onNext,
              comparison: result.comparison,
              actions,
              // Clears the bubble only -- outlines stay, escalation continues,
              // and nothing is logged, because this is not a decision.
              onSkip: hidePopover,
            };
            highlightEvidence(evidence, stageOptions);

            // Skip re-present loop: once the popover is skipped, the
            // participant is reading the page with only the outlines showing
            // -- and no access to the action buttons. If this stage is still
            // current, re-present its popover after a quiet stretch so
            // Dismiss/Go Back are never out of reach. Re-presenting the same
            // stage advances nothing and logs nothing. The loop re-arms after
            // its guards, so it stops the moment the visit ends or the stage
            // moves (onEscalate clears and re-arms for the new stage) -- a
            // dismissed warning can never be resurrected by it.
            const rePresent = (): void => {
              if (currentWarning?.visitId !== visitId) return;
              if (activeMonitor?.currentStage() !== stage) return;
              if (!isPopoverVisible()) highlightEvidence(evidence, stageOptions);
              skipReShowTimer = window.setTimeout(rePresent, SKIP_RESHOW_MS);
            };
            skipReShowTimer = window.setTimeout(rePresent, SKIP_RESHOW_MS);
          } else {
            // Everything has been shown; now a decision is required. The
            // outlines stay up behind the modal so the evidence is still
            // visible while they choose.
            highlightEvidence(evidence, { outlinesOnly: true });
            activeRenderer = modalRenderer({ detailed: true });
            activeRenderer.show(partial, actions);
          }

          logStage(result, stage, trigger, visitId);
        },
      });
    }

    /** Stage 1 is the monitor starting; later stages are escalations, tagged
     *  by whether the participant was pushed there or asked to go. */
    function logStage(
      result: DetectedMessage['result'],
      stage: EscalationStage,
      trigger: EscalationTrigger,
      visitId: string,
    ): void {
      if (trigger === 'start') return;
      console.log(`[phish_ext] Progressive Reveal -> stage ${stage} (${trigger})`);
      void logInteraction('escalated', result, window.location.href, {
        condition: 'progressive',
        visitId,
        stage,
        trigger,
        includeResult: false,
      });
    }

    // ── Send DOM features to background on load ──

    const features = extractDOMFeatures();
    sendToBackground({
      type: 'PAGE_READY',
      url: window.location.href,
      features,
    } satisfies ExtensionMessage);

    // ── Listen for detection results from background ──

    browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
      if (message.type === 'DETECTED') {
        renderWarning(message.result, message.visitId);
      }
      if (message.type === 'EXTENSION_DISABLED') {
        // Protection turned off mid-visit: drop whatever warning is showing.
        teardownWarning();
        stopEngagement();
      }
      // Background pulls DOM features when it runs the pipeline, rather than
      // relying on the PAGE_READY push (which can race the navigation event).
      if (message.type === 'GET_FEATURES') {
        return Promise.resolve({
          type: 'FEATURES_RESULT',
          features: extractDOMFeatures(),
        } satisfies ExtensionMessage);
      }
    });

    // ── Terminal event when the participant leaves mid-warning ──
    // The most common safe reaction is to just navigate away. That fired no
    // event before: a participant who reacted at the first stage was
    // indistinguishable from one who ignored everything. Fire-and-forget to
    // the background (this context is about to be destroyed, so it can't await
    // a storage write) with the stage reached, if progressive.
    window.addEventListener('pagehide', () => {
      const warning = currentWarning;
      if (!warning) return;
      const stage = activeMonitor ? activeMonitor.currentStage() : undefined;
      teardownWarning();
      stopEngagement();
      sendToBackground({
        type: 'LEFT_PAGE',
        result: warning.result,
        condition: warning.condition,
        visitId: warning.visitId,
        stage,
        url: window.location.href,
      } satisfies ExtensionMessage);
    });
  },
});
