/**
 * Between-subjects condition assignment for the evaluation study.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  READ THIS BEFORE CHANGING ANYTHING IN THIS FILE                     │
 * │                                                                      │
 * │  A participant is randomly assigned ONE warning condition on         │
 * │  install, and must keep it for the entire study. Assignment is       │
 * │  permanent per install and must NEVER be re-triggered mid-study.     │
 * │                                                                      │
 * │  Re-randomising a participant who has already seen warnings does not │
 * │  fail loudly -- it silently produces a participant whose logged      │
 * │  events span two conditions, which is unusable for a between-        │
 * │  subjects comparison and impossible to detect after the fact. The    │
 * │  same hazard applies to "just resetting it for a moment" while       │
 * │  debugging against a real participant's profile.                     │
 * │                                                                      │
 * │  Any change that could re-run assignment -- clearing storage,        │
 * │  changing STORAGE_KEY, adding a "reshuffle" affordance -- invalidates│
 * │  every participant it touches. If you need to switch conditions      │
 * │  while developing, use the dev-only picker (see DEV_MODE) on a       │
 * │  throwaway browser profile, never on a study install.                │
 * └──────────────────────────────────────────────────────────────────────┘
 */

import {
  WARNING_CONDITIONS,
  isWarningCondition,
  type WarningCondition,
} from '@/lib/conditions';

/**
 * Dev-only affordances (the popup's condition picker) are gated on this.
 *
 * True under `pnpm dev`, false under a plain `pnpm build` -- so the study
 * build hides the picker automatically and nobody has to remember a flag.
 *
 * `WXT_DEV_PICKER=true pnpm build` forces it on in a production build, which
 * is for testing the real build without needing the dev server running. The
 * build handed to participants must be a plain `pnpm build`: with the picker
 * present a participant could change their own condition, which mixes their
 * data across conditions exactly as described above.
 */
export const DEV_MODE: boolean =
  import.meta.env.DEV || import.meta.env.WXT_DEV_PICKER === 'true';

const STORAGE_KEY = 'phish_condition_assignment';

/**
 * Per-install participant ID, kept in its own key so the assignment record's
 * shape never changes (tests and study tooling read it directly). Minted once
 * and embedded in log exports so a researcher can attribute exports to the
 * same install across sessions. See ensureParticipantId().
 */
const PARTICIPANT_KEY = 'phish_participant';

export interface ConditionAssignment {
  condition: WarningCondition;
  /** When this participant was assigned, ms since epoch. */
  assignedAt: number;
  /** How it was set: real study assignment, or a dev override. */
  source: 'random' | 'dev-override';
}

function isAssignment(value: unknown): value is ConditionAssignment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ConditionAssignment>;
  return isWarningCondition(v.condition) && typeof v.assignedAt === 'number';
}

function pickRandomCondition(): WarningCondition {
  const index = Math.floor(Math.random() * WARNING_CONDITIONS.length);
  // Math.random() < 1, so index is always in range; the ?? is for the type.
  return WARNING_CONDITIONS[index] ?? WARNING_CONDITIONS[0]!;
}

/**
 * Read the stored assignment.
 *
 * "Never assigned" and "could not read" must stay distinguishable. Collapsing
 * them means a transient storage failure looks like a fresh install, and the
 * participant gets re-randomised on the spot -- silently, and repeatedly. (In
 * practice this happens whenever a content script outlives its extension:
 * every browser.* call throws "Extension context invalidated", so a page would
 * draw a new condition on every single load.)
 */
type AssignmentRead =
  | { status: 'assigned'; assignment: ConditionAssignment }
  | { status: 'unassigned' }
  | { status: 'unavailable' };

async function readAssignment(): Promise<AssignmentRead> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    return isAssignment(value) ? { status: 'assigned', assignment: value } : { status: 'unassigned' };
  } catch (err) {
    console.error('[phish_ext] Could not read condition assignment:', err);
    return { status: 'unavailable' };
  }
}

/**
 * The participant's condition, assigning one at random if this install has
 * never been assigned.
 *
 * Deliberately has no "default" condition. An earlier version fell back to
 * 'banner' when storage was unreadable, which meant a transient storage
 * failure would silently log a progressive-reveal participant's events as
 * banner. Assignment is created once and then only ever read back.
 */
export async function resolveCondition(): Promise<WarningCondition | null> {
  const read = await readAssignment();
  if (read.status === 'assigned') return read.assignment.condition;

  if (read.status === 'unavailable') {
    // Storage is unreachable, so we cannot tell whether this participant is
    // already assigned. Drawing one now would re-randomise them. Give up
    // instead: a missing warning is recoverable, a participant whose events
    // span two conditions is not.
    console.error('[phish_ext] Condition unknown (storage unavailable) - not showing a warning.');
    return null;
  }

  const assignment: ConditionAssignment = {
    condition: pickRandomCondition(),
    assignedAt: Date.now(),
    source: 'random',
  };

  try {
    await browser.storage.local.set({ [STORAGE_KEY]: assignment });
    console.log('[phish_ext] Assigned study condition:', assignment.condition);
  } catch (err) {
    // The draw could not be persisted, so it is not an assignment -- the next
    // load would draw again. Discard it rather than acting on it.
    console.error('[phish_ext] FAILED to persist condition assignment:', err);
    return null;
  }

  return assignment.condition;
}

/**
 * Assign on install if not already assigned. Called from the background
 * service worker so a participant is assigned before they ever hit a flagged
 * page. Safe to call repeatedly -- it never overwrites an existing assignment.
 */
export async function ensureAssigned(): Promise<WarningCondition | null> {
  // Mint the participant ID first (if this install doesn't have one yet) so
  // log exports are attributable even when the condition was already assigned
  // on a previous run. Never overwrites.
  await ensureParticipantId();
  return resolveCondition();
}

/**
 * Read the install's participant ID, or null if it has never been set.
 */
export async function getParticipantId(): Promise<string | null> {
  try {
    const stored = await browser.storage.local.get(PARTICIPANT_KEY);
    const value = stored[PARTICIPANT_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch (err) {
    console.error('[phish_ext] Could not read participant id:', err);
    return null;
  }
}

/**
 * Ensure the install has a participant ID, minting one if missing.
 *
 * Same discipline as the condition assignment: minted once, read back forever,
 * never overwritten -- a participant's logs must all carry the same ID or
 * exports from one person become un-attributable. Safe to call repeatedly.
 */
export async function ensureParticipantId(): Promise<string | null> {
  const existing = await getParticipantId();
  if (existing) return existing;

  try {
    const id = crypto.randomUUID();
    await browser.storage.local.set({ [PARTICIPANT_KEY]: id });
    return id;
  } catch (err) {
    console.error('[phish_ext] FAILED to persist participant id:', err);
    return null;
  }
}

/** The full assignment record, for the dev popup and for study bookkeeping. */
export async function getAssignment(): Promise<ConditionAssignment | null> {
  const read = await readAssignment();
  return read.status === 'assigned' ? read.assignment : null;
}

/**
 * Override the condition. DEV ONLY -- see the warning at the top of this file.
 * No-ops outside dev builds so it cannot be reached in a study build even if
 * something calls it.
 */
export async function setConditionForDev(condition: WarningCondition): Promise<void> {
  if (!DEV_MODE) {
    console.warn('[phish_ext] setConditionForDev ignored: not a dev build');
    return;
  }
  const assignment: ConditionAssignment = {
    condition,
    assignedAt: Date.now(),
    source: 'dev-override',
  };
  await browser.storage.local.set({ [STORAGE_KEY]: assignment });
}
