"""Read and write the DPAPI-sealed secrets file (design A.3)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from . import dpapi, redact
from .config import DPAPI_ENTROPY


class SecretsUnavailable(Exception):
    pass


@dataclass(repr=False)
class Secrets:
    db: dict
    storage: dict
    passphrase: str
    passphrase_id: str
    old_passphrases: dict = field(default_factory=dict)
    created_at: str = ""

    def __repr__(self) -> str:  # never show a secret, even by accident
        return f"Secrets(passphrase_id={self.passphrase_id!r}, [hidden])"

    __str__ = __repr__

    def passphrase_for(self, passphrase_id: str) -> str:
        if passphrase_id == self.passphrase_id:
            return self.passphrase
        if passphrase_id in self.old_passphrases:
            return self.old_passphrases[passphrase_id]
        raise SecretsUnavailable(f"No saved passphrase called {passphrase_id}.")

    def register(self) -> None:
        """Teach the redactor every exact secret value."""
        redact.register_secret(self.db.get("password"))
        redact.register_secret(self.storage.get("service_key"))
        redact.register_secret(self.passphrase)
        for value in self.old_passphrases.values():
            redact.register_secret(value)

    def to_dict(self) -> dict:
        return {
            "db": self.db,
            "storage": self.storage,
            "passphrase": self.passphrase,
            "passphrase_id": self.passphrase_id,
            "old_passphrases": self.old_passphrases,
            "created_at": self.created_at,
        }


def seal(data: dict, path: Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = dpapi.protect(json.dumps(data).encode("utf-8"), DPAPI_ENTROPY)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(blob)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def load(path: Path) -> Secrets:
    path = Path(path)
    if not path.is_file():
        raise SecretsUnavailable("The saved keys file is missing. Run setup_credentials.py first.")
    try:
        raw = dpapi.unprotect(path.read_bytes(), DPAPI_ENTROPY)
        data = json.loads(raw.decode("utf-8"))
        return Secrets(
            db=dict(data["db"]),
            storage=dict(data["storage"]),
            passphrase=data["passphrase"],
            passphrase_id=data["passphrase_id"],
            old_passphrases=dict(data.get("old_passphrases") or {}),
            created_at=data.get("created_at", ""),
        )
    except (dpapi.DpapiError, ValueError, KeyError, TypeError):
        raise SecretsUnavailable(
            "The saved keys could not be opened. They only open for the Windows user who saved them."
        ) from None
