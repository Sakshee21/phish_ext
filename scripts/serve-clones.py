#!/usr/bin/env python3
"""
Serve the local study clones under their fake hostnames.

WHY THIS RUNS ON WINDOWS, NOT WSL
---------------------------------
The participant's Chrome runs on Windows. WSL2 localhost-forwarding is broken
on this machine (Windows reaches the WSL server only on its VM IP, which
changes every reboot -- useless for a stable `127.0.0.1 host` mapping). So the
server runs on Windows Python, binds 127.0.0.1 directly, and Chrome reaches it
with no forwarding in the path. It reads the clone files straight off the WSL
bridge (//wsl.localhost/...), which Windows Python handles fine.

Run it from a Windows shell (PowerShell or Git Bash), NOT from `wsl`:

    python scripts/serve-clones.py            # binds 127.0.0.1:80  -> http://paypa1.com/
    python scripts/serve-clones.py --port 8080
    python scripts/serve-clones.py --print-hosts   # emit the hosts-file lines

Host routing: a request whose Host header matches a mapped hostname is served
that clone at "/". This is what makes the address bar read `http://paypa1.com/`
rather than `.../paypal.html`, so the URL stops giving the game away -- which is
the whole reason these exist (Layer 2 has to be tested on a realistic domain).

These hostnames only resolve on a machine that has run setup-hosts.ps1. They are
not registered, published, or reachable from the internet. See SETUP.md.
"""
from __future__ import annotations

import argparse
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

REPO = Path(__file__).resolve().parent.parent
DOCROOT = REPO / "test-pages"
MAP_FILE = DOCROOT / "clone-map.tsv"


def load_map() -> dict[str, str]:
    """hostname -> page filename, from the canonical tsv."""
    mapping: dict[str, str] = {}
    for line in MAP_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            mapping[parts[0].strip().lower()] = parts[1].strip()
    return mapping


HOST_TO_PAGE = load_map()


class CloneHandler(BaseHTTPRequestHandler):
    server_version = "phish-ext-clones/1.0"

    def _host(self) -> str:
        return (self.headers.get("Host", "") or "").split(":")[0].strip().lower()

    def _safe_path(self, url_path: str) -> Path | None:
        """Resolve a request path inside DOCROOT, or None if it escapes."""
        rel = unquote(urlparse(url_path).path).lstrip("/")
        if not rel:
            return None
        target = (DOCROOT / rel).resolve()
        try:
            target.relative_to(DOCROOT.resolve())
        except ValueError:
            return None  # path traversal attempt
        return target if target.is_file() else None

    def _serve_file(self, path: Path, host: str) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            self._log(host, 404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # No caching: during a pilot you want an edit to the clone to show up on
        # reload, not a stale copy that quietly diverges from what you changed.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self._log(host, 200)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        host = self._host()
        page = HOST_TO_PAGE.get(host)
        path = urlparse(self.path).path

        # A mapped hostname serves its clone at the root.
        if page and path in ("/", ""):
            self._serve_file(DOCROOT / page, host)
            return
        # A real asset under test-pages (rare -- the clones mostly hotlink real
        # CDNs) is served by path.
        real = self._safe_path(self.path)
        if real is not None:
            self._serve_file(real, host)
            return
        # Any other path on a mapped host still shows the clone rather than a
        # 404, so a stray favicon or sub-path never breaks the illusion.
        if page:
            self._serve_file(DOCROOT / page, host)
            return
        self.send_error(404, "No clone mapped for this host. See test-pages/clone-map.tsv")
        self._log(host, 404)

    def _log(self, host: str, status: int) -> None:
        sys.stdout.write(f"  {status}  {host or '(no host)'}{self.path}\n")
        sys.stdout.flush()

    def log_message(self, *_args) -> None:  # silence the default noisy logger
        pass


def print_hosts() -> None:
    for hostname in HOST_TO_PAGE:
        print(f"127.0.0.1 {hostname}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve local study clones under fake hostnames.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=80, help="bind port (default 80 -> clean URLs)")
    ap.add_argument("--print-hosts", action="store_true",
                    help="print the hosts-file lines and exit")
    args = ap.parse_args()

    if args.print_hosts:
        print_hosts()
        return 0

    if not MAP_FILE.is_file():
        print(f"error: {MAP_FILE} not found. Run scripts/fetch-clones.sh first.", file=sys.stderr)
        return 1

    print(f"Serving {len(HOST_TO_PAGE)} clone(s) from {DOCROOT}")
    for hostname, page in HOST_TO_PAGE.items():
        print(f"    http://{hostname}{'' if args.port == 80 else ':' + str(args.port)}/   ->  {page}")
    print(f"Bound to {args.host}:{args.port}. Ctrl+C to stop.\n")

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), CloneHandler)
    except PermissionError:
        print(f"error: no permission to bind port {args.port}. Try --port 8080.", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: could not bind {args.host}:{args.port} ({exc}). "
              f"Port in use? Try --port 8080.", file=sys.stderr)
        return 1
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
