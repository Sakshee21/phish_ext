/**
 * Mirror the pilot build into a native Windows folder for Chrome.
 *
 * Two problems this solves, both specific to developing in WSL against a
 * Windows Chrome:
 *
 * 1. Chrome refuses to load an unpacked extension from a UNC path
 *    (\wsl.localhost\...), rejecting it as "folder name not valid".
 * 2. WXT deletes and recreates .output on every build. Chrome unloads an
 *    unpacked extension the moment its directory disappears, so rebuilding
 *    silently drops the extension from chrome://extensions.
 *
 * Syncing file-by-file into a directory that is never itself removed fixes
 * both: Chrome keeps the extension loaded and you only press Reload. During a
 * participant session that matters more than convenience -- an extension that
 * vanishes mid-run loses the whole visit.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = '.output/chrome-mv3-pilot';
const DEST = process.env.PHISH_WIN_DIR
  ?? join(process.env.USERPROFILE ?? homedir(), 'phishoff-pilot');

if (!existsSync(SRC)) {
  console.error(`[sync-win] no build at ${SRC} -- run the build first.`);
  process.exit(1);
}

/** Replace contents without removing DEST itself, so Chrome never sees it vanish. */
await mkdir(DEST, { recursive: true });
for (const entry of await readdir(DEST)) {
  await rm(join(DEST, entry), { recursive: true, force: true });
}
for (const entry of await readdir(SRC)) {
  await cp(join(SRC, entry), join(DEST, entry), { recursive: true });
}

const manifest = join(DEST, 'manifest.json');
if (!existsSync(manifest)) {
  console.error('[sync-win] manifest.json missing from the copy -- do not load this.');
  process.exit(1);
}
console.log(`[sync-win] synced -> ${DEST} (${(await stat(manifest)).size} B manifest)`);
console.log('[sync-win] Chrome: reload the extension, then reopen the test tab.');
