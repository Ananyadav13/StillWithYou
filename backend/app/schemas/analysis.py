"""The shape every analyzer must return, whichever engine produced it.

Gemini and any future fallback engine both return an AnalysisResult, so callers
never branch on provenance except to read `source`.
"""

from typing import Literal

from pydantic import BaseModel, Field

AnalysisSource = Literal["gemini", "local_fallback"]


class AnalysisResult(BaseModel):
    mood: str = Field(description="One-word emotional label, e.g. calm, hurt, angry, warm.")
    toxicity_score: float = Field(ge=0.0, le=1.0, description="0 = kind, 1 = abusive.")
    heat_score: float = Field(ge=0.0, le=1.0, description="0 = cool, 1 = escalated conflict.")
    rewrite_suggestion: str | None = Field(
        default=None, description="A softer phrasing, or null when the message needs no repair."
    )
    source: AnalysisSource = "gemini"
