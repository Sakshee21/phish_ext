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

/** Cursor within this distance (px) of the field counts as having reached it. */
const APPROACH_ENTER_PX = 120;

/**
 * Once 'approached' has fired, the cursor must retreat past this larger radius
 * before another can fire. The gap between the two radii is hysteresis (a
 * Schmitt trigger), and it exists to protect the cross-condition comparison,
 * not just to tidy the logs.
 *
 * With a single threshold, "approached" counts whatever crosses one line -- so
 * a cursor loitering around it emits a burst of signals. That is not evenly
 * distributed across conditions: Progressive Reveal outlines evidence at the
 * field and Tooltip anchors its bubble to it, so in exactly those conditions
 * the participant's reading movement sits on top of the trip line, while Banner
 * and Modal render nothing there and never provoke it. Left unfixed, PR/Tooltip
 * would show structurally higher approach counts for a reason that has nothing
 * to do with intent to type -- a measurement artifact masquerading as a
 * behavioural difference between warning designs.
 *
 * Requiring a clear exit past this radius before re-arming makes one signal
 * mean one genuine approach: cross in, and it will not fire again until the
 * cursor has plainly left. Deliberately going back for the field a second time
 * (out past the re-arm radius, then in again) still counts -- that is a real
 * second approach, not reading jitter.
 */
const APPROACH_REARM_PX = 200;

/** mousemove sampling interval (ms). */
const MOVE_THROTTLE_MS = 150;

/**
 * What counts as a credential field.
 *
 * Not just `input[type=password]`. Real logins are routinely two-step --
 * Shopify, Google and Microsoft all ask for the identifier first and the
 * password on a second screen -- so their clones do too. A page that collects
 * an email under a brand's name is harvesting credentials even though no
 * password box exists yet, and requiring one misses that whole class.
 */
export const CREDENTIAL_SELECTOR = [
  'input[type="password"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
].join(',');

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
export function credentialField(): HTMLElement | null {
  // Password first when there is one -- it is the strongest signal -- then any
  // other credential-identifier field.
  const candidates = [
    ...Array.from(document.querySelectorAll<HTMLElement>('input[type="password"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>(CREDENTIAL_SELECTOR)),
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
  /** Hysteresis latch: can the next in-crossing fire, or must the cursor leave
   *  first? Starts armed so the first genuine approach counts. */
  let approachArmed = true;
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
    const dist = Math.hypot(dx, dy);

    // Fire once when the cursor reaches the field; then stay silent until it has
    // clearly left again (past the wider re-arm radius). The gap between the two
    // radii is what stops reading movement that loiters near the field -- the
    // Progressive Reveal / Tooltip case -- from emitting a stream of signals.
    if (approachArmed && dist <= APPROACH_ENTER_PX) {
      onSignal('approached');
      approachArmed = false;
    } else if (!approachArmed && dist >= APPROACH_REARM_PX) {
      approachArmed = true;
    }
  }

  function onFocusIn(event: FocusEvent): void {
    typedThisFocus = false;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(CREDENTIAL_SELECTOR)) {
      onSignal('focused');
    }
  }

  function onKeyDown(): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches(CREDENTIAL_SELECTOR)) return;
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
    if (form instanceof HTMLElement && form.querySelector(CREDENTIAL_SELECTOR)) {
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
