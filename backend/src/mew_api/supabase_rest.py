"""Supabase over HTTP (PostgREST and Storage): the plumbing shared by the stores.

Two modes:
- user: the publishable key plus the user's Clerk session token, so RLS scopes every row;
- service: the secret key (bypasses RLS), only for jobs that outlive a session token, after the
  caller's ownership was verified. Every query still filters on user_id, and every insert sets
  it, so a bug can't cross users even then.
"""

import json
import logging
from collections.abc import Iterable
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class StoreError(RuntimeError):
    """Supabase refused or failed a request (details are logged, not exposed)."""


class SupabaseRest:
    def __init__(
        self,
        url: str,
        *,
        api_key: str,
        user_token: str | None,
        client: httpx.Client | None = None,
    ) -> None:
        self.base = url.rstrip("/")
        headers = {"apikey": api_key}
        if user_token:
            headers["Authorization"] = f"Bearer {user_token}"
        self.service = user_token is None
        self.http = client or httpx.Client(timeout=20.0, follow_redirects=False)
        self.headers = headers

    # ─── HTTP ───────────────────────────────────────────────────────────────────────────────

    def _owned(self, user: str, row: dict[str, Any]) -> dict[str, Any]:
        # In user mode the database fills user_id from the token (and RLS checks it); in service
        # mode it must be set explicitly.
        return {**row, "user_id": user} if self.service else row

    def _get(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        rows = self._request("GET", f"/rest/v1/{table}", params={"select": "*", **params}).json()
        if not isinstance(rows, list):
            raise StoreError("unexpected response from Supabase")
        return rows

    def _insert(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        returning: bool = True,
        select: str = "*",
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        response = self._request(
            "POST",
            f"/rest/v1/{table}",
            params={"select": select} if returning else None,
            json=rows,
            headers={"Prefer": "return=representation" if returning else "return=minimal"},
        )
        return response.json() if returning else []

    def _patch(
        self, table: str, params: dict[str, str], fields: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Updates matching rows; returns them (empty when nothing matched)."""
        rows = self._request(
            "PATCH",
            f"/rest/v1/{table}",
            params=params,
            content=json.dumps(fields, default=str),
            headers={"Content-Type": "application/json", "Prefer": "return=representation"},
        ).json()
        return rows if isinstance(rows, list) else []

    def _delete(self, table: str, params: dict[str, str]) -> None:
        self._request("DELETE", f"/rest/v1/{table}", params=params)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        headers: dict[str, str] | None = None,
        ok: Iterable[int] = (),
    ) -> httpx.Response:
        try:
            response = self.http.request(
                method,
                f"{self.base}{path}",
                params=params,
                json=json,
                content=content,
                headers={**self.headers, **(headers or {})},
            )
        except httpx.HTTPError as error:
            raise StoreError(f"Supabase unreachable ({type(error).__name__})") from None
        if response.status_code in (401, 403):
            logger.info("Supabase refused %s %s: %s", method, path, response.status_code)
            raise PermissionError("not allowed")
        if response.is_error and response.status_code not in set(ok):
            logger.warning(
                "Supabase %s %s failed: %s %s",
                method,
                path,
                response.status_code,
                response.text[:300],
            )
            raise StoreError(f"Supabase request failed ({response.status_code})")
        return response
