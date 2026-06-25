from fastapi import APIRouter, UploadFile, File, Depends
from ....core.dependencies import get_current_user
from ....services.cloudinary_client import upload_file
import tempfile, os

router = APIRouter()

@router.post("/")
async def upload_image(file: UploadFile = File(...), _=Depends(get_current_user)):
    suffix = os.path.splitext(file.filename)[1]
    print("Trying upload")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        result = upload_file(tmp.name)
    os.unlink(tmp.name)
    return {"url": result["secure_url"]}