import './style.css';
import {
  getAssignment,
  getParticipantId,
  type ConditionAssignment,
} from '@/utils/condition-assignment';
import type { InteractionEvent, InteractionEventType } from '@/utils/interaction-log';
import { buildLogExport } from '@/utils/log-export';
import { groupVisits, type Visit } from '@/utils/visits';
import {
  WARNING_CONDITIONS,
  WARNING_CONDITION_LABELS,
} from '@/lib/conditions';

/**
 * Study log viewer.
 *
 * A transparency page, opened from the popup, that lets a participant see
 * everything the extension has recorded about them -- and hand it to a
 * researcher as JSON. The privacy contract is the whole point: the record
 * lives only in storage.local, nothing is transmitted, and the participant
 * triggers the only export. Color carries meaning in the table: safe
 * reactions (went-back, left-page) read green/teal, ignoring/dangerous ones
 * (proceeded) red, neutral ones (dismissed) slate.
 */

const TYPE_META: Record<InteractionEventType, { label: string; color: string }> = {
  shown: { label: 'Warning shown', color: 'var(--study)' },
  escalated: { label: 'Escalated', color: 'var(--amber)' },
  approached: { label: 'Approached field', color: 'var(--violet)' },
  focused: { label: 'Focused password', color: 'var(--orange)' },
  typed: { label: 'Typed in password', color: 'var(--fuchsia)' },
  // The worst outcome the study can record: credentials actually handed over
  // on a flagged page. Red, alongside 'proceeded'.
  submitted: { label: 'Submitted credentials', color: 'var(--red)' },
  dismissed: { label: 'Dismissed', color: 'var(--slate)' },
  proceeded: { label: 'Proceeded anyway', color: 'var(--red)' },
  'went-back': { label: 'Went back', color: 'var(--ok)' },
  'left-page': { label: 'Left page', color: 'var(--teal)' },
};
const TYPE_ORDER: InteractionEventType[] = [
  'shown',
  'escalated',
  'approached',
  'focused',
  'typed',
  'submitted',
  'dismissed',
  'proceeded',
  'went-back',
  'left-page',
];

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function td(className: string, text?: string, extraClass?: string): HTMLElement {
  const cell = document.createElement('td');
  cell.className = extraClass ? `${className} ${extraClass}` : className;
  if (text != null) cell.textContent = text;
  return cell;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── DOM refs ──
const fromInput = $('input#filter-from') as HTMLInputElement;
const toInput = $('input#filter-to') as HTMLInputElement;
const typeSelect = $('select#filter-type') as HTMLSelectElement;
const conditionSelect = $('select#filter-condition') as HTMLSelectElement;
const searchInput = $('input#filter-search') as HTMLInputElement;
const tbody = $('tbody#event-body');
const totalEvents = $('#total-events');
const totalVisits = $('#total-visits');
const dateRange = $('#date-range');
const legend = $('#legend');
const countNote = $('#count-note');
const droppedNote = $('#dropped-note');
const emptyState = $('#empty-state');
const emptyCopy = $('#empty-copy');
const idEl = $('code#participant-id');
const conditionBadge = $('.condition-badge');
const copyBtn = $('#copy-id');
const refreshBtn = $('#refresh-btn');
const clearBtn = $('#clear-btn');
const shareBtn = $('#share-btn') as HTMLButtonElement;
const shareStatus = $('#share-status');
const exportBtn = $('#export-btn');
const exportModal = $('#export-modal');
const modalPanel = $('#export-modal-panel');
const modalMeta = $('#modal-meta');
const modalSize = $('#modal-size');
const jsonPreview = $('#json-preview');
const modalClose = $('#modal-close');
const copyJsonBtn = $('#copy-json-btn');
const downloadBtn = $('#download-btn');

// ── State ──
let events: InteractionEvent[] = [];
let participantId: string | null = null;
let assignment: ConditionAssignment | null = null;

function populateSelects(): void {
  const typeAll = document.createElement('option');
  typeAll.value = '';
  typeAll.textContent = 'All events';
  typeSelect.append(typeAll);
  for (const t of TYPE_ORDER) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = TYPE_META[t].label;
    typeSelect.append(opt);
  }

  const condAll = document.createElement('option');
  condAll.value = '';
  condAll.textContent = 'All conditions';
  conditionSelect.append(condAll);
  for (const c of WARNING_CONDITIONS) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = WARNING_CONDITION_LABELS[c];
    conditionSelect.append(opt);
  }
}

function renderLegend(): void {
  legend.innerHTML = '';
  for (const t of TYPE_ORDER) {
    const item = el('span', 'legend-item');
    const dot = el('span', 'legend-dot');
    dot.style.background = TYPE_META[t].color;
    item.append(dot, document.createTextNode(TYPE_META[t].label));
    legend.append(item);
  }
}

async function renderIdentity(): Promise<void> {
  participantId = await getParticipantId();
  idEl.textContent = participantId ?? '—';
  assignment = await getAssignment();
  conditionBadge.textContent = assignment
    ? WARNING_CONDITION_LABELS[assignment.condition]
    : 'Not yet assigned';
}

function applyFilters(list: InteractionEvent[]): InteractionEvent[] {
  const from = fromInput.valueAsDate;
  const to = toInput.valueAsDate;
  const type = typeSelect.value;
  const condition = conditionSelect.value;
  const q = searchInput.value.trim().toLowerCase();

  return list.filter((e) => {
    if (type && e.type !== type) return false;
    if (condition && e.condition !== condition) return false;
    if (from) {
      const fromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
      if (e.ts < fromMs) return false;
    }
    if (to) {
      const toMs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();
      if (e.ts > toMs) return false;
    }
    if (q) {
      const hay = `${e.url} ${e.matchedBrand ?? ''} ${e.condition ?? ''} ${TYPE_META[e.type].label}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Events that can be grouped into a visit (those carrying a visitId). */
function eligibleEvents(): InteractionEvent[] {
  return events.filter((e) => e.visitId);
}

function renderSummary(): void {
  const eligible = eligibleEvents();
  const dropped = events.length - eligible.length;
  totalEvents.textContent = String(eligible.length);
  totalVisits.textContent = String(groupVisits(eligible).length);
  droppedNote.textContent = dropped > 0
    ? `${dropped} event${dropped === 1 ? '' : 's'} from an older version ignored`
    : '';
  if (eligible.length === 0) {
    dateRange.textContent = '—';
    return;
  }
  const times = eligible.map((e) => e.ts);
  dateRange.textContent = `${formatDay(new Date(Math.min(...times)))} – ${formatDay(new Date(Math.max(...times)))}`;
}

/** Number of events currently passing the filters (used by count/export). */
function filteredEventCount(): number {
  return applyFilters(events).length;
}

function render(): void {
  const filtered = applyFilters(events).sort((a, b) => b.ts - a.ts);
  const shownEvents = filtered.filter((e) => e.visitId);
  const visits = groupVisits(filtered, events);
  tbody.innerHTML = '';
  expandedRow = null;

  for (const visit of visits) {
    tbody.append(buildVisitHeaderRow(visit));
    for (const e of visit.events) {
      tbody.append(buildEventRow(e));
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  countNote.textContent =
    `${plural(visits.length, 'visit')} · ${plural(shownEvents.length, 'event')} of ${eligibleEvents().length}`;
  emptyState.hidden = visits.length !== 0;
  emptyCopy.textContent =
    events.length === 0
      ? 'No warnings have been recorded on this device yet. They appear here as they happen.'
      : eligibleEvents().length === 0
        ? 'All recorded events are from an older version and were ignored. Clear history to start fresh.'
        : 'No events match your filters. Try widening the date range or clearing the search.';
  exportBtn.textContent = visits.length
    ? `Review & export (${plural(visits.length, 'visit')})`
    : 'Review & export';
}

/** A single event row inside a visit section. Clicking expands its detail. */
function buildEventRow(e: InteractionEvent): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'event-row';
  tr.tabIndex = 0;
  tr.setAttribute('aria-expanded', 'false');

  const expandCell = td('col-expand');
  const chevron = el('span', 'chevron');
  chevron.textContent = '▸';
  chevron.setAttribute('aria-hidden', 'true');
  expandCell.append(chevron);
  tr.append(expandCell);

  const timeCell = td('col-time', formatTime(e.ts));
  tr.append(timeCell);

  const meta = TYPE_META[e.type];
  const typeCell = td('col-type');
  const badge = el('span', 'event-type');
  const dot = el('span', 'type-dot');
  dot.style.background = meta.color;
  badge.append(dot, document.createTextNode(meta.label));
  typeCell.append(badge);
  tr.append(typeCell);

  tr.append(
    td('col-condition', e.condition ? WARNING_CONDITION_LABELS[e.condition] : '—', 'condition-cell'),
  );
  tr.append(td('col-stage', e.stage != null ? String(e.stage) : '—', 'stage-cell'));
  tr.append(td('col-brand', e.matchedBrand ?? '—', 'brand-cell'));
  tr.append(td('col-risk', `${Math.round(e.riskScore * 100)}%`, 'risk-cell'));

  const pageCell = td('col-page');
  const link = document.createElement('a');
  link.className = 'page-cell';
  link.textContent = e.url;
  link.href = e.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = e.url;
  link.addEventListener('click', (event) => event.stopPropagation());
  pageCell.append(link);
  tr.append(pageCell);

  const toggle = () => toggleRow(tr, chevron, e);
  tr.addEventListener('click', toggle);
  tr.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  return tr;
}

/** A visit's summary row; clicking it collapses/expands that visit's events. */
function buildVisitHeaderRow(visit: Visit): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'visit-row';
  tr.tabIndex = 0;
  tr.setAttribute('aria-expanded', 'true');

  const cell = document.createElement('td');
  cell.colSpan = 8;

  const head = el('div', 'visit-head');
  const chevron = el('span', 'chevron');
  chevron.textContent = '▾';
  chevron.setAttribute('aria-hidden', 'true');
  head.append(chevron);

  const main = el('div', 'visit-main');

  const titleLine = el('div', 'visit-title-line');
  const brand = textEl('span', 'visit-brand', visit.matchedBrand ?? 'Unknown brand');
  const page = document.createElement('a');
  page.className = 'visit-page';
  page.textContent = visit.url;
  page.href = visit.url;
  page.target = '_blank';
  page.rel = 'noopener noreferrer';
  page.title = visit.url;
  page.addEventListener('click', (event) => event.stopPropagation());
  titleLine.append(brand, page);
  titleLine.append(textEl('span', 'visit-time', formatTime(visit.firstShownAt)));
  if (visit.condition) {
    titleLine.append(textEl('span', 'visit-condition', WARNING_CONDITION_LABELS[visit.condition]));
  }
  main.append(titleLine);

  main.append(buildVisitChips(visit));

  head.append(main);
  cell.append(head);
  tr.append(cell);

  const toggle = () => toggleVisit(tr, chevron);
  tr.addEventListener('click', toggle);
  tr.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  return tr;
}

function chip(parent: HTMLElement, text: string): void {
  parent.append(textEl('span', 'visit-chip', text));
}

/** Per-visit metric chips (response time, engagement, stages, signals…). */
function buildVisitChips(visit: Visit): HTMLElement {
  const chips = el('div', 'visit-metrics');
  const m = visit.metrics;
  const secs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

  chip(chips, `react ${secs(m.timeToReactMs)}`);
  chip(chips, `engaged ${secs(m.engagedMs)}`);
  if (m.stagesReached != null) chip(chips, `stage ${m.stagesReached}`);
  if (m.escalationCount > 0) {
    chip(chips, `${m.escalationCount} escalation${m.escalationCount === 1 ? '' : 's'}`);
  }
  if (m.manualAdvances > 0) chip(chips, `manual ×${m.manualAdvances}`);
  if (m.timeToFirstSignalMs != null) chip(chips, `first signal ${secs(m.timeToFirstSignalMs)}`);
  if (m.approachCount > 0) chip(chips, `approached ×${m.approachCount}`);
  if (m.focusCount > 0) chip(chips, `focused ×${m.focusCount}`);
  if (m.typedCount > 0) chip(chips, `typed ×${m.typedCount}`);
  if (m.submittedCount > 0) chip(chips, `submitted ×${m.submittedCount}`);

  if (m.terminalType) {
    const meta = TYPE_META[m.terminalType];
    const badge = el('span', 'visit-terminal');
    const dot = el('span', 'type-dot');
    dot.style.background = meta.color;
    badge.append(dot, document.createTextNode(meta.label));
    chips.append(badge);
  }
  if (!visit.complete) chip(chips, 'filtered view');

  return chips;
}

/** Collapse/expand a visit's event rows (siblings until the next visit row). */
function toggleVisit(tr: HTMLTableRowElement, chevron: HTMLElement): void {
  const isOpen = tr.getAttribute('aria-expanded') === 'true';
  let sibling = tr.nextElementSibling;
  while (sibling && !sibling.classList.contains('visit-row')) {
    if (isOpen) {
      // Collapsing: if an event detail is open inside, close it too.
      if (expandedRow && sibling === expandedRow.row) {
        expandedRow.row.setAttribute('aria-expanded', 'false');
        expandedRow.chevron.textContent = '▸';
        expandedRow.row.nextElementSibling?.remove();
        expandedRow = null;
      }
      (sibling as HTMLElement).style.display = 'none';
    } else {
      (sibling as HTMLElement).style.display = '';
    }
    sibling = sibling.nextElementSibling;
  }
  tr.setAttribute('aria-expanded', String(!isOpen));
  chevron.textContent = isOpen ? '▸' : '▾';
}

// ── Expandable detail rows ──
// Clicking a row opens the detection detail behind that warning (signals,
// flagged elements, reasoning). Only one row is open at a time.

let expandedRow: { row: HTMLElement; chevron: HTMLElement } | null = null;

function toggleRow(row: HTMLElement, chevron: HTMLElement, e: InteractionEvent): void {
  const isOpen = expandedRow?.row === row;
  if (expandedRow) {
    expandedRow.row.setAttribute('aria-expanded', 'false');
    expandedRow.chevron.textContent = '▸';
    expandedRow.row.nextElementSibling?.remove();
    expandedRow = null;
  }
  if (isOpen) return;

  const detailRow = document.createElement('tr');
  detailRow.className = 'detail-row';
  const cell = document.createElement('td');
  cell.colSpan = 8;
  cell.append(renderDetail(e));
  detailRow.append(cell);

  row.insertAdjacentElement('afterend', detailRow);
  row.setAttribute('aria-expanded', 'true');
  chevron.textContent = '▾';
  expandedRow = { row, chevron };
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function line(label: string, value: string): HTMLElement {
  const rowEl = el('div', 'detail-line');
  rowEl.append(textEl('span', 'detail-label', label), textEl('span', 'detail-value', value || '—'));
  return rowEl;
}

function renderDetail(e: InteractionEvent): HTMLElement {
  const panel = el('div', 'detail-panel');
  const result = e.result;
  if (!result) {
    panel.append(textEl(
      'div',
      'detail-muted',
      e.type === 'approached' || e.type === 'focused' || e.type === 'typed'
        ? 'An engagement signal — the participant headed for the credentials despite the warning.'
        : 'The detection detail is recorded once per visit — see this visit\u2019s first event.',
    ));
    return panel;
  }

  const signals = result.signals;
  if (signals) {
    const grid = el('div', 'detail-grid');

    const visual = el('div', 'detail-card');
    visual.append(textEl('div', 'detail-card-title', 'Visual · Layer 1'));
    visual.append(line('pHash', signals.phash ?? ''));
    visual.append(line('distance', signals.visualDistance != null ? `${signals.visualDistance} / 64 bits` : ''));
    grid.append(visual);

    const text = el('div', 'detail-card');
    text.append(textEl('div', 'detail-card-title', 'Text · Layer 3'));
    const nameValue = signals.nameMatch
      ? signals.nameMatch === 'exact'
        ? 'exact match'
        : signals.nameMatch === 'context'
          ? 'context (brand unnamed in text)'
          : `lookalike "${signals.lookalike?.pageWord}" ≈ "${signals.lookalike?.brandToken}"`
      : '';
    text.append(line('name match', nameValue));
    text.append(line(
      'keywords',
      signals.matchedKeywords?.length ? signals.matchedKeywords.slice(0, 6).join(', ') : '',
    ));
    grid.append(text);

    const domain = signals.domain;
    if (domain) {
      const card = el('div', 'detail-card');
      card.append(textEl('div', 'detail-card-title', 'Domain · Layer 2'));
      card.append(line('host', domain.hostname));
      card.append(line(
        'flag',
        domain.flagReason === 'typosquatting' ? 'typosquatting'
          : domain.flagReason === 'domain_mismatch' ? 'domain mismatch' : '',
      ));
      card.append(line('matches', domain.matchedAllowedDomain ?? ''));
      card.append(line('distance', domain.distance != null ? `${domain.distance} edits` : ''));
      grid.append(card);
    }

    panel.append(grid);
  }

  if (result.flaggedElements?.length) {
    const list = document.createElement('ul');
    list.className = 'detail-elements';
    for (const f of result.flaggedElements) {
      const li = document.createElement('li');
      li.append(textEl('span', 'detail-element-title', f.title ?? f.element));
      if (f.note) li.append(textEl('span', 'detail-element-note', f.note));
      list.append(li);
    }
    const section = el('div', 'detail-section');
    section.append(textEl('div', 'detail-section-title', 'What gave it away'));
    section.append(list);
    panel.append(section);
  }

  if (result.reasoning) {
    const section = el('div', 'detail-section');
    section.append(textEl('div', 'detail-section-title', 'Reasoning'));
    section.append(textEl('div', 'detail-paragraph', result.reasoning));
    panel.append(section);
  }

  if (result.comparison) {
    const c = result.comparison;
    const section = el('div', 'detail-section');
    section.append(textEl('div', 'detail-section-title', 'The real site'));

    const compare = el('div', 'detail-compare');
    compare.append(textEl('span', 'detail-chip-bad', c.actualDomain));
    compare.append(textEl('span', 'detail-vs', 'vs'));
    compare.append(textEl('span', 'detail-chip-good', c.officialDomain));
    section.append(compare);

    if (c.colors?.length) {
      const swatches = el('div', 'detail-swatches');
      for (const color of c.colors.slice(0, 5)) {
        const swatch = el('span', 'detail-swatch');
        swatch.style.background = color;
        swatches.append(swatch);
      }
      section.append(swatches);
    }

    panel.append(section);
  }

  return panel;
}

async function load(): Promise<void> {
  const stored = await browser.storage.local.get('phish_interactions');
  events = Array.isArray(stored.phish_interactions) ? stored.phish_interactions : [];
  renderSummary();
  render();
}

function exportFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  const shortId = (participantId ?? 'unknown').slice(0, 8);
  return `phish-study-${shortId}-${date}.json`;
}

/** Serialize the payload exactly as it will be previewed, copied, and saved. */
function buildPreviewJson(): string {
  const filtered = applyFilters(events).sort((a, b) => b.ts - a.ts);
  const visits = groupVisits(filtered, events);
  const payload = buildLogExport({
    visits,
    participantId,
    conditionAssignment: assignment,
    extensionVersion: browser.runtime.getManifest().version,
  });
  return JSON.stringify(payload, null, 2);
}

function downloadString(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Export preview modal ──
// The participant sees the exact JSON before it leaves the browser. Preview,
// copy, and download all share one serialized string, so what they reviewed is
// byte-for-byte what they keep.

let previewJson: string | null = null;

function openExportPreview(): void {
  previewJson = buildPreviewJson();
  const visitCount = groupVisits(applyFilters(events), events).length;
  const eventCount = filteredEventCount();
  const sizeKb = (new Blob([previewJson]).size / 1024).toFixed(1);

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  jsonPreview.textContent = previewJson;
  modalMeta.textContent = `${plural(visitCount, 'visit')} · ${plural(eventCount, 'event')} · current filters`;
  modalSize.textContent = `${sizeKb} KB · ${exportFilename()}`;

  exportModal.hidden = false;
  document.body.style.overflow = 'hidden';
  modalPanel.focus();
}

function closeExportPreview(): void {
  if (exportModal.hidden) return;
  exportModal.hidden = true;
  document.body.style.overflow = '';
  exportBtn.focus();
}

copyBtn.addEventListener('click', async () => {
  if (!participantId) return;
  try {
    await navigator.clipboard.writeText(participantId);
    copyBtn.textContent = 'Copied';
    copyBtn.setAttribute('aria-pressed', 'true');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.removeAttribute('aria-pressed');
    }, 1500);
  } catch {
    copyBtn.textContent = 'Copy failed';
  }
});

refreshBtn.addEventListener('click', () => void load());

// ── Send to study ──
// Uploads the exact reviewed payload straight to the submission site using the
// Google account via chrome.identity (no separate sign-in step for the
// participant). The site's /api/upload verifies the Google token and attributes
// the upload by email.

/** Submission site origin (injected at build time from wxt.config). */
const submissionSite = (import.meta.env as Record<string, string | undefined>).WXT_SUBMISSION_SITE ?? '';

function setShareStatus(text: string, isError = false): void {
  shareStatus.textContent = text;
  shareStatus.classList.toggle('is-error', isError);
}

if (!submissionSite) {
  shareBtn.disabled = true;
  shareBtn.title = 'Submission site not configured';
}

shareBtn.addEventListener('click', async () => {
  if (!submissionSite) return;

  /** Upload once with a given token; returns true on success. */
  const attempt = async (token: string): Promise<boolean> => {
    const res = await fetch(`${submissionSite}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ file: buildPreviewJson() }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error ?? 'Upload failed.');
    return true;
  };

  const send = async (): Promise<void> => {
    shareBtn.disabled = true;
    shareBtn.textContent = 'Uploading…';
    setShareStatus('');
    try {
      const first = await browser.identity.getAuthToken({ interactive: true });
      if (!first.token) throw new Error('Google sign-in returned no token.');
      try {
        await attempt(first.token);
      } catch (err) {
        // A cached token may predate the email scope. Drop it and re-request
        // once so the participant gets a fresh consent, then retry.
        const msg = err instanceof Error ? err.message : String(err);
        if (/session|invalid|token/i.test(msg)) {
          await browser.identity.removeCachedAuthToken({ token: first.token });
          const fresh = await browser.identity.getAuthToken({ interactive: true });
          if (!fresh.token) throw new Error('Google sign-in returned no token.');
          await attempt(fresh.token);
        } else {
          throw err;
        }
      }
      shareBtn.textContent = 'Uploaded ✓';
      setShareStatus('Uploaded to the study.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      shareBtn.textContent = 'Retry';
      setShareStatus(
        /OAuth|identity|permission/i.test(msg)
          ? `${msg} — check the extension\u2019s Google OAuth client setup.`
          : msg,
        true,
      );
    } finally {
      shareBtn.disabled = false;
    }
  };

  void send();
});

// ── Clear history ──
// Participant-facing reset: deletes the interaction log only -- the condition
// assignment and participant ID survive, so a cleared profile is still
// attributable. Two-step confirm (arm, then confirm within 4s).

let clearArmed = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function resetClearButton(): void {
  clearArmed = false;
  clearBtn.textContent = 'Clear history';
  clearBtn.removeAttribute('aria-pressed');
  if (clearTimer != null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

clearBtn.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = 'Confirm clear?';
    clearBtn.setAttribute('aria-pressed', 'true');
    clearTimer = setTimeout(resetClearButton, 4000);
    return;
  }
  resetClearButton();
  try {
    await browser.storage.local.remove('phish_interactions');
    events = [];
    renderSummary();
    render();
  } catch (err) {
    console.error('[phish_ext] Failed to clear history:', err);
  }
});

exportBtn.addEventListener('click', openExportPreview);

downloadBtn.addEventListener('click', () => {
  if (!previewJson) return;
  downloadString(exportFilename(), previewJson);
});

copyJsonBtn.addEventListener('click', async () => {
  if (!previewJson) return;
  try {
    await navigator.clipboard.writeText(previewJson);
    copyJsonBtn.textContent = 'Copied';
    copyJsonBtn.classList.add('is-copied');
    setTimeout(() => {
      copyJsonBtn.textContent = 'Copy';
      copyJsonBtn.classList.remove('is-copied');
    }, 1500);
  } catch {
    copyJsonBtn.textContent = 'Copy failed';
  }
});

modalClose.addEventListener('click', closeExportPreview);
exportModal.addEventListener('click', (event) => {
  if (event.target === exportModal) closeExportPreview();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !exportModal.hidden) closeExportPreview();
});

void (async () => {
  populateSelects();
  renderLegend();
  await renderIdentity();
  await load();

  [fromInput, toInput, typeSelect, conditionSelect, searchInput].forEach((el) =>
    el.addEventListener('input', render),
  );

  // Live-update while the page is open, so a warning recorded in another tab
  // shows up without a manual refresh.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.phish_interactions) void load();
    if (changes.phish_condition_assignment || changes.phish_participant) void renderIdentity();
  });
})();
