"""Pure feedback logic: comment cleaning, urgent flags, results math, local themes."""

import random
import time
from fractions import Fraction

import pytest

from app import feedback_math as fm
from app import feedback_text as ft
from app import feedback_themes as th


# ---------------------------------------------------------------- comments


def test_comment_limit_is_500_code_points():
    assert ft.COMMENT_MAX == 500
    assert ft.clean_comment("a" * 500) == "a" * 500
    assert ft.clean_comment("\U0001F600" * 500) == "\U0001F600" * 500
    with pytest.raises(ft.CommentTooLong):
        ft.clean_comment("a" * 501)
    assert ft.clean_comment("  \n\t ") is None
    assert ft.clean_comment(None) is None


def test_comment_cleaning():
    assert ft.clean_comment("a\r\nb\rc") == "a\nb\nc"
    assert ft.clean_comment("one\n\n\n\n\ntwo") == "one\n\ntwo"
    assert ft.clean_comment("é") == "é"
    assert ft.clean_comment("x​y‮z⁦w﻿") == "xyzw"
    assert ft.clean_comment("tab\there\x00\x1b\x7f\x85") == "tab\there"
    html = "<script>alert(1)</script>"
    assert ft.clean_comment(html) == html  # stored as text; shown only as text


@pytest.mark.parametrize(
    "text,flags",
    [
        ("my account got hacked", ["security"]),
        ("someone else's account showed up", ["security"]),
        ("screen reader can't read the cards", ["accessibility"]),
        ("other people can see my notes", ["privacy"]),
        ("my password and my email were exposed", ["security", "privacy"]),
        ("add a dark mode", []),
    ],
)
def test_urgent_flags(text, flags):
    assert ft.urgent_flags(text) == flags


def test_question_lint():
    out = ft.question_lint(["Add a dark mode", "Add quizzes and games", "Don't change colors", "Keep the font", "Add A/B tests"])
    assert {(w["position"], w["message"]) for w in out} == {
        (2, ft.LINT_TWO_CHANGES), (3, ft.LINT_NEGATIVE), (4, ft.LINT_NEGATIVE), (5, ft.LINT_TWO_CHANGES)}


# ---------------------------------------------------------------- results math


@pytest.mark.parametrize(
    "yes,no,expected",
    [(1, 7, (13, 87)), (5, 3, (63, 37)), (1, 2, (33, 67)), (2, 1, (67, 33)), (1, 1, (50, 50)),
     (0, 5, (0, 100)), (1, 0, (100, 0)), (3, 1, (75, 25)), (0, 0, (None, None))],
)
def test_percentages(yes, no, expected):
    assert fm.percentages(yes, no) == expected


def test_percentages_always_sum_to_100():
    for answered in range(1, 301):
        for yes in range(answered + 1):
            y, n = fm.percentages(yes, answered - yes)
            assert 0 <= y <= 100 and 0 <= n <= 100 and y + n == 100


def row(qid, pos, yes, no, participants=10):
    return {"question_id": qid, "position": pos, "label": f"Q{pos}", "yes_count": yes, "no_count": no, "participants": participants}


def test_skipped_and_answered():
    participants, qs = fm.build_results([row("a", 1, 3, 1, 6)])
    assert participants == 6 and qs[0]["answered"] == 4 and qs[0]["skipped"] == 2
    assert (qs[0]["yes_pct"], qs[0]["no_pct"]) == (75, 25)


def test_sort_uses_exact_fraction_then_answers_then_position():
    rows = [
        row("never", 1, 0, 0),
        row("sixty-six", 2, 66, 34, 100),
        row("two-thirds", 3, 2, 1),
        row("tie-few", 4, 1, 1),
        row("tie-many", 5, 4, 4),
        row("tie-many-later", 6, 4, 4),
    ]
    _p, qs = fm.build_results(rows)
    assert [q["id"] for q in qs] == ["two-thirds", "sixty-six", "tie-many", "tie-many-later", "tie-few", "never"]
    assert Fraction(2, 3) > Fraction(66, 100)


def test_no_votes_at_all():
    participants, qs = fm.build_results([row("a", 1, 0, 0, 0)])
    assert participants == 0 and qs[0]["yes_pct"] is None
    assert fm.build_results([]) == (0, [])


# ---------------------------------------------------------------- themes


def group(texts):
    return th.group_comments([(f"r{i:03d}", t) for i, t in enumerate(texts)])


def test_repeated_words_count_once():
    out = group(["dark mode dark mode dark mode", "dark mode"])
    assert out["themes"][0]["response_ids"] == ["r000", "r001"]


def test_synonyms_group_into_one_theme():
    out = group(["dark mode please", "Please add a dark mode!!", "night mode", "more quizzes"])
    top = out["themes"][0]
    assert top["label"].lower() == "dark mode" and len(top["response_ids"]) == 3
    assert out["other"] == ["r003"]


def test_single_mentions_go_to_other():
    out = group(["dark mode", "faster cards", "bigger buttons"])
    assert out["themes"] == [] and len(out["other"]) == 3


def test_shuffled_input_gives_identical_output():
    texts = ["dark mode please", "night mode", "faster flashcards", "cards load slow", "laggy decks",
             "dark theme", "quiz mode", "quizzes please", "mobile app", "phone app"]
    items = [(f"r{i}", t) for i, t in enumerate(texts)]
    expected = th.group_comments(items)
    for seed in range(5):
        shuffled = items[:]
        random.Random(seed).shuffle(shuffled)
        assert th.group_comments(shuffled) == expected


def test_the_most_popular_theme_is_never_dropped():
    # 7 of 10 comments ask for the same change: it must be the top theme, not "Other".
    texts = ["I want dark mode"] * 7 + ["faster quizzes", "more quizzes please", "bigger buttons"]
    out = group(texts)
    top = out["themes"][0]
    assert top["label"] == "Dark mode" and len(top["response_ids"]) == 7
    assert not set(top["response_ids"]) & set(out["other"])


def test_filler_words_in_most_comments_form_no_theme():
    texts = [f"please add {w} to the app" for w in ("timers", "colors", "sounds", "games", "music", "fonts")] * 2
    labels = {t["label"].lower() for t in group(texts)["themes"]}
    assert not labels & {"please", "add", "app", "please add"}


def test_theme_labels_use_the_students_own_words():
    out = group(["faster quizzes", "more quizzes please", "quizzes take too long"])
    assert out["themes"][0]["label"] == "Quizzes"
    pair = group(["quizzes timers now", "quizzes timers please", "dark mode"])
    assert (pair["themes"][0]["term"], pair["themes"][0]["label"]) == ("quizz timer", "Quizzes timers")


def test_themes_are_sorted_by_distinct_people():
    out = group(["dark mode", "dark mode", "dark mode", "quizzes", "quizzes"])
    assert [len(t["response_ids"]) for t in out["themes"]] == [3, 2]


def test_grouping_is_fast_enough():
    rng = random.Random(1)
    words = "dark mode faster cards quizzes mobile app font bigger buttons sync offline export share print".split()
    texts = [" ".join(rng.choice(words) for _ in range(150))[:500] for _ in range(500)]
    start = time.perf_counter()
    th.group_comments([(str(i), t) for i, t in enumerate(texts)])
    assert time.perf_counter() - start < 2.0
