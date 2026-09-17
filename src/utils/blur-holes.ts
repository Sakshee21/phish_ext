/**
 * Hole geometry for the evidence frost (see driver-highlight.ts).
 *
 * Pure geometry only -- no DOM, no driver.js -- so the overlap policy is
 * unit-testable in Node (scripts/test-blur-holes.ts).
 */

export interface Hole {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Merge overlapping evidence holes into union bounding boxes.
 *
 * The frost mask XORs one layer per hole, so two overlapping holes would
 * flip their intersection back to opaque -- a blurred patch *inside* the
 * evidence. Flagged elements nest in practice (a logo inside a flagged
 * header), so overlapping holes are merged into one rect. The union may
 * also cover a sliver between diagonal elements (sharp where it should be
 * frosted); that imprecision is unnoticeable next to a blurred strip
 * through the evidence itself.
 *
 * Disjoint holes pass through unchanged. Edge-touching rects (shared edge,
 * zero-area intersection) are not merged; the HOLE_PAD applied by the
 * painter makes them visually continuous anyway.
 */
export function mergeHoles(all: Hole[]): Hole[] {
  const merged: Hole[] = [];
  for (const next of all) {
    let acc: Hole = { ...next };
    for (let i = 0; i < merged.length; ) {
      const other = merged[i]!;
      const intersects =
        acc.left < other.left + other.width
        && other.left < acc.left + acc.width
        && acc.top < other.top + other.height
        && other.top < acc.top + acc.height;
      if (!intersects) {
        i++;
        continue;
      }
      const left = Math.min(acc.left, other.left);
      const top = Math.min(acc.top, other.top);
      const right = Math.max(acc.left + acc.width, other.left + other.width);
      const bottom = Math.max(acc.top + acc.height, other.top + other.height);
      acc = { left, top, width: right - left, height: bottom - top };
      // The grown rect may now intersect holes accepted earlier; rescan.
      merged.splice(i, 1);
      i = 0;
    }
    merged.push(acc);
  }
  return merged;
}
