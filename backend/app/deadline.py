"""A real wall-clock limit for slow outside calls (OpenAI, Deepgram).

HTTP client timeouts apply to each network step (connect, each read), not to the
whole call, so a slow answer can take longer than the timeout. `run_with_deadline`
gives up after a fixed total time no matter what, so the server always answers
before the browser stops waiting, and a late answer is never counted as a used
free AI turn (usage is only recorded after a call returns in time).
"""

from __future__ import annotations

import concurrent.futures
from typing import Callable, TypeVar

T = TypeVar("T")

# Shared pool for outside calls. A call that misses its deadline keeps running in
# the background until its own HTTP timeout ends it; its result is thrown away.
_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="ai-call")


class DeadlineExceeded(Exception):
    """The outside call did not finish within the total time limit."""


def run_with_deadline(fn: Callable[[], T], seconds: float) -> T:
    future = _EXECUTOR.submit(fn)
    try:
        return future.result(timeout=seconds)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise DeadlineExceeded(f"Call did not finish within {seconds:.0f} seconds") from exc
