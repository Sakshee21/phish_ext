import type { DetectionResult } from '@/lib/types';
import { actionButtons, element, nextButton, reasoningElement } from './shared';
import type { Renderer } from './types';

/** Dismissible strip pinned to the top of the page. Non-blocking. */
export function bannerRenderer(): Renderer {
  let banner: HTMLElement | null = null;

  return {
    show(result: DetectionResult, actions) {
      const { goBack, proceed, dismiss } = actionButtons(actions, 'red');
      const next = actions.onNext ? nextButton(actions.onNext, 'red') : null;
      banner = element(
        'div',
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 16px;background:#b3261e;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.4);font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
        reasoningElement(result),
        ...(next ? [next] : []),
        goBack,
        proceed,
        dismiss,
      );
      document.body?.prepend(banner);
    },
    destroy() {
      banner?.remove();
      banner = null;
    },
  };
}
