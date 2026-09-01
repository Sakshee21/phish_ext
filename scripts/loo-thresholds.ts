/**
 * Leave-one-out threshold validation over tools/captures/*.png (dev-only).
 *
 * Why this exists: Layer 1's threshold (BrandReference.phashThreshold) and the
 * hash geometry (phash.ts BAND_CSS_PX) were chosen, not derived. This harness
 * measures them: each capture is matched against every OTHER capture in the
 * dataset with itself excluded — approximating "a participant opens this page
 * at a window size we didn't reference". Reports hit / miss / wrong-brand per
 * threshold, where wrong-brand is the costly failure (an innocent page
 * identified as some other brand).
 *
 * Usage:
 *   node --experimental-strip-types scripts/loo-thresholds.ts [capturesDir]
 *
 * Caveats:
 * - Brands with a single capture (legacy `paypal.png`) have no other reference
 *   of their own, so they can produce no "hit" — they only test for causing
 *   wrong-brand matches in others.
 * - Captures of the same brand at nearby viewports are not independent pages;
 *   treat the hit rate as an upper bound, and the wrong-brand count as the
 *   number that actually matters.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { computePerceptualHash, hammingDistance, type PixelBuffer } from '../src/utils/phash.ts';

const capturesDir = process.argv[2] ?? 'tools/captures';
const thresholds = [4, 5, 6, 7, 8, 10];

const files = readdirSync(capturesDir).filter((f) => f.endsWith('.png'));
const caps: { brand: string; file: string; hash: string }[] = [];
for (const f of files) {
  const brand = f.includes('@') ? f.split('@')[0] : f.replace(/\.png$/, '');
  const png = PNG.sync.read(readFileSync(join(capturesDir, f)));
  const pixels: PixelBuffer = { width: png.width, height: png.height, data: png.data };
  caps.push({ brand, file: f, hash: computePerceptualHash(pixels) });
}

const byBrand = new Map<string, string[]>();
for (const c of caps) {
  if (!byBrand.has(c.brand)) byBrand.set(c.brand, []);
  byBrand.get(c.brand)!.push(c.hash);
}

for (const t of thresholds) {
  let hit = 0;
  let miss = 0;
  let wrong = 0;
  const perBrand = new Map<string, { hit: number; total: number }>();
  for (const c of caps) {
    const own = byBrand.get(c.brand)!.filter((h) => h !== c.hash);
    let bestBrand: string | null = null;
    let bestDist = Infinity;
    for (const [brand, hashes] of byBrand) {
      const refs = brand === c.brand ? own : hashes;
      if (refs.length === 0) continue;
      for (const h of refs) {
        const d = hammingDistance(c.hash, h);
        if (d < bestDist) {
          bestDist = d;
          bestBrand = brand;
        }
      }
    }

    // Same argmin semantics as findVisualBrandMatch: closest brand wins.
    let outcome: 'hit' | 'miss' | 'wrong';
    if (bestDist > t) outcome = 'miss';
    else if (bestBrand === c.brand) outcome = 'hit';
    else outcome = 'wrong';

    if (outcome === 'hit') hit++;
    else if (outcome === 'miss') miss++;
    else wrong++;

    if (outcome !== 'miss') {
      const pb = perBrand.get(c.brand) ?? { hit: 0, total: 0 };
      if (outcome === 'hit') pb.hit++;
      pb.total++;
      perBrand.set(c.brand, pb);
    } else if (t === 8) {
      console.log(`  [t=8] ${c.file}: miss (nearest ${bestBrand} d=${bestDist})`);
    }
    if (outcome === 'wrong') {
      console.log(`  WRONG-BRAND: ${c.file} -> ${bestBrand} (d=${bestDist})`);
    }
  }
  const pb = [...perBrand.entries()].map(([b, v]) => `${b} ${v.hit}/${v.total}`).join('  ');
  console.log(`threshold ${t}: hit ${hit}/${caps.length}  miss ${miss}  WRONG-BRAND ${wrong}  | ${pb}`);
}
