import './style.css';

const statusDot = document.querySelector<HTMLSpanElement>('#status-dot')!;
const statusLabel = document.querySelector<HTMLSpanElement>('#status-label')!;
const scanCount = document.querySelector<HTMLSpanElement>('#scan-count')!;
const threatCount = document.querySelector<HTMLSpanElement>('#threat-count')!;
const conditionSelect = document.querySelector<HTMLSelectElement>('#condition-select')!;
const openLogsBtn = document.querySelector<HTMLButtonElement>('#open-logs')!;
const versionEl = document.querySelector<HTMLElement>('#version')!;

import { WARNING_CONDITIONS, WARNING_CONDITION_LABELS, isWarningCondition } from '@/lib/conditions';
import { DEV_MODE, resolveCondition, setConditionForDev } from '@/utils/condition-assignment';
import type { ExtensionMessage, TabVerdict } from '@/lib/types';

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

function summarize(events: Array<{ type?: string; riskScore?: number; url?: string }>): { scans: number; threats: number } {
  const threats = new Set<string>();
  // A "scan" is one flagged page-load (the `shown` event of a visit). Counting
  // every event would inflate the number with escalations and engagement
  // micro-events, which are per-visit detail, not scans.
  let scans = 0;
  for (const e of events) {
    if (e.type === 'shown') scans++;
    if (typeof e.riskScore === 'number' && e.riskScore > 0.5 && typeof e.url === 'string') {
      threats.add(e.url);
    }
  }
  return { scans, threats: threats.size };
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

// ── Open the study-log viewer in a new tab ──
// The participant's own record is a transparency page (logs.html), never
// something pushed out of the browser. This opens it on demand.
openLogsBtn.addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('/logs.html') }).catch(() => {});
});

// ── False-positive reporting ──
// Shown only when the active tab's current page was flagged with a warning:
// the participant disagrees, one click sends the verdict to the researcher's
// review queue via the submission site. One report per visit.

const reportSection = document.querySelector<HTMLElement>('#report')!;
const reportBrand = document.querySelector<HTMLSpanElement>('#report-brand')!;
const reportHost = document.querySelector<HTMLSpanElement>('#report-host')!;
const reportBtn = document.querySelector<HTMLButtonElement>('#report-btn')!;
const reportStatus = document.querySelector<HTMLElement>('#report-status')!;

/** The submission site origin injected at build time (wxt.config.ts). */
const submissionSite = (import.meta.env as Record<string, string | undefined>).WXT_SUBMISSION_SITE ?? '';

function setReportStatus(text: string, isError = false): void {
  reportStatus.textContent = text;
  reportStatus.classList.toggle('is-error', isError);
}

function setReportedState(): void {
  reportBtn.disabled = true;
  reportBtn.textContent = 'Reported ✓';
}

async function initReport(): Promise<void> {
  // No site configured (a local build without one): the button can do
  // nothing, so it stays hidden rather than collecting silent failures.
  if (!submissionSite) return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  const res = (await browser.runtime.sendMessage({
    type: 'GET_TAB_STATUS',
    tabId: tab.id,
  } satisfies ExtensionMessage)) as { type?: string; entry?: TabVerdict | null };
  const entry = res?.type === 'TAB_STATUS' ? res.entry : null;

  // Only a flagged page can be a false positive; anything else leaves the
  // popup exactly as it was. Logged rather than silent: when this fires
  // unexpectedly, the popup console is where the hunt starts.
  if (!entry || !entry.isSuspicious) {
    console.warn(
      '[phish_ext] No reportable verdict for tab',
      tab.id,
      res?.type === 'TAB_STATUS'
        ? '(verdict exists, page was not flagged)'
        : '(no TAB_STATUS answer from the background)',
    );
    return;
  }

  reportSection.hidden = false;
  reportBrand.textContent = entry.matchedBrand ?? 'unknown brand';
  reportHost.textContent = entry.hostname;
  reportHost.title = entry.url;
  if (entry.reported) {
    setReportedState();
    setReportStatus('Already reported — thank you.');
    return;
  }

  reportBtn.addEventListener('click', () => {
    if (tab.id == null) return;
    reportBtn.disabled = true;
    reportBtn.textContent = 'Reporting…';
    setReportStatus('');
    void browser.runtime
      .sendMessage({ type: 'REPORT_FALSE_POSITIVE', tabId: tab.id } satisfies ExtensionMessage)
      .then((raw) => {
        const result = raw as { type?: string; ok?: boolean; error?: string; alreadyReported?: boolean };
        if (result?.type === 'REPORT_RESULT' && result.ok) {
          setReportedState();
          setReportStatus('Sent to the researchers — thank you.');
        } else if (result?.alreadyReported) {
          setReportedState();
          setReportStatus('Already reported — thank you.');
        } else {
          reportBtn.disabled = false;
          reportBtn.textContent = 'Retry';
          setReportStatus(result?.error ?? 'Report failed.', true);
        }
      })
      .catch((err: unknown) => {
        reportBtn.disabled = false;
        reportBtn.textContent = 'Retry';
        setReportStatus(err instanceof Error ? err.message : 'Report failed.', true);
      });
  });
}

async function init(): Promise<void> {
  versionEl.textContent = `v${browser.runtime.getManifest().version}`;
  if (DEV_MODE) {
    const condition = await resolveCondition();
    if (condition) conditionSelect.value = condition;
  }
  await refreshStats();
  await initReport().catch((err: unknown) => {
    // Reporting is best-effort chrome; a failure to even populate it should
    // never take down the rest of the popup.
    console.warn('[phish_ext] Report UI unavailable:', err);
  });
}

void init();