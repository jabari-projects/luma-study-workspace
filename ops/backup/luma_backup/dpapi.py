"""Windows DPAPI (current-user scope) through ctypes.

A sealed blob opens only for the same Windows user on the same PC. That keeps the
database password and the backup passphrase off disk in plain text.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

CRYPTPROTECT_UI_FORBIDDEN = 0x1


class DpapiError(Exception):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _api():
    if sys.platform != "win32":
        raise DpapiError("Sealed keys need Windows.")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    protect = crypt32.CryptProtectData
    protect.argtypes = [
        ctypes.POINTER(_Blob), wintypes.LPCWSTR, ctypes.POINTER(_Blob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob),
    ]
    protect.restype = wintypes.BOOL
    unprotect = crypt32.CryptUnprotectData
    unprotect.argtypes = [
        ctypes.POINTER(_Blob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(_Blob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob),
    ]
    unprotect.restype = wintypes.BOOL
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p
    return protect, unprotect, local_free


def _blob(data: bytes):
    buf = (ctypes.c_ubyte * max(len(data), 1)).from_buffer_copy(data or b"\0")
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))), buf


def _take(blob: _Blob, local_free) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        local_free(ctypes.cast(blob.pbData, ctypes.c_void_p))


def protect(data: bytes, entropy: bytes) -> bytes:
    protect_fn, _, local_free = _api()
    data_in, keep1 = _blob(data)
    ent, keep2 = _blob(entropy)
    out = _Blob()
    ok = protect_fn(ctypes.byref(data_in), "luma-backup", ctypes.byref(ent), None, None,
                    CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    del keep1, keep2
    if not ok:
        raise DpapiError("Windows could not seal the keys.")
    return _take(out, local_free)


def unprotect(sealed: bytes, entropy: bytes) -> bytes:
    _, unprotect_fn, local_free = _api()
    data_in, keep1 = _blob(sealed)
    ent, keep2 = _blob(entropy)
    out = _Blob()
    ok = unprotect_fn(ctypes.byref(data_in), None, ctypes.byref(ent), None, None,
                      CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    del keep1, keep2
    if not ok:
        raise DpapiError("Windows could not open the sealed keys for this user.")
    return _take(out, local_free)
