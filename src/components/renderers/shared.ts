import type { DetectionResult } from '@/lib/types';
import type { WarningActions } from './types';

/** Shared DOM helpers + action buttons for the warning renderers. */

const FONT = '13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  for (const child of children) {
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** Build the Go Back / Proceed Anyway / Dismiss buttons for an action row. */
export function actionButtons(
  actions: WarningActions,
  variant: 'red' | 'card' = 'red',
): { goBack: HTMLButtonElement; proceed: HTMLButtonElement; dismiss: HTMLButtonElement } {
  const base = [
    'border:none',
    'border-radius:6px',
    'padding:6px 12px',
    'font:inherit',
    'font-weight:600',
    'cursor:pointer',
    'white-space:nowrap',
  ].join(';');

  const goBack = element('button', `${base};background:#fff;color:#b3261e;`, 'Go Back');
  goBack.addEventListener('click', actions.onGoBack);

  const proceed = element(
    'button',
    `${base};background:rgba(255,255,255,0.2);color:#fff;`,
    'Proceed Anyway',
  );
  proceed.addEventListener('click', actions.onProceed);

  const dismiss = element('button', `${base};background:transparent;color:#fff;font-size:16px;padding:2px 8px;`, '×');
  dismiss.title = 'Dismiss';
  dismiss.addEventListener('click', actions.onDismiss);

  if (variant === 'card') {
    goBack.style.cssText = `${base};background:transparent;color:#b3261e;border:1px solid #b3261e;`;
    proceed.style.cssText = `${base};background:#b3261e;color:#fff;`;
    dismiss.style.cssText = `${base};background:transparent;color:#6b7280;font-size:16px;padding:2px 8px;`;
  }

  return { goBack, proceed, dismiss };
}

/** "Show me more" -- lets the participant pull the next piece of evidence
 *  rather than waiting for escalation to push it. */
export function nextButton(onNext: () => void, variant: 'red' | 'card' = 'red'): HTMLButtonElement {
  const base = [
    'border:none',
    'border-radius:6px',
    'padding:6px 12px',
    'font:inherit',
    'font-weight:600',
    'cursor:pointer',
    'white-space:nowrap',
  ].join(';');
  const style = variant === 'card'
    ? `${base};background:#b3261e;color:#fff;`
    : `${base};background:#fff;color:#b3261e;`;
  const button = element('button', style, 'Next');
  button.title = 'Show the next piece of evidence';
  button.addEventListener('click', onNext);
  return button;
}

export function reasoningElement(result: DetectionResult): HTMLDivElement {
  return element('div', `font:${FONT};`, result.reasoning);
}

export const RED_SURFACE = '#b3261e';
