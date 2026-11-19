"""Local, deterministic grouping of feedback comments into themes (pure, no I/O).

No AI service and no network: comments never leave Luma. The same input always
gives the same output, whatever order the comments arrive in.

A theme counts DISTINCT respondents: each comment contributes a set of terms,
so writing "dark mode dark mode dark mode" counts once.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Iterable

MAX_THEMES = 30
MERGE_JACCARD = 0.6
# No "too common" ceiling: STOPWORDS already drop filler words, and the change most
# students ask for must never vanish just because it is popular.

_URL = re.compile(r"(https?://\S+|www\.\S+)")
_EMAIL = re.compile(r"\S+@\S+")
_DIGITS = re.compile(r"\d+")
_TOKEN = re.compile(r"[a-z']+")

STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are aren't as at be because been before being
    below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't
    down during each few for from further had hadn't has hasn't have haven't having he her here hers
    herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just let's
    me might more most mustn't my myself no nor not now of off on once only or other ought our ours
    ourselves out over own same shan't she should shouldn't so some such than that that's the their
    theirs them themselves then there there's these they they'd they'll they're they've this those
    through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's
    when when's where where's which while who who's whom why why's will with won't would wouldn't you
    you'd you'll you're you've your yours yourself yourselves also get got thing things lot lots
    luma app site website please add make want would like really more better change feature features
    pls plz thanks thank maybe could need needs think good great nice love
    """.split()
)

_SYNONYM_PHRASES = (
    ("night mode", "dark mode"),
    ("dark theme", "dark mode"),
    ("flash cards", "flashcard"),
    ("flash card", "flashcard"),
)
_SYNONYM_WORDS = {
    "cards": "flashcard",
    "card": "flashcard",
    "deck": "flashcard",
    "decks": "flashcard",
    "flashcards": "flashcard",
    "phone": "mobile",
    "phones": "mobile",
    "slow": "speed",
    "lag": "speed",
    "laggy": "speed",
    "loading": "speed",
}


def _stem(word: str) -> str:
    if word.endswith("ies") and len(word) - 3 >= 3:
        return word[:-3] + "y"
    for suffix in ("ing", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3 and not word.endswith("ss"):
            return word[: -len(suffix)]
    return word


def _tokens(text: str) -> list[tuple[str, str]]:
    """[(normalized term, original surface word)]"""
    value = unicodedata.normalize("NFKC", text or "").casefold().replace("’", "'")
    value = _URL.sub(" ", value)
    value = _EMAIL.sub(" ", value)
    value = _DIGITS.sub(" ", value)
    for phrase, target in _SYNONYM_PHRASES:
        value = value.replace(phrase, target)
    out = []
    for raw in _TOKEN.findall(value):
        word = raw.strip("'")
        if not word or word in STOPWORDS:
            continue
        if word in _SYNONYM_WORDS:
            word = _SYNONYM_WORDS[word]
        elif " " not in word:
            word = _stem(word)
        if len(word) < 3 or word in STOPWORDS:
            continue
        out.append((word, raw.strip("'")))
    return out


def comment_terms(text: str) -> tuple[set[str], dict[str, str]]:
    """Set of unigrams + adjacent bigrams, and a surface form for each term."""
    toks = _tokens(text)
    terms: set[str] = set()
    surface: dict[str, str] = {}
    for term, raw in toks:
        terms.add(term)
        surface.setdefault(term, raw)  # the student's own word, e.g. "quizzes" (not "quizz")
    for (a, ra), (b, rb) in zip(toks, toks[1:]):
        if a == b:
            continue
        bigram = f"{a} {b}"
        terms.add(bigram)
        surface.setdefault(bigram, f"{ra} {rb}")
    return terms, surface


def _jaccard(a: frozenset, b: frozenset) -> float:
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def group_comments(comments: Iterable[tuple[str, str]]) -> dict:
    """comments: (response_id, text). Returns
    {"themes": [{"term", "label", "response_ids"}], "other": [response_id, ...]}
    sorted by (-distinct members, label)."""
    items = sorted(((str(rid), text or "") for rid, text in comments), key=lambda x: x[0])
    members: dict[str, set[str]] = {}
    labels: dict[str, Counter] = {}
    for rid, text in items:
        terms, surface = comment_terms(text)
        for term in terms:
            members.setdefault(term, set()).add(rid)
            labels.setdefault(term, Counter())[surface[term]] += 1
    candidates = [term for term, ids in members.items() if len(ids) >= 2]
    candidates.sort(key=lambda t: (-len(members[t]), 0 if " " in t else 1, t))

    themes: list[dict] = []
    for term in candidates:
        ids = frozenset(members[term])
        merged = False
        for theme in themes:
            if " " not in term and theme["ids"] == ids and term in theme["term"].split(" "):
                merged = True  # a word inside a chosen phrase with the same people
                break
            if _jaccard(theme["ids"], ids) >= MERGE_JACCARD:
                theme["ids"] = theme["ids"] | ids
                merged = True
                break
        if merged:
            continue
        if len(themes) >= MAX_THEMES:
            continue
        themes.append({"term": term, "ids": ids})

    out = []
    grouped: set[str] = set()
    for theme in themes:
        counter = labels[theme["term"]]
        label = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        label = label[:1].upper() + label[1:]
        grouped |= theme["ids"]
        out.append({"term": theme["term"], "label": label[:80], "response_ids": sorted(theme["ids"])})
    out.sort(key=lambda t: (-len(t["response_ids"]), t["label"], t["term"]))
    other = [rid for rid, _ in items if rid not in grouped]
    return {"themes": out, "other": other}
