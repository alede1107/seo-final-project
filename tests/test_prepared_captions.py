import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend import app as app_module
from services.chunk_processor import match_gloss


class FakeYoutubeDL:
    last_options = None

    def __init__(self, options):
        self.options = options
        type(self).last_options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _url, download):
        if not download:
            raise AssertionError("prepared captions must download the selected audio")
        path = self.options["outtmpl"].replace("%(id)s", "testvideo").replace("%(ext)s", "m4a")
        Path(path).write_bytes(b"test audio")
        return {
            "id": "testvideo",
            "ext": "m4a",
            "requested_downloads": [{"filepath": path}],
        }

    def prepare_filename(self, _info):
        raise AssertionError("requested_downloads filepath should be preferred")


class PreparedCaptionTests(unittest.TestCase):
    def test_downloader_enables_node_and_skips_ffmpeg_conversion(self):
        def find_runtime(executable):
            return "/test/node" if executable == "node" else None

        with (
            patch.object(app_module.shutil, "which", side_effect=find_runtime),
            patch.object(app_module.yt_dlp, "YoutubeDL", FakeYoutubeDL),
        ):
            path, ext, temp_dir = app_module._download_audio("testvideo")

        try:
            self.assertTrue(os.path.isfile(path))
            self.assertEqual(ext, "m4a")
            options = FakeYoutubeDL.last_options
            self.assertEqual(options["js_runtimes"], {"node": {"path": "/test/node"}})
            self.assertEqual(options["check_formats"], "selected")
            self.assertNotIn("postprocessors", options)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_downloader_reports_missing_javascript_runtime_and_cleans_temp_dir(self):
        parent = tempfile.mkdtemp(prefix="captionaid-test-")
        download_dir = os.path.join(parent, "download")
        os.mkdir(download_dir)
        try:
            with (
                patch.object(app_module.tempfile, "mkdtemp", return_value=download_dir),
                patch.object(app_module.shutil, "which", return_value=None),
            ):
                with self.assertRaisesRegex(RuntimeError, r"Node.js 22\+ or Deno 2.3\+"):
                    app_module._download_audio("testvideo")
            self.assertFalse(os.path.exists(download_dir))
        finally:
            shutil.rmtree(parent, ignore_errors=True)

    def test_prepare_rejects_an_unsafe_video_id(self):
        response = app_module.app.test_client().post("/prepare", json={"video_id": "../bad"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "invalid video_id"})

    def test_prepare_uploads_downloaded_audio_and_starts_pipeline(self):
        temp_dir = tempfile.mkdtemp(prefix="captionaid-test-")
        audio_path = os.path.join(temp_dir, "testvideo.webm")
        Path(audio_path).write_bytes(b"test audio")
        fake_s3 = MagicMock()
        fake_s3.generate_presigned_url.return_value = "https://example.test/audio"

        with (
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module, "s3", fake_s3),
            patch.object(app_module.pipeline, "ASSEMBLYAI_KEY", "test-key"),
            patch.object(
                app_module.pipeline,
                "get_prepared",
                return_value={"status": "none", "error": None},
            ),
            patch.object(
                app_module,
                "_download_audio",
                return_value=(audio_path, "webm", temp_dir),
            ),
            patch.object(app_module.pipeline, "mark_prepare_started") as mark_started,
            patch.object(app_module.pipeline, "mark_prepare_error"),
            patch.object(app_module.pipeline, "prepare_async") as prepare_async,
        ):
            response = app_module.app.test_client().post(
                "/prepare", json={"video_id": "testvideo"}
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json(), {"status": "preparing"})
        self.assertEqual(fake_s3.put_object.call_args.kwargs["ContentType"], "audio/webm")
        mark_started.assert_called_once_with("testvideo")
        prepare_async.assert_called_once_with("testvideo", "https://example.test/audio")
        self.assertFalse(os.path.exists(temp_dir))

    def test_prepare_returns_actionable_download_error(self):
        with (
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module.pipeline, "ASSEMBLYAI_KEY", "test-key"),
            patch.object(
                app_module.pipeline,
                "get_prepared",
                return_value={"status": "none", "error": None},
            ),
            patch.object(
                app_module,
                "_download_audio",
                side_effect=RuntimeError("No supported JavaScript runtime found"),
            ),
            patch.object(app_module.pipeline, "mark_prepare_started"),
            patch.object(app_module.pipeline, "mark_prepare_error") as mark_error,
        ):
            response = app_module.app.test_client().post(
                "/prepare", json={"video_id": "testvideo"}
            )

        self.assertEqual(response.status_code, 502)
        self.assertIn("No supported JavaScript runtime", response.get_json()["error"])
        mark_error.assert_called_once()

    def test_audio_content_types_match_downloaded_containers(self):
        self.assertEqual(app_module._audio_content_type("m4a"), "audio/mp4")
        self.assertEqual(app_module._audio_content_type("webm"), "audio/webm")
        self.assertEqual(app_module._audio_content_type("unknown"), "application/octet-stream")

    def test_gloss_matcher_returns_urls_in_token_order(self):
        clips = match_gloss(["BOOK", "COMPUTER", "QUESTION-MARK"])
        self.assertEqual([clip["token"] for clip in clips], ["BOOK", "COMPUTER"])
        self.assertTrue(all(clip["url"].startswith("https://") for clip in clips))


if __name__ == "__main__":
    unittest.main()
