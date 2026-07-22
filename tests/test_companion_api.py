import io
import sqlite3
import unittest
from unittest.mock import MagicMock, patch

from backend import app as app_module


class CompanionApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_api_health_alias(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True})
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    def test_cloud_health_accepts_caption_aws_aliases(self):
        fake_s3 = MagicMock()
        with (
            patch.object(app_module, "CLOUD_STORE_ENABLED", True),
            patch.object(app_module, "AWS_ACCESS_KEY", "access-key"),
            patch.object(app_module, "AWS_SECRET_KEY", "secret-key"),
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module, "s3", fake_s3),
            patch.dict(
                app_module.os.environ,
                {"S3_BUCKET": "test-bucket", "ASSEMBLYAI_API_KEY": "test-key"},
            ),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True})
        fake_s3.head_bucket.assert_called_once_with(Bucket="test-bucket")

    def test_cloud_health_reports_invalid_s3_access(self):
        fake_s3 = MagicMock()
        fake_s3.head_bucket.side_effect = app_module.ClientError(
            {"Error": {"Code": "InvalidAccessKeyId", "Message": "invalid"}},
            "HeadBucket",
        )
        with (
            patch.object(app_module, "CLOUD_STORE_ENABLED", True),
            patch.object(app_module, "AWS_ACCESS_KEY", "access-key"),
            patch.object(app_module, "AWS_SECRET_KEY", "secret-key"),
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module, "s3", fake_s3),
            patch.dict(
                app_module.os.environ,
                {"S3_BUCKET": "test-bucket", "ASSEMBLYAI_API_KEY": "test-key"},
            ),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.get_json(),
            {
                "ok": False,
                "error": "S3 credentials or bucket access are invalid",
            },
        )

    def test_caption_aws_alias_takes_priority_over_standard_name(self):
        with patch.dict(
            app_module.os.environ,
            {
                "CAPTION_AWS_ACCESS_KEY_ID": "caption-access",
                "AWS_ACCESS_KEY_ID": "standard-access",
            },
        ):
            value = app_module._first_env(
                "CAPTION_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"
            )

        self.assertEqual(value, "caption-access")

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

    def test_delete_session_removes_prepared_captions(self):
        result = {"deleted": True, "captions_deleted": 4}
        with patch.object(
            app_module.pipeline, "delete_prepared", return_value=result
        ) as delete_prepared:
            response = self.client.delete("/api/sessions/abc123")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {"ok": True, "video_id": "abc123", "captions_deleted": 4},
        )
        delete_prepared.assert_called_once_with("abc123")

    def test_delete_session_rejects_active_or_missing_jobs(self):
        with patch.object(
            app_module.pipeline,
            "delete_prepared",
            return_value={"deleted": False, "reason": "preparing"},
        ):
            preparing = self.client.delete("/api/sessions/abc123")
        self.assertEqual(preparing.status_code, 409)

        with patch.object(
            app_module.pipeline,
            "delete_prepared",
            return_value={"deleted": False, "reason": "not_found"},
        ):
            missing = self.client.delete("/api/sessions/abc123")
        self.assertEqual(missing.status_code, 404)

    def test_delete_prepared_preserves_live_captions(self):
        connection = sqlite3.connect(":memory:")
        try:
            connection.row_factory = sqlite3.Row
            with patch.object(app_module.pipeline, "_conn", connection):
                app_module.pipeline.init_db()
                app_module.pipeline.mark_prepare_error("abc123", "failed")
                app_module.pipeline.insert_ready(
                    "abc123", "pre-abc123", 0, 0, 5, "prepared", [], [], []
                )
                app_module.pipeline.insert_ready(
                    "abc123", "live-session", 0, 0, 5, "live", [], [], []
                )

                result = app_module.pipeline.delete_prepared("abc123")

                self.assertTrue(result["deleted"])
                self.assertEqual(result["captions_deleted"], 1)
                self.assertEqual(app_module.pipeline.get_session("pre-abc123"), [])
                self.assertEqual(len(app_module.pipeline.get_session("live-session")), 1)
                self.assertEqual(
                    app_module.pipeline.get_prepared("abc123")["status"], "none"
                )

                app_module.pipeline.mark_prepare_started("active123")
                active = app_module.pipeline.delete_prepared("active123")
                self.assertEqual(active, {"deleted": False, "reason": "preparing"})
                self.assertEqual(
                    app_module.pipeline.get_prepared("active123")["status"],
                    "preparing",
                )
        finally:
            connection.close()

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

    def test_cloud_upload_submits_durable_extension_chunk(self):
        cloud = MagicMock()
        cloud.get_live_chunk.return_value = None
        cloud.find_covering.return_value = None
        fake_s3 = MagicMock()
        fake_s3.generate_presigned_url.return_value = "https://audio.test/chunk.webm"

        with (
            patch.object(app_module, "CLOUD_STORE_ENABLED", True),
            patch.object(app_module, "cloud_store", cloud),
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module, "s3", fake_s3),
            patch.object(app_module.pipeline, "insert_pending") as insert_pending,
            patch.object(app_module.pipeline, "transcribe_async") as transcribe_async,
        ):
            response = self.client.post(
                "/upload",
                data={
                    "audio": (io.BytesIO(b"webm-audio"), "chunk.webm"),
                    "video_id": "abc123",
                    "session_id": "abc123-session",
                    "chunk_index": "0",
                    "video_time_offset": "2.5",
                    "video_time_end": "12.5",
                    "video_title": "Test video",
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["status"], "pending")
        cloud.submit_live_chunk.assert_called_once_with(
            "abc123",
            "abc123-session",
            0,
            "https://audio.test/chunk.webm",
            video_time_offset=2.5,
            video_time_end=12.5,
            source_key="abc123/abc123-session/chunk-00000.webm",
            title="Test video",
        )
        insert_pending.assert_not_called()
        transcribe_async.assert_not_called()

    def test_cloud_caption_poll_advances_durable_session(self):
        chunks = [{"chunk_index": 0, "status": "ready", "text": "hello"}]
        cloud = MagicMock()
        cloud.get_live_session.return_value = chunks

        with patch.object(app_module, "cloud_store", cloud):
            response = self.client.get("/captions/abc123-session")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["chunks"], chunks)
        cloud.get_live_session.assert_called_once_with(
            "abc123-session",
            advance=True,
        )


if __name__ == "__main__":
    unittest.main()
