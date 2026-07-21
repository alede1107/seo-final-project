import unittest
from unittest.mock import patch

from backend import app as app_module


class CompanionApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_api_health_alias(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True})

    def test_signs_are_real_map_entries_with_search_and_pagination(self):
        word_map = {
            "book": "https://example.test/book.mp4",
            "bookshelf": "https://example.test/bookshelf.mp4",
            "hello": "https://example.test/hello.mp4",
        }
        with patch.object(app_module, "load_word_map", return_value=word_map):
            response = self.client.get("/api/signs?q=book&limit=1&offset=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["vocabulary_total"], 3)
        self.assertEqual(payload["matched_total"], 2)
        self.assertEqual(payload["items"][0]["word"], "BOOKSHELF")
        self.assertEqual(payload["items"][0]["url"], word_map["bookshelf"])

    def test_sign_detail_normalizes_words(self):
        with patch.object(
            app_module,
            "load_word_map",
            return_value={"credit card": "https://example.test/credit-card.mp4"},
        ):
            response = self.client.get("/api/signs/CREDIT-CARD")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["word"], "CREDIT CARD")

    def test_sessions_returns_pipeline_history(self):
        rows = [{"video_id": "abc123", "status": "ready", "chunk_count": 4}]
        with patch.object(app_module.pipeline, "list_prepared", return_value=rows) as list_prepared:
            response = self.client.get("/api/sessions?limit=12")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"items": rows, "count": 1})
        list_prepared.assert_called_once_with(limit=12)

    def test_feedback_is_validated_and_saved(self):
        with patch.object(app_module.pipeline, "save_feedback", return_value=7) as save_feedback:
            response = self.client.post(
                "/api/feedback",
                json={"message": "Please make the focus indicator more visible."},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json(), {"ok": True, "id": 7})
        save_feedback.assert_called_once()

        invalid = self.client.post("/api/feedback", json={"message": "  "})
        self.assertEqual(invalid.status_code, 400)

    def test_prepare_api_alias_uses_existing_prepare_flow(self):
        with (
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(
                app_module.pipeline,
                "get_prepared",
                return_value={"status": "ready", "error": None},
            ),
        ):
            response = self.client.post("/api/prepare", json={"video_id": "abc123"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ready", "cached": True})


if __name__ == "__main__":
    unittest.main()
