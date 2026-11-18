"""Copy every Supabase Storage object into an uncompressed tar with an index (design A.5)."""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import logging
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .config import LOCAL_HOST, MAX_STORAGE_OBJECTS
from .errors import BackupError

log = logging.getLogger("luma_backup")

LIST_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 120
RETRY_WAITS = (2, 5, 15)
PAGE = 1000
INDEX_NAME = "storage-index.json"


class _Retryable(Exception):
    pass


class _Fatal(Exception):
    pass


def check_object_path(path: str) -> str:
    """Refuse anything that could escape the export folder."""
    if not path or path.startswith("/") or "\\" in path or ":" in path:
        raise _Fatal("unsafe object path")
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise _Fatal("unsafe object path")
    return path


def require_safe(path: str, code: str) -> str:
    try:
        return check_object_path(path)
    except _Fatal:
        raise BackupError(code, detail="unsafe object path") from None


def check_storage_url(url: str, production: bool) -> str:
    parsed = urllib.parse.urlparse(url)
    if production:
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".supabase.co"):
            raise BackupError("secrets_unavailable", "The saved Storage address must be https://<project>.supabase.co.")
    elif parsed.scheme != "http" or parsed.hostname != LOCAL_HOST:
        raise BackupError("secrets_unavailable", "A synthetic run only talks to a fake Storage on 127.0.0.1.")
    return url.rstrip("/")


class StorageClient:
    def __init__(self, url: str, key: str, waits=RETRY_WAITS, sleep=time.sleep):
        self.url = url.rstrip("/")
        self.key = key
        self.waits = tuple(waits)
        self.sleep = sleep
        # A local fake (tests) must never be reached through a system proxy.
        local = urllib.parse.urlparse(self.url).hostname == LOCAL_HOST
        handlers = [urllib.request.ProxyHandler({})] if local else []
        self.opener = urllib.request.build_opener(*handlers)

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Authorization": f"Bearer {self.key}", "apikey": self.key, "User-Agent": "luma-backup"}
        if extra:
            h.update(extra)
        return h

    def _with_retries(self, label: str, fn):
        attempts = len(self.waits) + 1
        for attempt in range(attempts):
            try:
                return fn()
            except _Fatal as exc:
                raise BackupError("storage_failed", detail=f"{label}: {exc}") from None
            except _Retryable as exc:
                log.info("storage %s try %d of %d did not work (%s)", label, attempt + 1, attempts, exc)
                if attempt + 1 < attempts:
                    self.sleep(self.waits[attempt])
        raise BackupError("storage_failed", detail=f"{label}: gave up after {attempts} tries")

    def _open(self, req: urllib.request.Request, timeout: int):
        try:
            return self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            if status >= 500 or status == 429:
                raise _Retryable(f"server said {status}") from None
            raise _Fatal(f"server said {status}") from None
        except (OSError, http.client.HTTPException) as exc:  # URLError, timeouts, resets
            raise _Retryable(type(exc).__name__) from None

    def _json(self, method: str, path: str, body: dict | None = None):
        def go():
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers=self._headers({"Content-Type": "application/json"} if data else None))
            with self._open(req, LIST_TIMEOUT) as resp:
                try:
                    return json.loads(resp.read().decode("utf-8"))
                except (OSError, ValueError, http.client.HTTPException):
                    raise _Retryable("bad or cut-off reply") from None
        return self._with_retries(f"{method} list", go)

    def list_buckets(self) -> list[dict]:
        rows = self._json("GET", "/storage/v1/bucket")
        if not isinstance(rows, list):
            raise BackupError("storage_failed", detail="bucket list was not a list")
        return sorted(({"name": r["name"], "public": bool(r.get("public"))} for r in rows), key=lambda r: r["name"])

    def list_objects(self, bucket: str) -> list[dict]:
        out: list[dict] = []
        pending = [""]
        while pending:
            prefix = pending.pop()
            offset = 0
            while True:
                page = self._json("POST", f"/storage/v1/object/list/{urllib.parse.quote(bucket, safe='')}", {
                    "prefix": prefix, "limit": PAGE, "offset": offset,
                    "sortBy": {"column": "name", "order": "asc"},
                })
                if not isinstance(page, list):
                    raise BackupError("storage_failed", detail="object list was not a list")
                if not page:
                    break
                for entry in page:
                    name = entry.get("name") or ""
                    full = f"{prefix}/{name}" if prefix else name
                    require_safe(full, "storage_failed")
                    if entry.get("id") is None:
                        pending.append(full)
                        continue
                    meta = entry.get("metadata") or {}
                    out.append({
                        "bucket": bucket,
                        "path": full,
                        "expected_bytes": meta.get("size"),
                        "content_type": meta.get("mimetype"),
                        "last_modified": meta.get("lastModified") or entry.get("updated_at"),
                    })
                    if len(out) > MAX_STORAGE_OBJECTS:
                        raise BackupError("storage_failed", "There are more uploaded files than the safety limit.")
                offset += len(page)
        return sorted(out, key=lambda o: o["path"])

    def download(self, bucket: str, path: str, dest: Path, expected_bytes) -> tuple[int, str]:
        require_safe(path, "storage_failed")
        url = (f"{self.url}/storage/v1/object/{urllib.parse.quote(bucket, safe='')}/"
               f"{urllib.parse.quote(path, safe='/')}")

        def go():
            req = urllib.request.Request(url, headers=self._headers())
            digest = hashlib.sha256()
            size = 0
            dest.parent.mkdir(parents=True, exist_ok=True)
            with self._open(req, DOWNLOAD_TIMEOUT) as resp, open(dest, "wb") as fh:
                try:
                    while chunk := resp.read(1024 * 256):
                        digest.update(chunk)
                        size += len(chunk)
                        fh.write(chunk)
                except (OSError, ValueError, http.client.HTTPException) as exc:  # e.g. IncompleteRead
                    raise _Retryable(type(exc).__name__) from None
            if expected_bytes is not None and size != int(expected_bytes):
                raise _Retryable("size did not match the file list")
            return size, digest.hexdigest()

        return self._with_retries("download", go)


def export(client: StorageClient, work_dir: Path) -> tuple[Path, dict]:
    """Download everything and write <work_dir>/storage.tar. Returns (tar path, per-bucket summary)."""
    objects_dir = work_dir / "storage" / "objects"
    buckets = client.list_buckets()
    index = {"schema_version": 1, "buckets": buckets, "objects": []}
    summary: dict[str, dict] = {}
    for b in buckets:
        require_safe(b["name"], "storage_failed")
        summary[b["name"]] = {"objects": 0, "bytes": 0}
        for obj in client.list_objects(b["name"]):
            dest = objects_dir / b["name"] / Path(*obj["path"].split("/"))
            size, sha = client.download(b["name"], obj["path"], dest, obj["expected_bytes"])
            index["objects"].append({
                "bucket": b["name"], "path": obj["path"], "bytes": size, "sha256": sha,
                "content_type": obj["content_type"], "last_modified": obj["last_modified"],
            })
            summary[b["name"]]["objects"] += 1
            summary[b["name"]]["bytes"] += size
    log.info("storage: %d buckets, %d objects", len(buckets), len(index["objects"]))

    tar_path = work_dir / "storage.tar"
    with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tar:
        raw = json.dumps(index, indent=1, sort_keys=True).encode("utf-8")
        info = tarfile.TarInfo(INDEX_NAME)
        info.size = len(raw)
        tar.addfile(info, io.BytesIO(raw))
        for obj in index["objects"]:
            src = objects_dir / obj["bucket"] / Path(*obj["path"].split("/"))
            tar.add(src, arcname=f"objects/{obj['bucket']}/{obj['path']}", recursive=False)
    return tar_path, {"buckets": [b["name"] for b in buckets], "summary": summary}


def safe_extract(tar_path: Path, dest: Path) -> dict:
    """Extract only regular files under objects/ plus the index. Returns the index."""
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "r") as tar:
        members = tar.getmembers()
        for m in members:
            if not m.isfile():
                raise BackupError("restore_failed", detail="storage archive holds something that is not a file")
            if m.name != INDEX_NAME:
                if not m.name.startswith("objects/"):
                    raise BackupError("restore_failed", detail="unexpected entry in storage archive")
                require_safe(m.name, "restore_failed")
        tar.extractall(dest, members=members, filter="data")
    return json.loads((dest / INDEX_NAME).read_text(encoding="utf-8"))
