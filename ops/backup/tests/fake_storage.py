"""A stdlib fake of the Supabase Storage API on 127.0.0.1:0 (OS-picked port).

Serves 2 buckets and 3 objects (one inside a nested folder), checks the bearer key, and can be
told to fail with 500 or to send bytes that don't match the file list.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = "SYNTH-MARKER-7f3a"
PATH_MARKER = "SYNTH-PATH-91c2"

OBJECTS = {
    "avatars": {
        f"{PATH_MARKER}/face.png": b"\x89PNG fake avatar " + MARKER.encode() * 20,
        "top.png": b"\x89PNG another fake " + MARKER.encode() * 5,
    },
    "themes": {
        "back.jpg": b"\xff\xd8 fake theme image " + MARKER.encode() * 50,
    },
}
BUCKETS = [{"id": "avatars", "name": "avatars", "public": True}, {"id": "themes", "name": "themes", "public": True}]


class FakeStorage:
    def __init__(self, key: str):
        self.key = key
        self.mode = "ok"  # ok | fail500 | corrupt
        self.requests = 0
        handler = self._handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self) -> "FakeStorage":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep test output quiet
                pass

            def _send(self, code: int, body: bytes, ctype: str = "application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                return (self.headers.get("Authorization") == f"Bearer {fake.key}"
                        and self.headers.get("apikey") == fake.key)

            def _gate(self) -> bool:
                fake.requests += 1
                if not self._authorized():
                    self._send(403, b'{"message":"bad key"}')
                    return False
                if fake.mode == "fail500":
                    self._send(500, b'{"message":"boom"}')
                    return False
                return True

            def do_GET(self):
                if not self._gate():
                    return
                path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                if path == "/storage/v1/bucket":
                    return self._send(200, json.dumps(BUCKETS).encode())
                prefix = "/storage/v1/object/"
                if path.startswith(prefix):
                    bucket, _, name = path[len(prefix):].partition("/")
                    data = OBJECTS.get(bucket, {}).get(name)
                    if data is None:
                        return self._send(404, b'{"message":"not found"}')
                    if fake.mode == "corrupt":
                        data = data[:-3]
                    return self._send(200, data, "application/octet-stream")
                self._send(404, b"{}")

            def do_POST(self):
                if not self._gate():
                    return
                path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                prefix = "/storage/v1/object/list/"
                if not path.startswith(prefix):
                    return self._send(404, b"{}")
                bucket = path[len(prefix):]
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                want = body.get("prefix", "")
                offset, limit = int(body.get("offset", 0)), int(body.get("limit", 100))
                entries, folders = [], set()
                for name, data in sorted(OBJECTS.get(bucket, {}).items()):
                    rest = name[len(want) + 1:] if want else name
                    if want and not name.startswith(want + "/"):
                        continue
                    if "/" in rest:
                        folders.add(rest.split("/", 1)[0])
                        continue
                    entries.append({"name": rest, "id": f"id-{bucket}-{len(entries)}",
                                    "updated_at": "2026-11-01T00:00:00Z",
                                    "metadata": {"size": len(data), "mimetype": "image/png",
                                                 "lastModified": "2026-11-01T00:00:00Z"}})
                rows = [{"name": f, "id": None, "metadata": None} for f in sorted(folders)] + entries
                self._send(200, json.dumps(rows[offset:offset + limit]).encode())

        return Handler


def expected_summary() -> dict:
    return {b: {"objects": len(objs), "bytes": sum(len(d) for d in objs.values())} for b, objs in OBJECTS.items()}
