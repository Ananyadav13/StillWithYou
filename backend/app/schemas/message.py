from pydantic import BaseModel


class PingRequest(BaseModel):
    text: str


class PingResponse(BaseModel):
    echo: str
    received_at: str
