import type { DOMFeatures, DetectedMessage, ElementLocation, ExtensionMessage } from '@/lib/types';
import { logInteraction } from '@/utils/interaction-log';
import { clearHighlight, highlightFlaggedElements } from '@/utils/driver-highlight';
import { startProgressiveReveal, type ProgressiveRevealHandle } from '@/utils/behavior-monitor';
import { renderers, type Renderer } from '@/components/renderers';
import { getActiveCondition } from '@/lib/conditions';

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
    // Renders the active warning condition (banner/modal/tooltip/icon) or the
    // adaptive Progressive Reveal session, and logs every user action.

    let activeRenderer: Renderer | null = null;
    let activeMonitor: ProgressiveRevealHandle | null = null;

    /** Remove whatever warning UI is on screen: the active renderer, any
     *  Progressive Reveal session, and the Driver.js spotlight (which lives
     *  outside the renderers' own DOM, so it needs clearing separately). */
    function teardownWarning(): void {
      activeRenderer?.destroy();
      activeRenderer = null;
      activeMonitor?.destroy();
      activeMonitor = null;
      clearHighlight();
    }

    function renderWarning(result: DetectedMessage['result']): void {
      console.log('[phish_ext] Warning triggered:', result);
      if (result.riskScore > 0.5) {
        void showWarning(result);
      }
    }

    async function showWarning(result: DetectedMessage['result']): Promise<void> {
      const condition = await getActiveCondition();
      console.log('[phish_ext] Rendering warning (condition:', condition + ')');
      await logInteraction('shown', result, window.location.href, condition);

      teardownWarning();

      // Progressive Reveal is a session (state machine + listeners), not a
      // single renderer.
      if (condition === 'progressive') {
        activeMonitor = startProgressiveReveal(result, condition, window.location.href);
        return;
      }

      activeRenderer = renderers[condition]();
      activeRenderer.show(result, {
        onGoBack: () => {
          teardownWarning();
          void logInteraction('went-back', result, window.location.href, condition);
          browser.runtime
            .sendMessage({ type: 'GO_BACK' } satisfies ExtensionMessage)
            .catch(() => {});
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

      // The Driver.js evidence tour complements banner/icon; modal and tooltip
      // anchor their own elements. Skips the no-op until flags carry selectors
      // (Layer 3).
      if (
        (condition === 'banner' || condition === 'icon') &&
        result.flaggedElements.some((f) => f.selector)
      ) {
        highlightFlaggedElements(result);
      }
    }

    // ── Send DOM features to background on load ──

    const features = extractDOMFeatures();
    browser.runtime.sendMessage<ExtensionMessage>({
      type: 'PAGE_READY',
      url: window.location.href,
      features,
    });

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
