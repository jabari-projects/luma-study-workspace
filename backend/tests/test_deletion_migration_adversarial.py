"""Adversarial checks for account deletion and the password migration.

Fakes only: no Supabase, Stripe or network. Tests marked xfail(strict=True)
document a defect that is still present; they flip to XPASS (and fail the
run) once the defect is fixed, so the marker must then be removed.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from types import SimpleNamespace

import jwt
import pytest

from app import account_deletion as ad
from app import auth as auth_module
from app import main, passwords
from app.auth import create_access_token

from tests.test_account_deletion import (  # noqa: F401  (route_env is a fixture)
    OTHER,
    USER,
    USER_EMAIL,
    DBWrapper,
    FakeDB,
    FakeStripe,
    delete_account,
    make_deps,
    outcomes,
    route_env,
)
from tests import test_password_migration as pm
from tests.test_password_migration import db, clear_login_limiter, logs  # noqa: F401


# ---------------------------------------------------------------- deletion


def test_prefix_collision_ab_vs_abc_does_not_touch_neighbour():
    fake = FakeDB()
    fake.tables["users"] = [{"id": "ab", "email": "ab@example.test", "password": "x"},
                            {"id": "abc", "email": "abc@example.test", "password": "x"}]
    fake.tables["profiles"] = [{"user_id": "ab"}, {"user_id": "abc"}]
    for t in ("notes", "flashcards"):
        fake.tables[t] = [{"id": f"{t}1", "user_id": "ab"}, {"id": f"{t}2", "user_id": "abc"}]
    fake.storage = {
        "avatars": {"ab/1.png", "abc/2.png", "ab-c/3.png", "abX.png"},
        "themes": {"themes/ab/1.png", "themes/abc/2.png"},
    }
    report = ad.delete_account_data("ab", make_deps(fake))
    assert report.succeeded, outcomes(report)
    assert fake.storage["avatars"] == {"abc/2.png", "ab-c/3.png", "abX.png"}
    assert fake.storage["themes"] == {"themes/abc/2.png"}
    assert [r["id"] for r in fake.tables["users"]] == ["abc"]
    assert fake.tables["notes"] == [{"id": "notes2", "user_id": "abc"}]


@pytest.mark.parametrize("bad", ["", " ", "a/b", "..", "a\\b", None, 5])
def test_unsafe_ids_make_no_calls(bad):
    fake = FakeDB()
    report = ad.delete_account_data(bad, make_deps(fake, FakeStripe()))
    assert not report.succeeded
    assert fake.calls == [] and fake.list_calls == []


def test_missing_column_error_is_not_mistaken_for_missing_table():
    fake = FakeDB()
    original = fake.maybe_fail

    def maybe_fail(op, target):
        if op == "delete" and target == "notes":
            raise RuntimeError('42703 column notes.user_id does not exist')
        original(op, target)

    fake.maybe_fail = maybe_fail
    report = ad.delete_account_data(USER, make_deps(fake))
    assert outcomes(report)["table_notes"] == ad.FAILED
    assert any(r["id"] == USER for r in fake.tables["users"])


def test_silent_zero_row_table_delete_keeps_users_row():
    fake = FakeDB()

    class SilentQuery:
        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            attr = getattr(self.inner, name)
            if callable(attr) and name != "execute":
                def wrapper(*a, **k):
                    attr(*a, **k)
                    return self
                return wrapper
            return attr

        def execute(self):
            if self.inner.op == "delete" and self.inner.table == "notes":
                return SimpleNamespace(data=[])  # RLS: nothing affected, no error
            return self.inner.execute()

    wrapper = DBWrapper(fake)
    wrapper.table = lambda name: SilentQuery(fake.table(name))
    deps = ad.DeletionDeps(db=wrapper, storage_page_size=fake.page_size)
    report = ad.delete_account_data(USER, deps)
    leftover = [r for r in fake.tables["notes"] if r["user_id"] == USER]
    assert leftover  # the study notes really are still there
    assert not report.succeeded
    assert any(r["id"] == USER for r in fake.tables["users"])


@pytest.mark.parametrize("fail_op,target", [
    ("delete", "profiles"), ("update", "notifications"), ("storage_remove", "avatars"),
    ("delete", "ai_usage"), ("select", "billing_accounts"),
])
def test_users_row_survives_any_failure_and_retry_is_idempotent(fail_op, target):
    fake = FakeDB()
    stripe = FakeStripe()
    fake.fail(fail_op, target)
    first = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert not first.succeeded
    assert any(r["id"] == USER for r in fake.tables["users"])
    second = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert second.succeeded, outcomes(second)
    third = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert third.succeeded
    assert stripe.calls == [("cancel", "sub_mine")]  # never canceled twice
    assert any(r["id"] == OTHER for r in fake.tables["users"])
    assert f"{OTHER}/keep.png" in fake.storage["avatars"]


def test_stripe_cancel_that_errors_after_succeeding_server_side():
    fake = FakeDB()
    stripe = FakeStripe()
    real_cancel = stripe.Subscription.cancel

    calls = {"n": 0}

    def flaky_cancel(sub_id, **kwargs):
        calls["n"] += 1
        real_cancel(sub_id, **kwargs)
        if calls["n"] == 1:
            raise RuntimeError("timeout after commit")

    stripe.Subscription = SimpleNamespace(list=stripe.Subscription.list, retrieve=stripe.Subscription.retrieve,
                                          cancel=flaky_cancel)
    first = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert "cancel_subscription" in first.failed_steps
    assert any(r["id"] == USER for r in fake.tables["users"])
    second = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert second.succeeded
    assert calls["n"] == 1  # retry saw "canceled" and did not cancel again
    assert stripe.subscriptions["sub_other"] == "active"


def test_storage_paging_exact_multiple_and_many_files():
    fake = FakeDB(page_size=3)
    fake.storage["avatars"] = {f"{USER}/f{i:02d}.png" for i in range(9)} | {f"{OTHER}/keep.png"}
    report = ad.delete_account_data(USER, make_deps(fake))
    assert report.succeeded
    assert fake.storage["avatars"] == {f"{OTHER}/keep.png"}


def test_storage_listing_that_ignores_offset_is_bounded():
    fake = FakeDB(page_size=2)
    fake.storage["avatars"] = {f"{USER}/a.png", f"{USER}/b.png", f"{USER}/c.png"}
    calls = {"n": 0}

    class StuckBucket:
        def list(self, path=None, options=None):
            calls["n"] += 1
            if calls["n"] > 50:
                raise RuntimeError("loop guard tripped")
            return [{"name": "a.png", "id": "1", "metadata": {}}, {"name": "b.png", "id": "2", "metadata": {}}]

        def remove(self, paths):
            return []

    wrapper = DBWrapper(fake)
    wrapper.storage = SimpleNamespace(from_=lambda name: StuckBucket())
    ad.delete_account_data(USER, ad.DeletionDeps(db=wrapper, storage_page_size=2))
    assert calls["n"] <= 10


def test_logs_do_not_leak_names_even_when_errors_carry_them(caplog):
    fake = FakeDB()
    original = fake.maybe_fail

    def maybe_fail(op, target):
        if op == "storage_remove":
            raise RuntimeError(f"cannot remove {USER}/My Holiday Photo (1).JPG for {USER_EMAIL}")
        original(op, target)

    fake.maybe_fail = maybe_fail
    caplog.set_level(logging.DEBUG)
    ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    text = "\n".join(r.getMessage() for r in caplog.records)
    for leak in (USER, USER_EMAIL, "Holiday", "secret study", "sk_test_fake"):
        assert leak not in text


def test_responses_never_claim_everything_deleted():
    for text in (ad.SUCCESS_MESSAGE, ad.FAILURE_DETAIL, *ad.DeletionReport().retained):
        assert "everything" not in text.lower()
        assert "all your data" not in text.lower()


def test_failure_message_is_honest_about_partial_deletion():
    fake = FakeDB()
    fake.fail("delete", "profiles")
    report = ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    assert not report.succeeded
    assert not [r for r in fake.tables["notes"] if r["user_id"] == USER]  # already gone
    assert "nothing important was lost" not in ad.FAILURE_DETAIL.lower()


def _token_without_pv(uid):
    secret = auth_module.get_jwt_secret_key()
    return jwt.encode({"sub": uid, "type": "access", "exp": datetime.utcnow() + timedelta(hours=1)},
                      secret, algorithm=auth_module.JWT_ALGORITHM)


def test_pv_token_rejected_after_deletion(route_env):  # noqa: F811
    headers = {"Authorization": f"Bearer {create_access_token({'sub': USER})}"}
    assert delete_account(route_env.client, headers).status_code == 200
    assert route_env.client.get("/notifications", headers=headers).status_code == 401


def test_token_without_pv_is_always_rejected(route_env):  # noqa: F811
    # Every token Luma issues carries pv, so one without it is refused even
    # while the account still exists.
    old = {"Authorization": f"Bearer {_token_without_pv(USER)}"}
    assert route_env.client.get("/notifications", headers=old).status_code == 401
    assert delete_account(route_env.client, old).status_code == 401


# ---------------------------------------------------------------- migration


@pytest.mark.parametrize("argv", [
    ["--apply"],
    ["--apply", "--dry-run", "--i-have-a-backup"],
    ["--apply", "--verify", "--i-have-a-backup"],
    ["--apply", "--i-have-a-backup=yes"],
    ["--apply", "--batch-size", "0", "--i-have-a-backup"],
    ["--apply", "--batch-size", "1001", "--i-have-a-backup"],
])
def test_apply_guard_cannot_be_bypassed(db, capsys, argv):  # noqa: F811
    pm.mixed_table(db)
    code, _out, _err = pm.run(db, *argv, capsys=capsys)
    assert code == 2
    assert db.update_calls() == []


def test_backup_flag_without_apply_writes_nothing(db, capsys):  # noqa: F811
    pm.mixed_table(db)
    code, out, _ = pm.run(db, "--i-have-a-backup", capsys=capsys)
    assert code == 0 and db.update_calls() == []
    assert "DRY RUN" in out


def test_hash_failure_with_secret_in_message_does_not_leak(db, capsys, logs, monkeypatch):  # noqa: F811
    plain, _ = pm.mixed_table(db)

    def boom(pw):
        raise ValueError(f"cannot hash {pw}")

    monkeypatch.setattr(pm.migration, "hash_password", boom)
    code, out, err = pm.run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert code == 1
    assert pm.parse_counts(out)["failed"] == 5
    pm.assert_no_secrets(out + err + logs.text, db, plain.values())
    for row in db.users():
        if row["id"] in plain:
            assert row["password"] == plain[row["id"]]  # untouched, not half-written


def test_repeat_runs_never_double_hash_and_login_still_works(db, capsys):  # noqa: F811
    plain, hashed = pm.mixed_table(db)
    for _ in range(3):
        code, _o, _e = pm.run(db, "--apply", "--i-have-a-backup", capsys=capsys)
        assert code == 0
    assert all(v == 1 for v in db.writes_per_id.values())
    for uid, pw in {**plain, **hashed}.items():
        stored = db.user(uid)["password"]
        assert stored.startswith("$argon2") and passwords.verify_password(stored, pw)[0]
        # no plaintext fallback: the stored hash itself is not accepted as a password
        assert passwords.verify_password(stored, stored) == (False, False)


def test_migration_logs_out_old_pv_sessions(db, capsys, monkeypatch):  # noqa: F811
    plain, _ = pm.mixed_table(db)
    uid = next(iter(plain))
    token = create_access_token({"sub": uid})
    assert auth_module.validate_access_token(token)["id"] == uid
    pm.run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    with pytest.raises(Exception) as info:
        auth_module.validate_access_token(token)
    assert getattr(info.value, "status_code", None) == 401  # expected side effect: re-login needed


def test_verify_with_zero_visible_rows_is_not_a_pass(db, capsys):  # noqa: F811
    # db has no rows visible, as with an anon key under RLS.
    code, out, _ = pm.run(db, "--verify", capsys=capsys)
    assert pm.parse_counts(out)["checked"] == 0
    assert code != 0


@pytest.mark.xfail(strict=True, reason="The script alone can't detect a row changed to a DIFFERENT plaintext mid-run. "
                   "In production this is prevented by the database: backend/app/schemas/password_hash_guard.sql rejects "
                   "any plaintext password write, and the script refuses --apply unless that guard reports installed "
                   "(see test_apply_refuses_without_the_plaintext_guard; the trigger itself is proven on Postgres by the "
                   "PGlite guard check). This fake database doesn't emulate the trigger, so the scenario still fails here.")
def test_row_changed_to_other_plaintext_mid_run_keeps_new_password(db, capsys):  # noqa: F811
    plain, _ = pm.mixed_table(db)
    uid = next(iter(plain))
    seen = set()

    def legacy_writer(target_id):
        if target_id == uid and uid not in seen:
            seen.add(uid)
            db.user(uid)["password"] = "Zq7-NEW-plaintext-xK"

    db.before_update = legacy_writer
    pm.run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert passwords.verify_password(db.user(uid)["password"], "Zq7-NEW-plaintext-xK")[0]


# ---------------------------------------------------------------- follow-up fixes


def test_deletion_refuses_without_service_role_key():
    fake = FakeDB()
    deps = make_deps(fake, FakeStripe())
    deps.privileged_db = False
    report = ad.delete_account_data(USER, deps)
    assert not report.succeeded and report.failed_steps == ["config"]
    assert fake.calls == [] and fake.list_calls == []


def test_build_deps_marks_anon_key_as_unprivileged():
    assert main.build_account_deletion_deps().privileged_db is bool(main.settings.SUPABASE_SERVICE_ROLE_KEY)


@pytest.mark.parametrize("code,expected", [("PGRST205", True), ("42P01", True), ("42703", False), (None, False)])
def test_missing_table_matches_codes_only(code, expected):
    exc = RuntimeError('relation or column "x" does not exist')
    exc.code = code
    assert ad._is_missing_table(exc) is expected


def test_passwordless_user_token_is_tied_to_the_row(monkeypatch):
    rows = {"u-nopw": ""}
    monkeypatch.setattr(auth_module, "_credential_lookup", lambda uid: rows.get(uid))
    token = create_access_token({"sub": "u-nopw"})
    assert "pv" in jwt.decode(token, options={"verify_signature": False})
    assert auth_module.validate_access_token(token)["id"] == "u-nopw"
    rows.clear()
    with pytest.raises(Exception) as info:
        auth_module.validate_access_token(token)
    assert getattr(info.value, "status_code", None) == 401


def test_script_refuses_anon_key_only(monkeypatch, capsys):
    import dataclasses

    from app import config, supabase_client

    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, SUPABASE_SERVICE_ROLE_KEY=None,
                                                                SUPABASE_URL="http://fake.invalid", SUPABASE_KEY="anon"))
    monkeypatch.setattr(supabase_client, "is_supabase_configured", lambda: True)
    monkeypatch.setattr(supabase_client, "get_supabase", lambda: (_ for _ in ()).throw(AssertionError("no client")))
    assert pm.migration.main(["--verify"]) == 2
    assert "SUPABASE_SERVICE_ROLE_KEY" in capsys.readouterr().err


def test_allow_empty_flag_accepts_an_empty_table(db, capsys):  # noqa: F811
    assert pm.run(db, "--verify", "--allow-empty", capsys=capsys)[0] == 0
    code, out, _ = pm.run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert code == 1 and "no rows were visible" in out
