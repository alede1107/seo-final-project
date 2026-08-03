"""
Account identity for personal ASL clips.

Firebase verifies the user *once* (POST /api/session-token consumes the Firebase
ID token). Every subsequent request - website and extension - carries a stable
opaque `app_token` in the `X-App-Token` header, which the caption/clip routes
resolve back to a uid without touching Firebase. So `firebase-admin` is only ever
called at token issuance, never on the caption-read hot path.
"""

import json
import os

from flask import request

_app = None
_init_error = None


def _load_credentials():
    from firebase_admin import credentials

    inline = os.environ.get("FIREBASE_CREDENTIALS_JSON", "").strip()
    if inline:
        return credentials.Certificate(json.loads(inline))
    path = (
        os.environ.get("FIREBASE_CREDENTIALS", "").strip()
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    )
    if path:
        return credentials.Certificate(path)
    # Falls back to workload/application-default credentials when available.
    return credentials.ApplicationDefault()


def _get_firebase_app():
    """Lazily initialize firebase-admin. Returns None (and caches the failure)
    when Firebase is not configured, so callers can degrade to guest."""
    global _app, _init_error
    if _app is not None or _init_error is not None:
        return _app
    try:
        import firebase_admin

        if firebase_admin._apps:
            _app = firebase_admin.get_app()
        else:
            _app = firebase_admin.initialize_app(_load_credentials())
    except Exception as exc:  # noqa: BLE001 - config/credential errors vary.
        _init_error = exc
        _app = None
    return _app


def verify_id_token(id_token):
    """Verify a Firebase ID token and return its uid. Raises on any failure
    (missing config, invalid/expired token) - the caller maps that to 401."""
    from firebase_admin import auth as fb_auth

    app = _get_firebase_app()
    if app is None:
        raise RuntimeError("Firebase authentication is not configured")
    decoded = fb_auth.verify_id_token(id_token, app=app)
    return decoded["uid"]


def app_token_from_request():
    """Read the opaque app token from X-App-Token (or Authorization: Bearer)."""
    token = request.headers.get("X-App-Token", "").strip()
    if not token:
        header = request.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
    return token or None


def verify_request(resolve_uid):
    """Return the uid for this request's app token, or None for a guest.

    `resolve_uid` maps an app_token -> uid (pipeline.uid_for_token or the cloud
    store equivalent). Never raises: any missing/unknown token is treated as a
    guest so unauthenticated requests keep working with default clips.
    """
    try:
        token = app_token_from_request()
        if not token:
            return None
        return resolve_uid(token)
    except Exception:  # noqa: BLE001 - guest fallback must be total.
        return None
