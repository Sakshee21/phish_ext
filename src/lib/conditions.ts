/**
 * The warning conditions compared by the evaluation study.
 *
 * This module is the shared contract only -- the type, the list, and display
 * labels. *Which* condition a given participant gets is decided once per
 * install by `utils/condition-assignment`, which is also the only place
 * allowed to write it.
 *
 * The study is between-subjects: a participant sees exactly one of these for
 * the whole study. Progressive Reveal is a single self-contained condition
 * whose ladder length is derived from the verdict (one watching stage, one
 * reveal stage per piece of evidence, one confirmation) -- it composes the
 * evidence spotlight and the final modal, but a participant assigned to it
 * never experiences the other conditions, and a participant assigned to (say)
 * 'banner' never escalates to anything else.
 */

export type WarningCondition = 'banner' | 'modal' | 'tooltip' | 'icon' | 'progressive';

export const WARNING_CONDITIONS: readonly WarningCondition[] = ['banner', 'modal', 'tooltip', 'icon', 'progressive'];

export const WARNING_CONDITION_LABELS: Record<WarningCondition, string> = {
  banner: 'Banner',
  modal: 'Modal',
  tooltip: 'Tooltip',
  icon: 'Passive icon',
  progressive: 'Progressive Reveal',
};

export function isWarningCondition(value: unknown): value is WarningCondition {
  return typeof value === 'string' && (WARNING_CONDITIONS as readonly string[]).includes(value);
}
