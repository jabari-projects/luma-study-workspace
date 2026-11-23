"""The subject list file (app/data/subjects.json): shape, size and slugs that never go away."""

from __future__ import annotations

import json
import re

import pytest

from app import subjects

DATA = json.loads(subjects.DATA_FILE.read_text(encoding="utf-8"))
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def test_the_file_loads_and_has_every_subject_and_subtopic():
    assert subjects.SUBJECT_LIST["version"] == 1
    assert len(DATA["subjects"]) == 60
    assert sum(len(s["subtopics"]) for s in DATA["subjects"]) == 639
    assert all(5 <= len(s["subtopics"]) <= 15 for s in DATA["subjects"])


def test_slugs_are_short_lower_case_and_unique():
    slugs = [s["slug"] for s in DATA["subjects"]]
    assert len(slugs) == len(set(slugs))
    names = [s["name"].lower() for s in DATA["subjects"]]
    assert len(names) == len(set(names))
    for subject in DATA["subjects"]:
        assert SLUG.match(subject["slug"]) and len(subject["slug"]) <= 40
        subs = [t["slug"] for t in subject["subtopics"]]
        assert len(subs) == len(set(subs)), subject["slug"]
        assert all(SLUG.match(t) and len(t) <= 40 for t in subs)
        assert all(alias == alias.lower() for alias in subject.get("aliases", []))


def test_every_group_is_used():
    assert {g["slug"] for g in DATA["groups"]} == {s["group"] for s in DATA["subjects"]}


def test_owner_examples_are_on_the_list():
    # Owner feedback 2026-11-23: high school subjects and college majors, each with subtopics.
    def subs(slug):
        return {t["slug"] for t in next(s for s in DATA["subjects"] if s["slug"] == slug)["subtopics"]}

    assert {"programming", "data-structures", "networking", "math-for-cs"} <= subs("computer-science")
    assert {"basic-math", "algebra", "geometry", "calculus", "statistics"} <= subs("math")
    assert {"art-history", "art-theory"} <= subs("art")
    assert {"theory", "history"} <= subs("music")
    science = {s["slug"] for s in DATA["subjects"] if s["group"] == "science"}
    assert {"biology", "chemistry", "physics", "earth-space", "nanotech"} <= science
    history = [s for s in DATA["subjects"] if s["group"] == "history"]
    assert len(history) >= 6  # by region, each split into eras


def test_every_locked_slug_still_exists():
    """Slugs are forever: stored rows use them. Adding is fine; removing one fails here."""
    locked = [
        line.strip()
        for line in subjects.LOCK_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert len(locked) == 60 + 639
    for entry in locked:
        subject, _, subtopic = entry.partition("/")
        assert subjects.subject_exists(subject), entry
        if subtopic:
            assert subjects.subtopic_exists(subject, subtopic), entry


@pytest.mark.parametrize(
    "broken",
    [
        {"version": "1"},
        {"subject_slug_bad": True},
        {"subtopics": 3},
        {"repeat_subtopic": True},
        {"upper_alias": True},
        {"unknown_group": True},
    ],
)
def test_a_broken_file_stops_the_app(broken):
    data = json.loads(json.dumps(DATA))
    first = data["subjects"][0]
    if "version" in broken:
        data["version"] = broken["version"]
    if broken.get("subject_slug_bad"):
        first["slug"] = "Math!"
    if broken.get("subtopics"):
        first["subtopics"] = first["subtopics"][:3]
    if broken.get("repeat_subtopic"):
        first["subtopics"].append(dict(first["subtopics"][0]))
    if broken.get("upper_alias"):
        first["aliases"] = ["Maths"]
    if broken.get("unknown_group"):
        first["group"] = "nope"
    with pytest.raises(subjects.SubjectListError):
        subjects.load_subject_list(json.dumps(data).encode("utf-8"))


def test_check_pair_messages():
    assert subjects.check_pair(None, None) == (None, None)
    assert subjects.check_pair("math", "algebra") == ("math", "algebra")
    assert subjects.check_pair("math", None) == ("math", None)
    with pytest.raises(ValueError, match="^Pick a subject from the list.$"):
        subjects.check_pair("not-a-subject", None)
    with pytest.raises(ValueError, match="^Pick a subject first.$"):
        subjects.check_pair(None, "algebra")
    with pytest.raises(ValueError, match="^Pick a subtopic from the list for this subject.$"):
        subjects.check_pair("biology", "algebra")


def test_retired_entries_stay_valid(monkeypatch):
    # "retired": true only hides an entry from the picker; stored rows keep working.
    monkeypatch.setitem(subjects._SUBJECTS["math"], "retired", True)
    assert subjects.check_pair("math", "algebra") == ("math", "algebra")


def test_subject_names_and_aliases_turn_into_search_pairs():
    assert ("math", "algebra") in subjects.subjects_matching("Algebra")
    assert ("us-history", None) in subjects.subjects_matching("apush")
    assert ("biology", None) in subjects.subjects_matching("bio ")
    assert subjects.subjects_matching("1+1") == []
    assert subjects.subjects_matching("ab") == []  # too short to mean a subject
