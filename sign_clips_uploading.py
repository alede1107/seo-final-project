import boto3
import os
from dotenv import load_dotenv

load_dotenv()

bucket_name = "seo-final-project-sign-clips"

s3 = boto3.client(
    "s3",
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY"),
    aws_secret_access_key=os.getenv("AWS_SECRET_KEY"),
    region_name="us-east-2"
)

paginator = s3.get_paginator("list_objects_v2")
count = 0

for page in paginator.paginate(Bucket=bucket_name):
    for obj in page.get("Contents", []):
        key = obj["Key"]
        if key.endswith(".mp4"):
            s3.copy_object(
                Bucket=bucket_name,
                Key=key,
                CopySource={"Bucket": bucket_name, "Key": key},
                ContentType="video/mp4",
                MetadataDirective="REPLACE"
            )
            count += 1
            print(f"Fixed content type: {key}")

print(f"Done! Fixed {count} files.")