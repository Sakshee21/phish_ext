import type { ComputePHashMessage, MatchLogosMessage, ExtensionMessage } from '@/lib/types';
import { computePerceptualHash } from '@/utils/phash';

// ── Canvas-based perceptual hashing (Layer 1) ──

/**
 * Decode a base64 PNG (either a bare base64 string or a full `data:` URL,
 * e.g. what `tabs.captureVisibleTab` returns) into a Blob.
 */
function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const encoded = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Compute a DCT-based perceptual hash of an image.
 *
 * The actual DCT/hashing algorithm lives in `src/utils/phash.ts` as plain,
 * canvas-free TypeScript (so it's independently testable). This function's
 * only job is the canvas-specific part only an offscreen document can do:
 * decode the screenshot bytes into pixels.
 *
 * Comparison: two hashes are "close" if Hamming distance <= threshold.
 * The shipped threshold lives in brands.json (`phashThreshold`, currently 7).
 */
async function computePHash(imageData: string, devicePixelRatio?: number): Promise<string> {
  const blob = base64ToBlob(imageData);
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error('[phish_ext:offscreen] Failed to get 2D canvas context');
    return '';
  }

  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  return computePerceptualHash(pixels, devicePixelRatio);
}

// ── Logo template matching (Layer 3) ──

async function matchLogoTemplates(imageData: string, brandId: string): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  // TODO: Implement logo template matching
  // 1. Look up the brand's logo data from the cached brands.json dataset
  // 2. Decode both the screenshot and the logo template to ImageBitmaps
  // 3. Run template matching: slide the logo template across the screenshot
  //    - Use a simple cross-correlation or MSE approach on the canvas pixel data
  //    - Or: use a perceptual-hash of sliding windows and compare to the logo's pHash
  // 4. Return the coordinates of the best match (if above confidence threshold)
  // 5. If no match → return empty array
  // For a simpler starting point: compare hashes of regions against the logo hash.
  console.log('[phish_ext:offscreen] Logo match requested for brand:', brandId);
  return [];
}

// ── Message handler ──

/**
 * Handle only this document's own messages, and answer everything else with
 * a *synchronous* undefined.
 *
 * The async/await form of the listener is a trap here: an async listener
 * returns a Promise for EVERY message, and `runtime.sendMessage` broadcasts
 * to every extension context -- so an instant `Promise<undefined>` from this
 * document wins the response race against the background's real, slower
 * reply to the same message (e.g. the popup's tab-verdict lookup), silently
 * eating it. A sync `undefined` does not claim the response channel at all.
 */
browser.runtime.onMessage.addListener((message: ExtensionMessage): Promise<ExtensionMessage> | undefined => {
  switch (message.type) {
    case 'COMPUTE_PHASH':
      return computePHash(message.imageData, message.devicePixelRatio).then(
        (hash): ExtensionMessage => ({ type: 'PHASH_RESULT', hash }),
      );

    case 'MATCH_LOGOS':
      return matchLogoTemplates(message.imageData, message.brandId).then(
        (matches): ExtensionMessage => ({ type: 'LOGO_MATCH_RESULT', matches }),
      );

    default:
      return undefined;
  }
});
