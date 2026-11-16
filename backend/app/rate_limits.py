"""Small in-memory sliding-window limiter.

Note: state lives in this process only. With several workers or instances each
one keeps its own counts, and a restart clears them. That is fine as a first
line of defense against password guessing and reset-email spam; use a shared
store (for example Redis) if the backend is scaled out.

Memory is bounded: keys are kept in least-recently-active order, expired keys
are pruned globally every ``prune_every`` operations, and when more than
``max_keys`` keys are active the least recently active ones are dropped. That
stops an attacker from growing memory forever by spraying unique keys (for
example random emails on /login). Eviction only happens under that kind of
flood, and pushing one real key out takes ``max_keys`` fresh requests.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Callable, Hashable

DEFAULT_MAX_KEYS = 10_000
DEFAULT_PRUNE_EVERY = 1_000


class SlidingWindowLimiter:
    def __init__(
        self,
        max_events: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = DEFAULT_MAX_KEYS,
        prune_every: int = DEFAULT_PRUNE_EVERY,
    ):
        self.max_events = max_events
        self.window_seconds = window_seconds
        self.max_keys = max(1, int(max_keys))
        self.prune_every = max(1, int(prune_every))
        self._clock = clock
        # Ordered from least to most recently active key.
        self._events: OrderedDict[Hashable, list[float]] = OrderedDict()
        self._ops = 0
        self._lock = threading.Lock()

    # All private helpers expect the lock to be held.

    def _prune(self, key: Hashable, now: float) -> list[float]:
        active = [t for t in self._events.get(key, ()) if now - t < self.window_seconds]
        if active:
            self._events[key] = active
        else:
            self._events.pop(key, None)
        return active

    def _prune_expired(self, now: float) -> None:
        # Keys are ordered by last activity, so stop at the first live one.
        while self._events:
            key, stamps = next(iter(self._events.items()))
            if stamps and now - stamps[-1] < self.window_seconds:
                break
            self._events.popitem(last=False)

    def _maintain(self, now: float) -> None:
        self._ops += 1
        if self._ops >= self.prune_every or len(self._events) > self.max_keys:
            self._ops = 0
            self._prune_expired(now)
        while len(self._events) > self.max_keys:
            self._events.popitem(last=False)

    def _append(self, key: Hashable, now: float) -> None:
        stamps = self._events.get(key)
        if stamps is None:
            self._events[key] = [now]
        else:
            stamps.append(now)
            self._events.move_to_end(key)
        self._maintain(now)

    def is_limited(self, key: Hashable) -> bool:
        """True when the key already used up its window (does not record)."""
        with self._lock:
            return len(self._prune(key, self._clock())) >= self.max_events

    def record(self, key: Hashable) -> None:
        with self._lock:
            now = self._clock()
            self._prune(key, now)
            self._append(key, now)

    def hit(self, key: Hashable) -> bool:
        """Atomically record one event and return True if it was allowed."""
        with self._lock:
            now = self._clock()
            active = self._prune(key, now)
            if len(active) >= self.max_events:
                return False
            self._append(key, now)
            return True

    def reset(self, key: Hashable) -> None:
        with self._lock:
            self._events.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
            self._ops = 0
