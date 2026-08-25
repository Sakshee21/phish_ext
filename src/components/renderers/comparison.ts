import type { BrandComparison } from '@/lib/types';
import { element } from './shared';

/**
 * "This page" vs "the real site", side by side.
 *
 * A warning that only asserts a page is fake asks to be taken on faith. Putting
 * the genuine site next to it lets someone check the claim themselves, which is
 * the difference between being told and being shown.
 *
 * The reference image is bundled in brands.json by tools/generate.py -- nothing
 * is fetched at display time, so this works offline and leaks no browsing data.
 */

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

function panelHeading(text: string, tone: 'bad' | 'good'): HTMLElement {
  const dot = element(
    'span',
    `width:7px;height:7px;border-radius:50%;flex:none;background:${tone === 'bad' ? '#b3261e' : '#1e7d34'};`,
  );
  return element(
    'div',
    `display:flex;align-items:center;gap:6px;font:600 11px/1.5 ${FONT};`
      + `text-transform:uppercase;letter-spacing:.04em;color:${tone === 'bad' ? '#b3261e' : '#1e7d34'};`,
    dot,
    text,
  );
}

function domainChip(domain: string, tone: 'bad' | 'good'): HTMLElement {
  const bad = tone === 'bad';
  return element(
    'div',
    `font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;`
      + `padding:5px 8px;border-radius:5px;word-break:break-all;`
      + `background:${bad ? 'rgba(179,38,30,0.08)' : 'rgba(30,125,52,0.08)'};`
      + `color:${bad ? '#8c1d18' : '#155d27'};`
      + `border:1px solid ${bad ? 'rgba(179,38,30,0.25)' : 'rgba(30,125,52,0.25)'};`,
    domain,
  );
}

function thumbnailFrame(src: string, alt: string): HTMLElement {
  const img = element(
    'img',
    'display:block;width:100%;height:auto;border-radius:4px;',
  ) as HTMLImageElement;
  img.src = src;
  img.alt = alt;
  return element('div', 'border:1px solid #d9dfe8;border-radius:5px;overflow:hidden;background:#fff;', img);
}

function colorSwatches(colors: string[]): HTMLElement {
  const row = element('div', 'display:flex;gap:4px;');
  for (const color of colors.slice(0, 5)) {
    row.append(
      element('span', `width:16px;height:16px;border-radius:3px;border:1px solid rgba(0,0,0,0.15);background:${color};`),
    );
  }
  return row;
}

/**
 * Build the comparison. `compact` drops the images and shows only the domains,
 * for the small popovers that annotate individual evidence.
 */
export function comparisonPanel(comparison: BrandComparison, compact = false): HTMLElement {
  const { name, officialDomain, actualDomain, thumbnail, colors } = comparison;

  const suspect = element(
    'div',
    'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;',
    panelHeading('This page', 'bad'),
    domainChip(actualDomain, 'bad'),
  );

  const genuine = element(
    'div',
    'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;',
    panelHeading(`Real ${name}`, 'good'),
    domainChip(officialDomain, 'good'),
  );

  if (!compact && thumbnail) {
    // Only the genuine side has a picture: the suspicious page is already on
    // screen behind this, so showing a screenshot of it would be redundant.
    genuine.append(thumbnailFrame(thumbnail, `The real ${name} website`));
    suspect.append(
      element(
        'div',
        'flex:1;display:flex;align-items:center;justify-content:center;text-align:center;'
          + `border:1px dashed #d9dfe8;border-radius:5px;padding:12px;font:12px/1.5 ${FONT};color:#6b7280;`,
        'The page you are looking at now',
      ),
    );
  }

  if (!compact && colors.length) {
    genuine.append(
      element(
        'div',
        `display:flex;align-items:center;gap:6px;font:11px/1.5 ${FONT};color:#6b7280;`,
        'Brand colours',
        colorSwatches(colors),
      ),
    );
  }

  return element(
    'div',
    'display:flex;gap:12px;align-items:stretch;margin:10px 0;',
    suspect,
    genuine,
  );
}
