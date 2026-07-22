import io
import json
import unittest

from botocore.exceptions import ClientError

from backend.cloud_prepared import S3PreparedStore


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeHttp:
    def post(self, *_args, **_kwargs):
        return FakeResponse({"id": "transcript-1"})

    def get(self, *_args, **_kwargs):
        return FakeResponse(
            {
                "status": "completed",
                "text": "hello book",
                "words": [
                    {"text": "hello", "start": 0, "end": 400, "speaker": "A"},
                    {"text": "book", "start": 11000, "end": 11600, "speaker": "A"},
                ],
                "utterances": [{"speaker": "A", "text": "hello book"}],
            }
        )


class FakeS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, **_kwargs):
        self.objects[(Bucket, Key)] = bytes(Body)

    def get_object(self, Bucket, Key):
        try:
            body = self.objects[(Bucket, Key)]
        except KeyError as exc:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "missing"}},
                "GetObject",
            ) from exc
        return {"Body": io.BytesIO(body)}

    def list_objects_v2(self, Bucket, Prefix, **_kwargs):
        contents = [
            {"Key": key}
            for stored_bucket, key in self.objects
            if stored_bucket == Bucket and key.startswith(Prefix)
        ]
        return {"Contents": contents, "IsTruncated": False}

    def delete_objects(self, Bucket, Delete):
        for item in Delete["Objects"]:
            self.objects.pop((Bucket, item["Key"]), None)
        return {"Deleted": Delete["Objects"]}


def segment_words(words):
    return [
        (0.0, 0.4, "hello", [words[0]]),
        (11.0, 11.6, "book", [words[1]]),
    ]


def build_caption(text, _words, duration):
    token = text.upper()
    return [token], [
        {
            "token": token,
            "url": f"https://clips.test/{text}.mp4",
            "target_duration": duration,
        }
    ]


class CloudPreparedStoreTests(unittest.TestCase):
    def setUp(self):
        self.s3 = FakeS3()
        self.store = S3PreparedStore(
            self.s3,
            "test-bucket",
            "assembly-key",
            segment_words,
            build_caption,
            batch_size=1,
            http=FakeHttp(),
        )

    def test_job_resumes_across_polls_and_persists_ready_captions(self):
        self.store.start("abc123")
        self.store.submit(
            "abc123",
            "https://audio.test/source.m4a",
            title="Test video",
            duration=12,
            source_key="abc123/source-audio.m4a",
        )

        first_poll = self.store.get_prepared("abc123", advance=True)
        self.assertEqual(first_poll["status"], "preparing")
        self.assertEqual(first_poll["stage"], "matching_signs")

        second_poll = self.store.get_prepared("abc123", advance=True)
        self.assertEqual(second_poll["status"], "ready")
        self.assertEqual(second_poll["chunk_count"], 2)
        self.assertEqual(second_poll["sign_count"], 2)

        captions = self.store.get_video("abc123")
        self.assertEqual([item["text"] for item in captions], ["hello", "book"])
        self.assertEqual(captions[1]["clips"][0]["token"], "BOOK")

        history = self.store.list_prepared()
        self.assertEqual(history[0]["title"], "Test video")
        self.assertEqual(history[0]["chunk_count"], 2)

    def test_delete_removes_cloud_job_and_captions(self):
        self.store.start("abc123")
        self.store.mark_error("abc123", "failed")
        self.s3.put_object(
            Bucket="test-bucket",
            Key="captionaid/v2/captions/abc123.json",
            Body=json.dumps([{"chunk_index": 0}]).encode(),
        )

        result = self.store.delete_prepared("abc123")

        self.assertEqual(result, {"deleted": True, "captions_deleted": 1})
        self.assertEqual(self.store.get_prepared("abc123")["status"], "none")

    def test_live_extension_chunk_persists_and_populates_shared_history(self):
        pending = self.store.submit_live_chunk(
            "abc123",
            "abc123-session",
            0,
            "https://audio.test/chunk.webm",
            video_time_offset=5,
            video_time_end=17,
            source_key="abc123/abc123-session/chunk-00000.webm",
            title="Test video - YouTube",
        )

        self.assertEqual(pending["status"], "pending")
        self.assertEqual(
            self.store.get_prepared("abc123")["status"],
            "preparing",
        )

        chunks = self.store.get_live_session("abc123-session", advance=True)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["status"], "ready")
        self.assertEqual(chunks[0]["text"], "hello book")
        self.assertEqual(chunks[0]["speaker_label"], "A")
        self.assertEqual(chunks[0]["clips"][0]["target_duration"], 12)

        cached = self.store.get_video("abc123")
        self.assertEqual(cached[0]["session_id"], "abc123-session")
        self.assertEqual(cached[0]["gloss"], ["HELLO BOOK"])

        history = self.store.list_prepared()
        self.assertEqual(history[0]["status"], "ready")
        self.assertEqual(history[0]["title"], "Test video - YouTube")
        self.assertEqual(history[0]["chunk_count"], 1)

    def test_live_extension_chunk_is_reused_for_the_same_video_time(self):
        self.store.submit_live_chunk(
            "abc123",
            "first-session",
            0,
            "https://audio.test/chunk.webm",
            video_time_offset=0,
            video_time_end=10,
            source_key="abc123/first-session/chunk-00000.webm",
        )
        self.store.get_live_session("first-session", advance=True)

        covered = self.store.find_covering(
            "abc123",
            "second-session",
            0.5,
            9.5,
        )

        self.assertIsNotNone(covered)
        self.assertEqual(covered["session_id"], "first-session")


if __name__ == "__main__":
    unittest.main()
