from pydantic import BaseModel
import os

class Settings(BaseModel):
    # Wix site origin(s), comma-separated.
    # Example: "https://www.yoursite.com,https://www.yoursite.wixsite.com"
    CORS_ALLOW_ORIGINS: str = os.getenv("CORS_ALLOW_ORIGINS", "*")

    # If you want to require explicit consent even in dev, keep this True.
    REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT: bool = (
        os.getenv("REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", "true").lower() == "true"
    )

    # Optional: simple shared secret for consent endpoints (recommended).
    # If empty, consent endpoints are open (not recommended for production).
    CONSENT_ADMIN_TOKEN: str = os.getenv("CONSENT_ADMIN_TOKEN", "")

settings = Settings()
