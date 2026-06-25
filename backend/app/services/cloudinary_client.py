import cloudinary.uploader
from cloudinary import config as cloudinary_config
from ..core.config import settings

cloudinary_config(
    cloud_name=settings.CLOUDINARY_CLOUD_NAME,
    api_key=settings.CLOUDINARY_API_KEY,
    api_secret=settings.CLOUDINARY_API_SECRET,
    secure=True,
)


async def upload_file(file_path: str, public_id: str | None = None) -> dict:
    """
    Uploads a file to Cloudinary. Returns the API response.
    Use this for profile pictures, chat media, etc.
    """
    print("Trying upload cl")
    upload_options = {}
    if public_id:
        upload_options["public_id"] = public_id
    result = cloudinary.uploader.upload(file_path, **upload_options)
    return result


async def delete_file(public_id: str) -> dict:
    """
    Deletes a file from Cloudinary by its public_id.
    """
    result = cloudinary.uploader.destroy(public_id)
    return result