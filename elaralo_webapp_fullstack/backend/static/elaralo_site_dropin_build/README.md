# Elaralo — Drop‑In Website Build

This bundle is a static site that matches the PRD and the requested plan table format. Deploy to GoDaddy (or any static host) by uploading the contents of this folder to `public_html/`.

## Pages
- `/` — Home
- `/pricing.html` — Plan table (two-row screenshot style) + Add Minutes + plan cards
- `/companions.html` — Companion gallery (video-flag example)
- `/faq.html` — FAQ
- `/terms.html` — Terms
- `/privacy.html` — Privacy
- `/no-refund.html` — No Refund Policy
- `/subscriptions.html` — Subscription explainer
- `/contact.html` — Contact (Formspree placeholder)
- `/signup.html` — Member signup with DOB calendar and 18+ check
- `/member/` — Member area (Account, Wallet, Subscriptions, Addresses)

## Configure
1. **Stripe links**: edit `assets/config.json` and paste your Payment Link URLs under:
   - `stripe.plans.member_friend | member_romantic | member_intimate`
   - `stripe.skus.tts_15m_499 | tts_30m_999 | tts_60m_1499 | text_15m_099 | text_30m_299 | text_60m_599`
2. **Contact form**: replace the placeholder in `/contact.html` (`/f/REPLACE_WITH_FORM_ID`) with your Formspree form ID.

## Notes
- Member area is a **demo** using `localStorage` for profile and minute balances. Production should use your backend and Stripe webhooks.
- Design uses **Fraunces** (display) and **Inter** (UI/body) and the brand palette from the PRD.
- Tables are compact, with numeric columns right-aligned. The plan table uses the exact labels and alignment from your screenshot.
- Fully static; no build step required.
