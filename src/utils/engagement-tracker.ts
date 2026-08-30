/**
 * Engagement tracking: is the participant still heading for the credentials
 * despite the warning?
 *
 * Runs for **every** warning condition, not just Progressive Reveal. These
 * signals are the study's primary outcome -- whether someone entered
 * credentials on a flagged page -- so they have to be measured identically
 * across conditions. Detecting them separately per condition would make the
 * comparison meaningless: any difference could then come from the measurement
 * rather than from the warning design.
 *
 * Progressive Reveal additionally *uses* these to decide when to escalate; the
 * other four only log them. That difference is in what consumes the signals,
 * never in how they are detected.
 */

/** Cursor-to-credential-field distance (px) that counts as approaching. */
const APPROACH_PX = 120;

/** mousemove sampling interval (ms). */
const MOVE_THROTTLE_MS = 150;

export type EngagementSignal = 'approached' | 'focused' | 'typed' | 'submitted';

export interface EngagementTracker {
  destroy(): void;
}

/**
 * The *visible* credential field, or null if none is on screen.
 *
 * Visibility matters: a login form inside a collapsed panel still matches the
 * selector but reports its rect at (0,0) with no size, so proximity would
 * quietly become "within 120px of the top-left corner of the window". With no
 * visible field there is no approach to detect, and the signal stays off until
 * the participant opens the form.
 */
function credentialField(): HTMLElement | null {
  const candidates = [
    ...Array.from(document.querySelectorAll<HTMLElement>('input[type="password"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"])')),
  ];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    return el;
  }
  return null;
}

export function createEngagementTracker(
  onSignal: (signal: EngagementSignal) => void,
): EngagementTracker {
  let disposed = false;
  let lastMoveSampledAt = 0;
  let wasNearField = false;
  let typedThisFocus = false;

  function onMove(event: MouseEvent): void {
    const now = Date.now();
    if (now - lastMoveSampledAt < MOVE_THROTTLE_MS) return;
    lastMoveSampledAt = now;

    const field = credentialField();
    if (!field) return;
    const box = field.getBoundingClientRect();
    const dx = Math.max(box.left - event.clientX, 0, event.clientX - box.right);
    const dy = Math.max(box.top - event.clientY, 0, event.clientY - box.bottom);
    const near = Math.hypot(dx, dy) <= APPROACH_PX;

    // Fire on *entering* the zone, not repeatedly while the cursor sits in it.
    if (near && !wasNearField) onSignal('approached');
    wasNearField = near;
  }

  function onFocusIn(event: FocusEvent): void {
    typedThisFocus = false;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('input[type="password"]')) {
      onSignal('focused');
    }
  }

  function onKeyDown(): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches('input[type="password"]')) return;
    // The first keystroke of a focus session, not every key.
    if (typedThisFocus) return;
    typedThisFocus = true;
    onSignal('typed');
  }

  /**
   * Submitting is a different outcome from typing: someone can type and think
   * better of it. Only submission actually hands the credentials over, so the
   * two are recorded separately.
   *
   * Captured on the way down, because the page usually starts unloading right
   * afterwards and a bubbling listener may never run.
   */
  function onSubmit(event: Event): void {
    const form = event.target;
    if (form instanceof HTMLElement && form.querySelector('input[type="password"]')) {
      onSignal('submitted');
    }
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('submit', onSubmit, true);

  return {
    destroy() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('submit', onSubmit, true);
    },
  };
}
