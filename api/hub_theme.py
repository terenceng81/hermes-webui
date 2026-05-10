"""Server-side proxy for the Hermes Agent dashboard theme API at :9119.

Keeps cross-origin calls off the browser so Chrome's Private Network
Access and CORS policies don't block them.  All HTTP to localhost:9119
is done here on the server side.

The dashboard protects mutating endpoints with an ephemeral session token
injected into its SPA HTML as window.__HERMES_SESSION_TOKEN__.  We scrape
it once per process lifetime (re-fetched on 401 so restarts are handled).
"""
from __future__ import annotations

import json
import logging
import re
import urllib.request

logger = logging.getLogger(__name__)

_BASE = "http://127.0.0.1:9119"
_TIMEOUT = 3.0
_SESSION_TOKEN: str | None = None  # cached; re-fetched on 401


def _fetch_session_token() -> str | None:
    """Scrape __HERMES_SESSION_TOKEN__ from the dashboard HTML."""
    try:
        req = urllib.request.Request(
            f"{_BASE}/",
            headers={"Accept": "text/html"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            html = r.read().decode(errors="replace")
        m = re.search(r'__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"', html)
        return m.group(1) if m else None
    except Exception as exc:
        logger.debug("fetch session token failed: %s", exc)
        return None


def _auth_headers() -> dict:
    global _SESSION_TOKEN
    if not _SESSION_TOKEN:
        _SESSION_TOKEN = _fetch_session_token()
    if _SESSION_TOKEN:
        return {
            "X-Hermes-Session-Token": _SESSION_TOKEN,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    return {"Content-Type": "application/json", "Accept": "application/json"}


def get_active_theme() -> dict:
    """Proxy GET /api/dashboard/themes → {themes, active}."""
    try:
        req = urllib.request.Request(
            f"{_BASE}/api/dashboard/themes",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        logger.debug("get dashboard themes failed: %s", exc)
        return {"error": str(exc)}


def set_active_theme(name: str) -> dict:
    """Proxy PUT /api/dashboard/theme with {name}."""
    global _SESSION_TOKEN

    def _do_put() -> dict:
        payload = json.dumps({"name": str(name or "default")}).encode()
        req = urllib.request.Request(
            f"{_BASE}/api/dashboard/theme",
            data=payload,
            method="PUT",
            headers=_auth_headers(),
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode())

    try:
        return _do_put()
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            # Token expired (dashboard restarted) — refresh and retry once
            logger.debug("dashboard PUT 401 — refreshing session token")
            _SESSION_TOKEN = _fetch_session_token()
            try:
                return _do_put()
            except Exception as exc2:
                logger.debug("set dashboard theme retry failed: %s", exc2)
                return {"error": str(exc2)}
        logger.debug("set dashboard theme failed: %s", exc)
        return {"error": str(exc)}
    except Exception as exc:
        logger.debug("set dashboard theme failed: %s", exc)
        return {"error": str(exc)}
