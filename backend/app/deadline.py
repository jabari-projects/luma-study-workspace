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

# Hard deadlines of Luma's long requests, in one place. The routes that do the work (main.py,
# capture.py, link_import.py) cut a request off at these, and the maintenance gate
# (maintenance.py) records each running job with the same deadline, so a break never treats a
# job as finished while its request can still be running.
# Each AI HTTP step may take up to its own timeout (main.py), but the whole call is cut off at
# the deadline (a true total), which is shorter than the browser's wait (notes 120 s,
# transcription 180 s; see frontend/src/capture/capture-api.ts).
AI_NOTES_DEADLINE_SECONDS = 100.0
AI_TRANSCRIBE_DEADLINE_SECONDS = 150.0
# Wall-clock budget for one whole link import (DNS + every redirect hop + body).
FETCH_DEADLINE_SECONDS = 20.0

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
