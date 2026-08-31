#!/usr/bin/env bash
# Repopulate test-pages/ with the study clones from the collaborator's GitHub
# Pages site. Run inside WSL. The clones are gitignored (brand-impersonation
# markup we don't commit), so this is how a fresh checkout gets them.
set -euo pipefail
cd "$(dirname "$0")/.."
base="https://divcenter4.github.io/test"
for name in paypal github shopify idhc vtop; do
  if curl -sfL --max-time 30 "$base/$name.html" -o "test-pages/$name.html"; then
    printf '  fetched %-14s (%s bytes)\n' "$name.html" "$(wc -c < "test-pages/$name.html")"
  else
    printf '  FAILED  %s\n' "$name.html" >&2
  fi
done
