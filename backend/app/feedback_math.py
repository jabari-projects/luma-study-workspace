"""Results math for monthly feedback (pure).

Percentages for each question come from the answers to THAT question only:
students who skipped a question are not counted in its Yes/No split.
Rounding is half-up and Yes % + No % is always exactly 100.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Optional


def percentages(yes: int, no: int) -> tuple[Optional[int], Optional[int]]:
    answered = yes + no
    if answered <= 0:
        return None, None
    yes_pct = (200 * yes + answered) // (2 * answered)
    return yes_pct, 100 - yes_pct


def question_result(row: dict, participants: int) -> dict:
    yes = int(row.get("yes_count") or 0)
    no = int(row.get("no_count") or 0)
    answered = yes + no
    yes_pct, no_pct = percentages(yes, no)
    return {
        "id": row["question_id"],
        "position": int(row["position"]),
        "label": row["label"],
        "yes": yes,
        "no": no,
        "answered": answered,
        "skipped": max(0, int(participants) - answered),
        "yes_pct": yes_pct,
        "no_pct": no_pct,
    }


def sort_key(q: dict):
    """Most-wanted change first: exact Yes ratio, then more answers, then position.

    Questions nobody answered go last. The exact fraction is compared, never the
    rounded percentage, so 2/3 sorts above 66/100.
    """
    answered = q["yes"] + q["no"]
    if answered == 0:
        return (1, Fraction(0), 0, q["position"])
    return (0, -Fraction(q["yes"], answered), -answered, q["position"])


def build_results(rows: list[dict]) -> tuple[int, list[dict]]:
    """rows from feedback_totals -> (participants, sorted question results)."""
    participants = int(rows[0].get("participants") or 0) if rows else 0
    questions = [question_result(row, participants) for row in rows]
    questions.sort(key=sort_key)
    return participants, questions
