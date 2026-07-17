import json

with open("/mnt/c/Users/aleja/Downloads/sign_clips/word_to_video.json") as f:
    word_to_video = json.load(f)

bucket_url = "https://seo-final-project-sign-clips.s3.us-east-2.amazonaws.com"
word_to_url = {word: f"{bucket_url}/{video_id}.mp4" for word, video_id in word_to_video.items()}

with open("word_to_url.json", "w") as f:
    json.dump(word_to_url, f, indent=2)