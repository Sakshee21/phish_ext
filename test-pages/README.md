# test-pages

Local copies of the study clones, served under fake hostnames so participants
don't see the giveaway `divcenter4.github.io/test/...` URL. See `../SETUP.md`.

- `clone-map.tsv` — canonical hostname → page mapping (committed).
- `*.html` — the clones themselves (gitignored). Populate with
  `scripts/fetch-clones.sh`, which pulls them from the collaborator's GitHub
  Pages site.

**These pages impersonate real brands for detection testing only.** They are
never published from here, and the hostnames they're served under resolve to
127.0.0.1 on a machine that ran `scripts/setup-hosts.ps1` — nowhere else.
