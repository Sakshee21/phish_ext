/**
 * Unit tests for the frost hole union-merge (src/utils/blur-holes.ts).
 *
 * The frost mask XORs one mask layer per hole, so two overlapping holes
 * would flip their intersection back to opaque -- a blurred patch *inside*
 * the evidence. mergeHoles() merges overlapping holes into union rects so
 * that cannot happen. These tests pin that behavior.
 *
 * Run: pnpm test:blur-holes   (node --experimental-strip-types)
 */

import { mergeHoles, type Hole } from '../src/utils/blur-holes.ts';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name}\n      expected ${e}\n      got      ${a}`);
    failures++;
  }
}

const hole = (l: number, t: number, w: number, h: number): Hole => ({ left: l, top: t, width: w, height: h });

// ── Disjoint holes pass through unchanged ──
check(
  'disjoint holes unchanged',
  mergeHoles([hole(0, 0, 10, 10), hole(100, 100, 10, 10)]),
  [hole(0, 0, 10, 10), hole(100, 100, 10, 10)],
);

// ── Nested: a logo inside a flagged header collapses to the header rect ──
check(
  'contained hole collapses into container',
  mergeHoles([hole(0, 0, 200, 100), hole(10, 10, 20, 10)]),
  [hole(0, 0, 200, 100)],
);

// ── Partial overlap: the XOR-blur bug case. Old code left the intersection
//    blurred; the merge must cover the union of both. ──
check(
  'partial overlap merges to union',
  mergeHoles([hole(0, 0, 50, 20), hole(40, 10, 50, 20)]),
  [hole(0, 0, 90, 30)],
);

// ── Chain: three rects where the third only overlaps the union of the
//    first two -- the grown rect must absorb it too. Union 0..110. ──
check(
  'chain merges via rescan',
  mergeHoles([hole(0, 0, 10, 10), hole(100, 100, 10, 10), hole(5, 5, 100, 100)]),
  [hole(0, 0, 110, 110)],
);

// ── Edge-touching rects share a boundary but no area: not an overlap. ──
check(
  'edge-touching not merged',
  mergeHoles([hole(0, 0, 10, 10), hole(10, 0, 10, 10)]),
  [hole(0, 0, 10, 10), hole(10, 0, 10, 10)],
);

// ── Duplicate rects merge into one. ──
check('identical rects merge', mergeHoles([hole(5, 5, 10, 10), hole(5, 5, 10, 10)]), [hole(5, 5, 10, 10)]);

// ── Empty and single inputs. ──
check('empty input', mergeHoles([]), []);
check('single hole', mergeHoles([hole(3, 4, 5, 6)]), [hole(3, 4, 5, 6)]);

// ── Order independence: the same set merges the same way regardless of
//    input order (the merge is rescan-driven, not pair-order-driven). ──
const a = [hole(0, 0, 50, 20), hole(40, 10, 50, 20), hole(120, 0, 10, 10)];
const b = [hole(120, 0, 10, 10), hole(40, 10, 50, 20), hole(0, 0, 50, 20)];
const mergedA = mergeHoles(a).sort((x, y) => x.left - y.left);
const mergedB = mergeHoles(b).sort((x, y) => x.left - y.left);
check('order independent', mergedA, mergedB);
check(
  'order-independent result correct',
  mergedA,
  [hole(0, 0, 90, 30), hole(120, 0, 10, 10)],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll blur-hole checks passed');
