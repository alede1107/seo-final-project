import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch

from backend import app as app_module
from backend import pipeline
from services.chunk_processor import match_gloss


def _signed(key):
    return f"signed://{key}"


class MatchGlossOverrideTests(unittest.TestCase):
    def test_override_wins_over_default_and_preserves_order_and_duration(self):
        base = match_gloss(["BOOK", "COMPUTER"], chunk_duration=10.0)
        self.assertEqual([c["token"] for c in base], ["BOOK", "COMPUTER"])
        default_book_url = base[0]["url"]

        overridden = match_gloss(
            ["BOOK", "COMPUTER"],
            chunk_duration=10.0,
            overrides={"book": "signed://mine"},
        )
        # Same order + duration split; only BOOK's URL changed.
        self.assertEqual([c["token"] for c in overridden], ["BOOK", "COMPUTER"])
        self.assertEqual(overridden[0]["url"], "signed://mine")
        self.assertNotEqual(default_book_url, "signed://mine")
        self.assertEqual(
            [c["target_duration"] for c in overridden],
            [c["target_duration"] for c in base],
        )

    def test_override_fills_a_token_that_has_no_default_clip(self):
        token = "ZZUNKNOWNGLOSS"
        self.assertEqual(match_gloss([token]), [])  # no default -> dropped
        filled = match_gloss([token], overrides={"zzunknowngloss": "signed://x"})
        self.assertEqual(len(filled), 1)
        self.assertEqual(filled[0]["url"], "signed://x")


class PersonalizeChunksTests(unittest.TestCase):
    def _clip(self, word, *, preferred=False, clip_id="c1"):
        return {
            "clip_id": clip_id,
            "user_id": "u1",
            "word": word,
            "s3_key": f"personal/u1/{clip_id}.webm",
            "mime": "video/webm",
            "preferred": preferred,
            "created_at": 1.0,
        }

    def test_guest_and_empty_clips_are_unchanged(self):
        chunks = [{"gloss": ["BOOK"], "clips": [{"token": "BOOK", "url": "d"}]}]
        self.assertIs(pipeline.personalize_chunks(chunks, [], _signed), chunks)

    def test_fills_a_missing_token(self):
        chunks = [
            {
                "gloss": ["ZZUNKNOWNGLOSS"],
                "words": [],
                "video_time_offset": 0.0,
                "video_time_end": 10.0,
                "clips": [],  # missing: no default clip
            }
        ]
        out = pipeline.personalize_chunks(
            chunks,
            [self._clip("zzunknowngloss")],
            _signed,
            default_map={},
        )
        self.assertEqual(len(out[0]["clips"]), 1)
        self.assertEqual(out[0]["clips"][0]["url"], _signed("personal/u1/c1.webm"))

    def test_default_is_overridden_only_when_preferred(self):
        chunk = {
            "gloss": ["BOOK"],
            "words": [],
            "video_time_offset": 0.0,
            "video_time_end": 10.0,
            "clips": [{"token": "BOOK", "url": "default://book"}],
        }
        default_map = {"book": "default://book"}

        # Not preferred -> keep default (chunk returned untouched).
        kept = pipeline.personalize_chunks(
            [dict(chunk)], [self._clip("book", preferred=False)], _signed, default_map
        )
        self.assertEqual(kept[0]["clips"][0]["url"], "default://book")

        # Preferred -> personal URL replaces the default.
        replaced = pipeline.personalize_chunks(
            [dict(chunk)], [self._clip("book", preferred=True)], _signed, default_map
        )
        self.assertEqual(replaced[0]["clips"][0]["url"], _signed("personal/u1/c1.webm"))

    def test_preferred_wins_over_newer_unpreferred_for_same_word(self):
        older_preferred = self._clip("book", preferred=True, clip_id="old")
        older_preferred["created_at"] = 1.0
        newer_plain = self._clip("book", preferred=False, clip_id="new")
        newer_plain["created_at"] = 2.0
        override = pipeline.build_override_map(
            [newer_plain, older_preferred], {"book": "default://book"}, _signed
        )
        self.assertEqual(override, {"book": _signed("personal/u1/old.webm")})


class PersonalClipRouteTests(unittest.TestCase):
    UID = "uid-personal-test"

    def setUp(self):
        self.client = app_module.app.test_client()
        self.fake_s3 = MagicMock()
        self.fake_s3.generate_presigned_url.side_effect = lambda *a, **k: (
            "https://signed/" + k["Params"]["Key"]
        )
        self._patchers = [
            patch.object(app_module, "s3", self.fake_s3),
            patch.object(app_module, "S3_BUCKET", "test-bucket"),
            patch.object(app_module, "personal_store", None),  # use local SQLite
            patch.object(app_module, "_current_uid", return_value=self.UID),
        ]
        for p in self._patchers:
            p.start()

    def tearDown(self):
        for p in self._patchers:
            p.stop()
        # Remove rows this test created.
        for clip in pipeline.list_personal_clips(self.UID):
            pipeline.delete_personal_clip(self.UID, clip["clip_id"])

    def _upload(self, word="book", filename="clip.webm", content_type="video/webm", size=1024):
        return self.client.post(
            "/api/personal-clips",
            data={
                "word": word,
                "video": (BytesIO(b"x" * size), filename, content_type),
            },
            content_type="multipart/form-data",
        )

    def test_guest_cannot_use_personal_clip_routes(self):
        with patch.object(app_module, "_current_uid", return_value=None):
            self.assertEqual(self.client.get("/api/personal-clips").status_code, 401)
            self.assertEqual(self._upload().status_code, 401)

    def test_upload_list_prefer_delete_round_trip(self):
        created = self._upload(word="Book")
        self.assertEqual(created.status_code, 201)
        body = created.get_json()
        self.assertEqual(body["word"], "book")  # normalized
        self.assertFalse(body["preferred"])
        self.assertTrue(body["url"].startswith("https://signed/"))
        clip_id = body["clip_id"]
        self.fake_s3.put_object.assert_called_once()

        listed = self.client.get("/api/personal-clips").get_json()["clips"]
        self.assertEqual([c["clip_id"] for c in listed], [clip_id])

        prefer = self.client.patch(
            f"/api/personal-clips/{clip_id}", json={"preferred": True}
        )
        self.assertEqual(prefer.status_code, 200)
        self.assertTrue(prefer.get_json()["preferred"])

        deleted = self.client.delete(f"/api/personal-clips/{clip_id}")
        self.assertEqual(deleted.status_code, 200)
        self.fake_s3.delete_object.assert_called_once()
        self.assertEqual(self.client.get("/api/personal-clips").get_json()["clips"], [])

    def test_upload_rejects_bad_word_missing_file_type_and_size(self):
        self.assertEqual(self._upload(word="   ").status_code, 400)

        no_file = self.client.post(
            "/api/personal-clips",
            data={"word": "book"},
            content_type="multipart/form-data",
        )
        self.assertEqual(no_file.status_code, 400)

        self.assertEqual(
            self._upload(filename="clip.gif", content_type="image/gif").status_code, 415
        )
        self.assertEqual(
            self._upload(size=16 * 1024 * 1024).status_code, 413
        )

    def test_prefer_and_delete_unknown_clip_return_404(self):
        self.assertEqual(
            self.client.patch(
                "/api/personal-clips/nope", json={"preferred": True}
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete("/api/personal-clips/nope").status_code, 404
        )

    def test_validation_runs_without_s3_but_storage_needs_it(self):
        # A misconfigured server (no S3_BUCKET) must still return client errors
        # for bad input — a malformed request should never masquerade as a 500.
        with patch.object(app_module, "S3_BUCKET", ""):
            self.assertEqual(
                self._upload(filename="clip.gif", content_type="image/gif").status_code,
                415,
            )
            self.assertEqual(self._upload(size=16 * 1024 * 1024).status_code, 413)
            # A *valid* request can't be stored without S3 -> 500 only here.
            valid = self._upload()
            self.assertEqual(valid.status_code, 500)
            self.assertIn("S3_BUCKET", valid.get_json()["error"])
        self.fake_s3.put_object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
