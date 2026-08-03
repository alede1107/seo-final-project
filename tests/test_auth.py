import unittest
from unittest.mock import patch

from backend import app as app_module
from backend import auth as auth_module


class AuthChainTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_session_token_mints_stable_token_and_authenticates(self):
        # Firebase is verified only here; the rest of the chain uses the app token.
        with patch.object(auth_module, "verify_id_token", return_value="uid-abc"):
            first = self.client.post(
                "/api/session-token",
                json={"id_token": "fake", "email": "user@example.com"},
            )
            self.assertEqual(first.status_code, 200)
            token = first.get_json()["app_token"]
            self.assertTrue(token)

            # A second login for the same uid returns the *same* stable token.
            second = self.client.post(
                "/api/session-token", json={"id_token": "fake"}
            )
            self.assertEqual(second.get_json()["app_token"], token)

        # /api/me resolves the app token to the uid without touching Firebase.
        me = self.client.get("/api/me", headers={"X-App-Token": token})
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.get_json(), {"uid": "uid-abc", "signed_in": True})

    def test_me_is_guest_without_or_with_unknown_token(self):
        guest = self.client.get("/api/me")
        self.assertEqual(guest.get_json(), {"uid": None, "signed_in": False})

        bogus = self.client.get("/api/me", headers={"X-App-Token": "not-a-real-token"})
        self.assertEqual(bogus.get_json(), {"uid": None, "signed_in": False})

    def test_session_token_requires_id_token(self):
        response = self.client.post("/api/session-token", json={})
        self.assertEqual(response.status_code, 400)

    def test_session_token_rejects_invalid_firebase_token(self):
        with patch.object(
            auth_module, "verify_id_token", side_effect=ValueError("bad token")
        ):
            response = self.client.post(
                "/api/session-token", json={"id_token": "bad"}
            )
        self.assertEqual(response.status_code, 401)

    def test_verify_request_never_raises_on_bad_resolver(self):
        def boom(_token):
            raise RuntimeError("store down")

        with app_module.app.test_request_context(
            "/api/me", headers={"X-App-Token": "x"}
        ):
            self.assertIsNone(auth_module.verify_request(boom))

    def test_cors_headers_allow_app_token(self):
        response = self.client.get("/api/health")
        self.assertIn("X-App-Token", response.headers["Access-Control-Allow-Headers"])


if __name__ == "__main__":
    unittest.main()
