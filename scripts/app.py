"""Convenience entrypoint for the CaptionAid backend.

Run this file from the repository root with ``python3 app.py`` (WSL/macOS)
or ``python app.py`` (Windows).
"""

try:
    from backend.app import app, run
except ModuleNotFoundError as exc:
    raise SystemExit(
        f"Missing Python dependency '{exc.name}'. "
        "Install the backend once with: python3 -m pip install -r requirements.txt"
    ) from exc


if __name__ == "__main__":
    run()
