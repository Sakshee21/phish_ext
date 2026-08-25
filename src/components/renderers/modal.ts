import type { DetectionResult } from '@/lib/types';
import { comparisonPanel } from './comparison';
import { actionButtons, element } from './shared';
import type { Renderer } from './types';

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

/** The evidence, listed so each item can be read on its own. */
function evidenceList(result: DetectionResult): HTMLElement | null {
  if (result.flaggedElements.length === 0) return null;
  const list = element('ul', 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;');
  result.flaggedElements.forEach((flagged, i) => {
    const marker = element(
      'span',
      'flex:none;width:18px;height:18px;border-radius:50%;background:#b3261e;color:#fff;'
        + `font:600 11px/18px ${FONT};text-align:center;`,
      String(i + 1),
    );
    const body = element(
      'div',
      'display:flex;flex-direction:column;gap:1px;',
      element('div', `font:600 12.5px/1.45 ${FONT};color:#1c1c1c;`, flagged.title ?? flagged.element),
      flagged.note ? element('div', `font:12px/1.45 ${FONT};color:#5f6368;`, flagged.note) : element('span', ''),
    );
    list.append(element('li', 'display:flex;gap:9px;align-items:flex-start;', marker, body));
  });
  return list;
}

/** Full-screen interceptor: forces an explicit choice before the user proceeds. */
export function modalRenderer(): Renderer {
  let root: HTMLElement | null = null;

  return {
    show(result: DetectionResult, actions) {
      const { goBack, proceed } = actionButtons(actions, 'card');
      const evidence = evidenceList(result);
      const count = result.flaggedElements.length;

      const header = element(
        'div',
        'display:flex;align-items:center;gap:10px;margin-bottom:4px;',
        element(
          'span',
          'flex:none;width:30px;height:30px;border-radius:50%;background:#b3261e;color:#fff;'
            + `font:700 17px/30px ${FONT};text-align:center;`,
          '!',
        ),
        element(
          'div',
          `font:700 16px/1.3 ${FONT};color:#b3261e;`,
          result.comparison ? `This is not ${result.comparison.name}` : 'Suspicious page',
        ),
      );

      const card = element(
        'div',
        'max-width:520px;width:calc(100% - 48px);max-height:calc(100vh - 64px);overflow:auto;'
          + 'background:#fff;color:#1c1c1c;border-radius:14px;padding:22px 24px;'
          + `box-shadow:0 18px 50px rgba(0,0,0,0.4);font:13px/1.5 ${FONT};`,
        header,
        element('p', `margin:0 0 4px;font:13px/1.5 ${FONT};color:#3c4043;`, result.reasoning),
        ...(result.comparison ? [comparisonPanel(result.comparison)] : []),
        ...(evidence
          ? [
              element(
                'div',
                `font:600 11px/1.5 ${FONT};text-transform:uppercase;letter-spacing:.04em;color:#5f6368;margin:14px 0 8px;`,
                `What gave it away (${count})`,
              ),
              evidence,
            ]
          : []),
        element('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;', goBack, proceed),
      );
      root = element(
        'div',
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);padding:24px;box-sizing:border-box;',
        card,
      );
      document.body?.append(root);
      document.documentElement.style.overflow = 'hidden';
    },
    destroy() {
      document.documentElement.style.overflow = '';
      root?.remove();
      root = null;
    },
  };
}
