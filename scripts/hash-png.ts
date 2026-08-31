/**
 * Dev utility: print the TS-side perceptual hash of a PNG screenshot.
 *
 * Usage:
 *   node --experimental-strip-types scripts/hash-png.ts path/to/screenshot.png [dpr]
 *
 * `dpr` (optional, default 1) is the ratio the screenshot was captured at.
 * The tools/generate.py captures are taken at device_scale_factor 1, so the
 * default is correct for them; pass 2 for a Retina manual screenshot so the
 * fixed CSS-px hash band lands on the same page region.
 *
 * Uses the exact same code path as the extension (src/utils/phash.ts + pngjs,
 * like scripts/test-phash.ts), so the printed 16-char hex is what the offscreen
 * document would compute for that image.
 *
 * Use cases:
 * - Seed a `BrandReference.phash` in src/assets/brands/brands.json (e.g. a
 *   screenshot of the local demo page, so navigating there auto-matches).
 * - Calibrate the Python dataset generator (tools/) — compute the TS hash of a
 *   captured brand screenshot and compare it with `imagehash.phash`'s output
 *   to confirm the two implementations agree closely enough for the threshold
 *   to transfer.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { computePerceptualHash, type PixelBuffer } from '../src/utils/phash.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node --experimental-strip-types scripts/hash-png.ts <file.png> [dpr]');
  process.exit(1);
}
const dpr = Number(process.argv[3]) || 1;

const png = PNG.sync.read(readFileSync(file));
// png.data is a Buffer, RGBA-interleaved — the layout PixelBuffer expects.
const pixels: PixelBuffer = { width: png.width, height: png.height, data: png.data };
console.log(computePerceptualHash(pixels, dpr));