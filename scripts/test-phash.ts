/**
 * Manual test for the pHash algorithm (src/utils/phash.ts).
 *
 * Two parts:
 *
 * 1. Synthetic self-check — always runs, zero setup. Generates its own
 *    pixel buffers in code, so it's a fast sanity check / regression guard
 *    that doesn't depend on any files being present.
 *
 * 2. Real-image validation — reads actual PNG screenshots from
 *    `test-images/` (see filenames below) via `pngjs`, so the <=7 threshold
 *    shipped in `brands.json` gets checked against real capture noise
 *    (antialiasing, compression, font rendering) instead of a synthetic
 *    noise model. Skipped with instructions if the files aren't there yet.
 *
 * Run (Node >= 22.6, uses the built-in TypeScript stripping flag):
 *   node --experimental-strip-types scripts/test-phash.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { computePerceptualHash, hammingDistance, type PixelBuffer } from '../src/utils/phash.ts';

function logResult(label: string, dist: number, expectation: string): void {
  console.log(`Hamming(${label}) = ${String(dist).padEnd(3)} (${expectation})`);
}

// ── Part 1: synthetic self-check ──

function runSyntheticCheck(): boolean {
  console.log('── Synthetic self-check ──\n');

  const makeImage = (
    width: number,
    height: number,
    colorAt: (x: number, y: number) => [number, number, number],
  ): PixelBuffer => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = colorAt(x, y);
        const o = (y * width + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    return { width, height, data };
  };

  // A "login page"-ish pattern: a light background with a darker header band
  // and a centered "card" block — simple, but has enough low-frequency
  // structure for the DCT to pick up on.
  const loginPagePattern = (x: number, y: number, w: number, h: number): [number, number, number] => {
    if (y < h * 0.15) return [30, 60, 120]; // header band
    const inCard = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.8;
    return inCard ? [255, 255, 255] : [230, 230, 235];
  };

  // A visibly different layout (inverted bands, shifted card) — simulates
  // an unrelated page.
  const differentPagePattern = (x: number, y: number, w: number, h: number): [number, number, number] => {
    if (y > h * 0.85) return [120, 30, 30]; // footer band instead of header
    const inCard = x > 0 && x < w * 0.4 && y > h * 0.1 && y < h * 0.5;
    return inCard ? [20, 20, 20] : [245, 245, 200];
  };

  const width = 320;
  const height = 200;

  const imageA = makeImage(width, height, (x, y) => loginPagePattern(x, y, width, height));
  const imageA2 = makeImage(width, height, (x, y) => loginPagePattern(x, y, width, height));

  // Same pattern plus small per-pixel noise (+/-3 per channel) — simulates
  // two screenshots of the *same* real page (antialiasing/compression jitter).
  const imageB = makeImage(width, height, (x, y) => {
    const [r, g, b] = loginPagePattern(x, y, width, height);
    const jitter = () => Math.max(0, Math.min(255, Math.round((Math.random() - 0.5) * 6)));
    return [r + jitter(), g + jitter(), b + jitter()];
  });

  const imageC = makeImage(width, height, (x, y) => differentPagePattern(x, y, width, height));

  const hashA = computePerceptualHash(imageA);
  const hashA2 = computePerceptualHash(imageA2);
  const hashB = computePerceptualHash(imageB);
  const hashC = computePerceptualHash(imageC);

  const distSelf = hammingDistance(hashA, hashA2);
  const distAB = hammingDistance(hashA, hashB);
  const distAC = hammingDistance(hashA, hashC);

  logResult('A, A2', distSelf, 'expect 0 — identical pixels are deterministic');
  logResult('A, B ', distAB, 'expect small relative to (A, C) — same page, noisy capture');
  logResult('A, C ', distAC, 'expect large, close to 32/64 — the ~50% ceiling for unrelated hashes');
  console.log();

  const pass = distSelf === 0 && distAB < distAC && distAC >= 20;
  console.log(pass ? '✅ PASS\n' : '❌ FAIL\n');
  return pass;
}

// ── Part 2: real-image validation ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = join(__dirname, '..', 'test-images');

const REAL_IMAGES = {
  same1: 'same-1.png',
  same2: 'same-2.png',
  different: 'different.png',
} as const;

function loadPng(filename: string): PixelBuffer {
  const path = join(IMAGES_DIR, filename);
  const png = PNG.sync.read(readFileSync(path));
  // png.data is a Buffer, RGBA-interleaved — same layout PixelBuffer expects.
  return { width: png.width, height: png.height, data: png.data };
}

function runRealImageCheck(): boolean | null {
  console.log('── Real-image validation ──\n');

  const missing = Object.values(REAL_IMAGES).filter((f) => !existsSync(join(IMAGES_DIR, f)));
  if (missing.length > 0) {
    console.log(`Skipped — missing file(s) in ${IMAGES_DIR}:`);
    for (const f of missing) console.log(`  - ${f}`);
    console.log(
      '\nSee the top of this script (or ask for the README) for what to put in each file.\n',
    );
    return null;
  }

  const same1 = loadPng(REAL_IMAGES.same1);
  const same2 = loadPng(REAL_IMAGES.same2);
  const different = loadPng(REAL_IMAGES.different);

  const hashSame1 = computePerceptualHash(same1);
  const hashSame2 = computePerceptualHash(same2);
  const hashDifferent = computePerceptualHash(different);

  const distSame = hammingDistance(hashSame1, hashSame2);
  const distDifferent = hammingDistance(hashSame1, hashDifferent);

  console.log('hash same-1.png:   ', hashSame1);
  console.log('hash same-2.png:   ', hashSame2);
  console.log('hash different.png:', hashDifferent);
  console.log();
  logResult('same-1, same-2  ', distSame, 'two captures of the same page — this validates the <=7 threshold');
  logResult('same-1, different', distDifferent, 'expect clearly larger than the same-page distance');
  console.log();

  const pass = distDifferent > distSame;
  if (pass && distSame <= 7) {
    console.log('✅ PASS — same-page distance is within the <=7 threshold\n');
  } else if (pass) {
    console.log(
      `⚠️  Same-page distance (${distSame}) is above the <=7 threshold, but still ` +
        `clearly closer than the different-page distance (${distDifferent}). The threshold may need to be ` +
        'loosened once real brand screenshots are in play — that is exactly what this check is for.\n',
    );
  } else {
    console.log('❌ FAIL — same-page distance is not smaller than different-page distance\n');
  }
  return pass;
}

// ── Run both ──

const syntheticPass = runSyntheticCheck();
const realResult = runRealImageCheck();

if (!syntheticPass || realResult === false) {
  process.exit(1);
}
