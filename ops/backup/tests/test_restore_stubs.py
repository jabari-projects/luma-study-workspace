"""The restore copy must restore database-webhook triggers but never send web requests."""

from luma_backup.restore_test import SUPABASE_STUBS_SQL


def test_webhook_function_is_a_do_nothing_stand_in():
    sql = SUPABASE_STUBS_SQL.lower()
    assert "create schema if not exists supabase_functions" in sql
    assert "function supabase_functions.http_request() returns trigger" in sql
    body = sql.split("supabase_functions.http_request()", 1)[1]
    for word in ("net.", "http_post", "pg_net", "curl"):
        assert word not in body
