from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Optional

@dataclass
class ConsentRecord:
    explicit_allowed: bool
    updated_at: datetime
    reason: str = ""

class ConsentStore:
    """
    Simple in-memory store (works on a single instance).
    For scale-out (multiple App Service instances), swap this with Redis/Cosmos.
    """
    def __init__(self, ttl_hours: int = 24):
        self._db: Dict[str, ConsentRecord] = {}
        self._ttl = timedelta(hours=ttl_hours)

    def set(self, session_id: str, explicit_allowed: bool, reason: str = "") -> ConsentRecord:
        rec = ConsentRecord(explicit_allowed=explicit_allowed, updated_at=datetime.utcnow(), reason=reason)
        self._db[session_id] = rec
        return rec

    def get(self, session_id: str) -> Optional[ConsentRecord]:
        rec = self._db.get(session_id)
        if not rec:
            return None
        # TTL cleanup
        if datetime.utcnow() - rec.updated_at > self._ttl:
            self._db.pop(session_id, None)
            return None
        return rec

    def revoke(self, session_id: str, reason: str = "revoked") -> Optional[ConsentRecord]:
        if session_id in self._db:
            return self.set(session_id, explicit_allowed=False, reason=reason)
        return None

consent_store = ConsentStore(ttl_hours=24)
