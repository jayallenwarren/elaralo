from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    messages: List[ChatMessage] = Field(..., min_length=1)
    # NOTE: keep flexible because you pass many keys from the frontend
    session_state: Dict[str, Any] = Field(default_factory=dict)
    wants_explicit: bool = False


# IMPORTANT:
# mode is a *status* value, not the conversational mode.
# Conversational mode lives in session_state["mode"] ("friend"|"romantic"|"intimate")
ChatStatus = Literal["safe", "explicit_blocked", "explicit_allowed"]


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    mode: ChatStatus = "safe"
    session_state: Optional[Dict[str, Any]] = None


# If you keep consent_routes.py, it expects these:
class ExplicitConsentRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    explicit_allowed: bool = True
    reason: str = "user consent"


class ExplicitConsentStatus(BaseModel):
    session_id: str
    explicit_allowed: bool
    explicit_granted_at: Optional[int] = None
    reason: Optional[str] = None
