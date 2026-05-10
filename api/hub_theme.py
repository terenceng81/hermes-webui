"""Server-side proxy for the Hermes Agent dashboard theme API at :9119.

Keeps cross-origin calls off the browser so Chrome's Private Network
Access and CORS policies don't block them.  All HTTP to localhost:9119
is done here on the server side.
"""
from __future__ import annotations

import json
import logging
import urllib.request

logger = logging.getLogger(__name__)

_BASE = "http://127.0.0.1:9119"
_TIMEOUT = 3.0


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
    try:
        payload = json.dumps({"name": str(name or "default")}).encode()
        req = urllib.request.Request(
            f"{_BASE}/api/dashboard/theme",
            data=payload,
            method="PUT",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        logger.debug("set dashboard theme failed: %s", exc)
        return {"error": str(exc)}
