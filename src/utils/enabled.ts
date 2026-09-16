/**
 * Extension enabled/disabled state for casual browsing.
 *
 * Stored in `storage.local` so it persists across restarts. Defaults to
 * enabled: a missing key (fresh install) or an unreadable store means the
 * extension keeps protecting rather than silently turning itself off.
 */

const STORAGE_KEY = 'phish_enabled';

export async function isEnabled(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: enabled });
}
