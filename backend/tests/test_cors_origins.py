"""Which websites may call the API from a browser (CORS)."""

import pytest
from fastapi.testclient import TestClient

from app import main


def preflight(origin: str):
    client = TestClient(main.app)
    return client.options(
        "/login",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization",
        },
    )


@pytest.mark.parametrize(
    "origin",
    [
        "https://lumastudyhub.com",
        "https://www.lumastudyhub.com",
        "https://luma-frontend-ruby.vercel.app",
        "http://localhost:5173",
        # Luma's own Vercel preview builds.
        "https://luma-frontend-dxgnch0h1-jabarimckinney213-7284s-projects.vercel.app",
        "https://luma-frontend-git-claude-polish-b-jabarimckinney213-7284s-projects.vercel.app",
        "https://luma-frontend-jabarimckinney213-7284s-projects.vercel.app",
    ],
)
def test_luma_sites_are_allowed(origin):
    response = preflight(origin)
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == origin
    assert response.headers.get("access-control-allow-credentials") == "true"


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.vercel.app",
        "https://luma-frontend-evil.vercel.app",
        "https://luma-frontend-x-someone-else-projects.vercel.app",
        "https://luma-frontend-x-jabarimckinney213-7284s-projects.vercel.app.evil.com",
        "https://lumastudyhub.com.evil.com",
        "https://evil-lumastudyhub.com",
        "http://lumastudyhub.com",
        "https://lumastudy.com",
    ],
)
def test_other_sites_are_refused(origin):
    response = preflight(origin)
    assert response.headers.get("access-control-allow-origin") is None


def test_no_wildcard_left_in_exact_list():
    assert all("*" not in origin for origin in main.origins)
