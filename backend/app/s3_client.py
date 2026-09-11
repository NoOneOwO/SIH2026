"""
DamSafe Twin — S3 / MinIO Client

Provides a singleton boto3 client and helper functions for object storage operations.
"""

import io
from typing import Optional

import boto3
from botocore.config import Config

from app.config import get_settings

settings = get_settings()


def get_s3_client():
    """Create a boto3 S3 client configured for MinIO."""
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        region_name=settings.S3_REGION,
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket(client=None):
    """Create the default bucket if it doesn't exist."""
    client = client or get_s3_client()
    try:
        client.head_bucket(Bucket=settings.S3_BUCKET)
    except client.exceptions.ClientError:
        client.create_bucket(Bucket=settings.S3_BUCKET)


def upload_bytes(data: bytes, key: str, content_type: str = "application/octet-stream") -> str:
    """Upload raw bytes to S3, return the object key."""
    client = get_s3_client()
    client.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    return key


def upload_fileobj(fileobj, key: str, content_type: str = "application/octet-stream") -> str:
    """Upload a file-like object to S3, return the object key."""
    client = get_s3_client()
    client.upload_fileobj(fileobj, settings.S3_BUCKET, key, ExtraArgs={"ContentType": content_type})
    return key


def download_bytes(key: str) -> bytes:
    """Download an object from S3 as bytes."""
    client = get_s3_client()
    response = client.get_object(Bucket=settings.S3_BUCKET, Key=key)
    return response["Body"].read()


def get_presigned_url(key: str, expires_in: int = 3600) -> str:
    """Generate a presigned URL for an S3 object."""
    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires_in,
    )


def delete_object(key: str) -> None:
    """Delete an object from S3."""
    client = get_s3_client()
    client.delete_object(Bucket=settings.S3_BUCKET, Key=key)
