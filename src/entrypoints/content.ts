import type { DOMFeatures, DetectedMessage, ElementLocation, ExtensionMessage } from '@/lib/types';
import { logInteraction } from '@/utils/interaction-log';
import { clearHighlight, highlightEvidence } from '@/utils/driver-highlight';
import {
  createBehaviorMonitor,
  type BehaviorMonitor,
  type EscalationStage,
  type EscalationTrigger,
} from '@/utils/behavior-monitor';
import { renderers, type Renderer } from '@/components/renderers';
import { modalRenderer } from '@/components/renderers/modal';
import { resolveCondition } from '@/utils/condition-assignment';

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
    ]);

    /**
     * Most frequent content words on the page. Same algorithm as
     * `DOM_EXTRACT_JS` in tools/generate.py (title + first 1500 chars of
     * visible text, words of 3+ letters, stop words removed, top 12 by
     * frequency) so these are directly comparable to `BrandReference.keywords`.
     */
    function extractKeywords(): string[] {
      const title = (document.title || '').toLowerCase();
      const body = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, 1500);
      const freq = new Map<string, number>();
      for (const word of `${body} ${title}`.match(/[a-z]{3,}/g) ?? []) {
        if (STOP_WORDS.has(word)) continue;
        freq.set(word, (freq.get(word) ?? 0) + 1);
      }
      return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
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

    /**
     * Dominant background colours, sampled from the same elements
     * tools/generate.py samples so the results are comparable to
     * `BrandReference.colors`.
     */
    function extractColors(): string[] {
      const sources = [
        document.body,
        document.querySelector('header'),
        document.querySelector('nav'),
        document.querySelector('main'),
        document.querySelector('[class*="logo"],[id*="logo"],[class*="brand"],[id*="brand"]'),
      ];
      const colors: string[] = [];
      for (const el of sources) {
        if (!el) continue;
        const hex = rgbToHex(getComputedStyle(el).backgroundColor);
        if (hex && !colors.includes(hex)) colors.push(hex);
        if (colors.length >= 5) break;
      }
      return colors;
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

    /** Locate the elements a warning can point at. */
    function locateElements(passwordField: HTMLElement | null): ElementLocation[] {
      const located: ElementLocation[] = [];

      const logo = findLogo();
      if (logo) {
        located.push({
          selector: buildSelector(logo),
          kind: 'logo',
          detail: logo.getAttribute('src') ?? logo.getAttribute('alt') ?? undefined,
        });
      }

      if (passwordField) {
        located.push({ selector: buildSelector(passwordField), kind: 'password-field' });
        const form = passwordField.closest('form');
        if (form) located.push({ selector: buildSelector(form), kind: 'login-form' });
      }

      located.push(...locateExternalAssets());
      return located;
    }

    function extractDOMFeatures(): DOMFeatures {
      const passwordFields = document.querySelectorAll<HTMLElement>('input[type="password"]');
      const logo = findLogo();
      return {
        url: window.location.href,
        hasLoginForm: passwordFields.length > 0,
        passwordFieldCount: passwordFields.length,
        logoCandidates: logo?.getAttribute('src') ? [logo.getAttribute('src')!] : [],
        dominantColors: extractColors(),
        pageKeywords: extractKeywords(),
        title: document.title,
        elements: locateElements(passwordFields[0] ?? null),
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
      activeRenderer?.destroy();
      activeRenderer = null;
      activeMonitor?.destroy();
      activeMonitor = null;
      clearHighlight();
      setBadge(null);
    }

    function renderWarning(result: DetectedMessage['result']): void {
      console.log('[phish_ext] Warning triggered:', result);
      if (result.riskScore > 0.5) {
        void showWarning(result);
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

    async function showWarning(result: DetectedMessage['result']): Promise<void> {
      const condition = await resolveCondition();
      if (!condition) {
        // resolveCondition already logged why. Rendering anyway would produce
        // an interaction we cannot attribute to a condition, which is worse
        // for the study than a missing data point.
        return;
      }
      console.log('[phish_ext] Rendering warning (condition:', condition + ')');

      teardownWarning();

      if (condition === 'progressive') {
        await logInteraction('shown', result, window.location.href, condition, 1);
        startProgressiveReveal(result);
        return;
      }

      await logInteraction('shown', result, window.location.href, condition);
      activeRenderer = renderers[condition]();
      activeRenderer.show(result, {
        onGoBack: () => {
          teardownWarning();
          void logInteraction('went-back', result, window.location.href, condition);
          sendToBackground({ type: 'GO_BACK' } satisfies ExtensionMessage);
        },
        onProceed: () => {
          teardownWarning();
          void logInteraction('proceeded', result, window.location.href, condition);
        },
        onDismiss: () => {
          teardownWarning();
          void logInteraction('dismissed', result, window.location.href, condition);
        },
      });
    }

    // ── Progressive Reveal: stage containers ──
    // The monitor decides *when* and *how much*; this decides what that looks
    // like, by reusing the same renderers the static conditions use rather
    // than duplicating any rendering per stage.

    function startProgressiveReveal(result: DetectedMessage['result']): void {
      const url = window.location.href;

      /** Terminal actions carry the stage reached -- i.e. how much evidence had
       *  been revealed when the participant acted. This is the measurement the
       *  whole condition exists to produce. */
      const actionsForStage = (stage: EscalationStage) => ({
        onGoBack: () => {
          teardownWarning();
          void logInteraction('went-back', result, url, 'progressive', stage);
          sendToBackground({ type: 'GO_BACK' } satisfies ExtensionMessage);
        },
        onProceed: () => {
          teardownWarning();
          void logInteraction('proceeded', result, url, 'progressive', stage);
        },
        onDismiss: () => {
          teardownWarning();
          void logInteraction('dismissed', result, url, 'progressive', stage);
        },
      });

      activeMonitor = createBehaviorMonitor({
        flaggedElements: result.flaggedElements,
        onEscalate: (stage, evidence, trigger) => {
          // One container per stage: replace the previous rather than layering.
          activeRenderer?.destroy();
          activeRenderer = null;
          clearHighlight();

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
            highlightEvidence(evidence, onNext);
          } else {
            // Everything has been shown; now a decision is required. The
            // outlines stay up behind the modal so the evidence is still
            // visible while they choose.
            highlightEvidence(evidence);
            activeRenderer = modalRenderer();
            activeRenderer.show(partial, actions);
          }

          logStage(result, stage, trigger);
        },
      });
    }

    /** Stage 1 is the monitor starting; later stages are escalations, tagged
     *  by whether the participant was pushed there or asked to go. */
    function logStage(
      result: DetectedMessage['result'],
      stage: EscalationStage,
      trigger: EscalationTrigger,
    ): void {
      if (trigger === 'start') return;
      console.log(`[phish_ext] Progressive Reveal -> stage ${stage} (${trigger})`);
      void logInteraction('escalated', result, window.location.href, 'progressive', stage);
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
        renderWarning(message.result);
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
  },
});
