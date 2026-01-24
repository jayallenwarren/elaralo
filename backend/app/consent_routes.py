from fastapi import APIRouter, Header, HTTPException
from datetime import datetime
from .models import ExplicitConsentRequest, ExplicitConsentStatus
from .consent_store import consent_store
from .settings import settings

router = APIRouter(prefix="/consent", tags=["consent"])

def _check_admin(token: str | None):
    if settings.CONSENT_ADMIN_TOKEN:
        if not token or token != settings.CONSENT_ADMIN_TOKEN:
            raise HTTPException(status_code=401, detail="Missing/invalid CONSENT_ADMIN_TOKEN")

@router.post("/explicit", response_model=ExplicitConsentStatus)
def set_explicit_consent(payload: ExplicitConsentRequest, x_admin_token: str | None = Header(default=None)):
    """
    Double-confirm 18+ + explicit intent *right now*.
    """
    _check_admin(x_admin_token)

    if not (payload.age_confirmed_18_plus and payload.age_confirmed_18_plus_again):
        rec = consent_store.set(payload.session_id, explicit_allowed=False, reason="age_not_double_confirmed")
        return ExplicitConsentStatus(
            session_id=payload.session_id,
            explicit_allowed=rec.explicit_allowed,
            updated_at=rec.updated_at,
            reason=rec.reason,
        )

    if not payload.wants_explicit_now:
        rec = consent_store.set(payload.session_id, explicit_allowed=False, reason="user_not_requesting_explicit_now")
        return ExplicitConsentStatus(
            session_id=payload.session_id,
            explicit_allowed=rec.explicit_allowed,
            updated_at=rec.updated_at,
            reason=rec.reason,
        )

    rec = consent_store.set(payload.session_id, explicit_allowed=True, reason="explicit_consent_granted")
    return ExplicitConsentStatus(
        session_id=payload.session_id,
        explicit_allowed=rec.explicit_allowed,
        updated_at=rec.updated_at,
        reason=rec.reason,
    )

@router.get("/status/{session_id}", response_model=ExplicitConsentStatus)
def get_status(session_id: str):
    rec = consent_store.get(session_id)
    if not rec:
        return ExplicitConsentStatus(
            session_id=session_id,
            explicit_allowed=False,
            updated_at=datetime.utcnow(),
            reason="no_record",
        )
    return ExplicitConsentStatus(
        session_id=session_id,
        explicit_allowed=rec.explicit_allowed,
        updated_at=rec.updated_at,
        reason=rec.reason,
    )

@router.post("/revoke/{session_id}", response_model=ExplicitConsentStatus)
def revoke(session_id: str, x_admin_token: str | None = Header(default=None)):
    _check_admin(x_admin_token)
    rec = consent_store.revoke(session_id, reason="revoked_by_user_or_admin")
    if not rec:
        return ExplicitConsentStatus(
            session_id=session_id,
            explicit_allowed=False,
            updated_at=datetime.utcnow(),
            reason="no_record_to_revoke",
        )
    return ExplicitConsentStatus(
        session_id=session_id,
        explicit_allowed=rec.explicit_allowed,
        updated_at=rec.updated_at,
        reason=rec.reason,
    )
