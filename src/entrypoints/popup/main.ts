import './style.css';

const statusDot = document.querySelector<HTMLSpanElement>('#status-dot')!;
const statusLabel = document.querySelector<HTMLSpanElement>('#status-label')!;
const scanCount = document.querySelector<HTMLSpanElement>('#scan-count')!;
const threatCount = document.querySelector<HTMLSpanElement>('#threat-count')!;
const conditionSelect = document.querySelector<HTMLSelectElement>('#condition-select')!;

import { WARNING_CONDITIONS, WARNING_CONDITION_LABELS, isWarningCondition } from '@/lib/conditions';
import { DEV_MODE, resolveCondition, setConditionForDev } from '@/utils/condition-assignment';
import type { ExtensionMessage } from '@/lib/types';

// ── Condition selector (DEV BUILDS ONLY) ──
// Participants are randomly assigned one condition on install and must keep it
// for the whole study, so a picker must never reach them: being able to change
// condition mid-study silently mixes a participant's data across conditions.
// `DEV_MODE` is `import.meta.env.DEV`, so `pnpm build` drops this entirely and
// nobody has to remember to disable it.

const conditionSection = document.querySelector<HTMLElement>('#condition');

if (!DEV_MODE) {
  conditionSection?.remove();
} else {
  for (const condition of WARNING_CONDITIONS) {
    const option = document.createElement('option');
    option.value = condition;
    option.textContent = WARNING_CONDITION_LABELS[condition];
    conditionSelect.append(option);
  }

  conditionSelect.addEventListener('change', () => {
    const value = conditionSelect.value;
    if (!isWarningCondition(value)) return;
    void setConditionForDev(value);
    // Re-run the pipeline so the change takes effect on the current tab
    // instead of on the next navigation.
    browser.runtime.sendMessage({ type: 'RESCAN' } satisfies ExtensionMessage).catch(() => {});
  });
}

// ── Stats from the interaction log ──

function summarize(events: Array<{ riskScore?: number; url?: string }>): { scans: number; threats: number } {
  const threats = new Set<string>();
  for (const e of events) {
    if (typeof e.riskScore === 'number' && e.riskScore > 0.5 && typeof e.url === 'string') {
      threats.add(e.url);
    }
  }
  return { scans: events.length, threats: threats.size };
}

async function refreshStats(): Promise<void> {
  try {
    const stored = await browser.storage.local.get('phish_interactions');
    const events = Array.isArray(stored.phish_interactions) ? stored.phish_interactions : [];
    const { scans, threats } = summarize(events);

    scanCount.textContent = String(scans);
    threatCount.textContent = String(threats);

    if (threats > 0) {
      statusDot.className = 'status-threat';
      statusLabel.textContent = 'Threats flagged';
    } else if (scans > 0) {
      statusDot.className = 'status-safe';
      statusLabel.textContent = 'No threats';
    } else {
      statusDot.className = 'status-idle';
      statusLabel.textContent = 'Idle';
    }
  } catch {
    statusDot.className = 'status-idle';
    statusLabel.textContent = 'Idle';
  }
}

async function init(): Promise<void> {
  if (DEV_MODE) {
    const condition = await resolveCondition();
    if (condition) conditionSelect.value = condition;
  }
  await refreshStats();
}

void init();