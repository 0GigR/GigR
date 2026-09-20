from pydantic import BaseModel
from uuid import UUID
from datetime import datetime
from typing import Optional

class VouchCreate(BaseModel):
    job_id: UUID

class VouchOut(BaseModel):
    id: UUID
    job_id: UUID
    voucher_id: UUID
    vouchee_id: UUID
    cnf_nft_id: str
    transaction_signature: str
    created_at: datetime
    # The title of the job this vouch was earned on, so the vouches list can
    # show what each vouch was actually for (set by the list endpoints).
    job_title: Optional[str] = None

    class Config:
        from_attributes = True