# SETUP — local study clones under realistic hostnames

Serving the phishing test pages under bank/brand-sounding hostnames instead of
`divcenter4.github.io/test/...`, so the **URL itself** doesn't hand participants
the answer before the warning ever fires. This is what makes Layer 2
(domain-legitimacy) testable at all — a domain check has nothing to check if the
address bar already says `github.io`.

> **These hostnames are not real.** They resolve to `127.0.0.1` **only** on a
> machine that has run `scripts/setup-hosts.ps1`. They are not registered, not
> published, and unreachable from the internet. They are not live phishing
> pages — they are local study stimuli.

---

## The one thing to understand first

**Chrome runs on Windows. WSL's `/etc/hosts` is the wrong file.**

Name resolution for the browser happens on Windows, so the file that matters is
the **Windows** hosts file:

```
C:\Windows\System32\drivers\etc\hosts
```

Editing `/etc/hosts` inside WSL does nothing for Chrome. (On this machine WSL2
localhost-forwarding is also broken — Windows can't reach the WSL server on
`127.0.0.1` — so the clone server runs on **Windows**, not WSL, and Chrome
reaches it natively.)

---

## Setup (two commands)

Both run in a **Windows** shell (PowerShell or Git Bash), not `wsl`.

**1. Map the hostnames** (prompts for admin — the hosts file is protected):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-hosts.ps1
```

It writes a clearly-marked block to the Windows hosts file, flushes the DNS
cache, and is idempotent — re-running replaces the block rather than duplicating
it. Tear down later with `-Remove`.

**2. Serve the clones:**

```powershell
python scripts\serve-clones.py
```

Binds `127.0.0.1:80`, so the address bar reads `http://paypa1.com/` with no port
or path. (Port 80 busy? `python scripts\serve-clones.py --port 8080` →
`http://paypa1.com:8080/`.) Leave it running; `Ctrl+C` stops it.

**Then restart Chrome** so it drops any cached DNS, and visit `http://paypa1.com/`.

---

## Editing the hosts file by hand (if you skip the script)

The script just automates this. To do it yourself:

1. Open **Notepad as Administrator** (Start → type Notepad → right-click → *Run
   as administrator*). Admin is required — the file is write-protected.
2. **File → Open**, paste `C:\Windows\System32\drivers\etc\hosts`, set the file
   filter to *All Files* so it shows.
3. Add these lines at the bottom, then save:

   ```
   # === phish_ext study clones (BEGIN) - local only, not real domains ===
   127.0.0.1 paypa1.com
   127.0.0.1 glthub.com
   127.0.0.1 idfcfirst-secure.in
   127.0.0.1 shopify-billing.com
   # === phish_ext study clones (END) ===
   ```

4. Flush the cache so Chrome sees the change: open a terminal and run
   `ipconfig /flushdns`, then restart Chrome.

Leave the existing entries (Docker etc.) alone. To undo, delete the block.

---

## The hostnames

Each is a different kind of bad domain, so Layer 2's two flag paths both get
exercised. Regenerate this list any time with
`python scripts\serve-clones.py --print-hosts`.

| Hostname | Serves (brand) | Layer 2 `flagReason` | Why |
|---|---|---|---|
| `paypa1.com` | PayPal | `typosquatting` | homoglyph `1`↔`l`, edit distance 0 from `paypal.com` |
| `glthub.com` | GitHub | `typosquatting` | `i`→`l` substitution, edit distance 1 from `github.com` |
| `idfcfirst-secure.in` | IDFC First Bank | `domain_mismatch` | plausible extra word, far from `idfcfirst.bank.in` |
| `shopify-billing.com` | Shopify | `domain_mismatch` | plausible extra word, far from `shopify.com` |

`typosquatting` = within a couple of edits / homoglyph of a real domain.
`domain_mismatch` = branded page on a domain the brand simply doesn't use.
**Both are flagged** — the difference is the recorded reason and edit distance.

---

## Verifying Layer 2 actually fires (walkthrough)

Do this once per flag path — one `typosquatting`, one `domain_mismatch`.

1. Load the pilot build (`C:\Users\UJJWAL KUMAT\phishoff-pilot`, or run
   `pnpm build:pilot:win`) and make sure **Site access** is *On all sites*.
2. With the server running, visit **`http://paypa1.com/`**. The PayPal clone
   loads and the warning should appear (the exact form depends on your assigned
   condition — for a clean check, set the popup dropdown to `banner`).
3. Open the background **service worker** console (`chrome://extensions` →
   *service worker*) and read the last logged visit:

   ```js
   browser.storage.local.get('phish_interactions').then(e => {
     const shown = e.phish_interactions.filter(x => x.type === 'shown').at(-1);
     console.log(shown.url, shown.result.domain);
   });
   ```

   For `paypa1.com` you should see `flagReason: "typosquatting"`,
   `matchedAllowedDomain: "paypal.com"`, `distance: 0`. For
   `http://idfcfirst-secure.in/` you should see `flagReason: "domain_mismatch"`
   against `idfcfirst.bank.in`.

4. The same fields render in the **View logs** page (popup footer) when you
   expand a visit's detection detail, alongside the pHash/Hamming and keyword
   evidence.

If the warning doesn't appear at all, it's almost always a stale content script
(rebuilt with the tab open) or Site access set to on-click — see `TESTING.md` §2.

---

## Adding another clone later

1. Add the page to `test-pages/` (or add it to `scripts/fetch-clones.sh`).
2. Add a row to `test-pages/clone-map.tsv` (hostname, page, brand, flagReason).
3. Add the hostname to the `$Hostnames` list in `scripts/setup-hosts.ps1`.
4. Re-run `setup-hosts.ps1` and restart the server.

Freeze the set before real collection — changing stimuli mid-study makes
participants non-comparable, the same hazard as re-randomising condition
assignment.
