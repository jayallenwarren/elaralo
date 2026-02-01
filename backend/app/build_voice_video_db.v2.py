#!/usr/bin/env python3
"""build_voice_video_db.py

Creates/updates voice_video_mappings.sqlite3 from the Excel file:
  'Voice and Video Mappings - Elaralo.xlsx'

This DB is consumed by backend/app/main.py at runtime. main.py expects the legacy
column names (brand, avatar, communication, eleven_voice_id, did_*), so this script:
  - Loads the newer Excel schema (Brand_ID, Companion_ID, Companion_Type, Channel_Cap, Eleven_Labs_Voice_ID, ...)
  - Writes both the new columns AND the legacy columns for backward compatibility.

Usage:
  python build_voice_video_db.py --excel "Video and Voice Mappings - Elaralo.xlsx" --out voice_video_mappings.sqlite3

Notes:
  - 'avatar' is populated from Excel column 'Companion'
  - 'communication' is populated from Excel column 'Channel_Cap' (legacy alias)
  - The (brand, avatar) pair is treated as the unique key.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd


SCHEMA_SQL = """PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companion_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Newer identifiers (from the Excel)
  brand_id INTEGER,
  companion_id INTEGER,
  companion_type TEXT,        -- "AI" | "Human"

  -- Lookup keys (used by backend)
  brand TEXT NOT NULL,
  avatar TEXT NOT NULL,       -- Companion display name (legacy field name used by backend)

  -- Voice mapping
  eleven_voice_name TEXT,     -- optional / human-friendly
  eleven_voice_id TEXT,       -- ElevenLabs voice_id (legacy field name used by backend)

  -- Capability flags
  channel_cap TEXT,           -- "Video" | "Audio" (new column name)
  communication TEXT,         -- legacy alias of channel_cap used by backend

  live TEXT,                  -- "D-ID" | "Stream" | NULL

  -- D‑ID fields (only used when live == "D-ID")
  did_embed_code TEXT,
  did_agent_link TEXT,
  did_agent_id TEXT,
  did_client_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_mappings_brand_avatar
  ON companion_mappings (LOWER(brand), LOWER(avatar));
"""


def _none_if_blank(v: Any) -> Optional[Any]:
    if v is None:
        return None
    if isinstance(v, float) and np.isnan(v):
        return None
    if isinstance(v, str):
        s = v.strip()
        if not s or s.lower() == "nan":
            return None
        return s
    return v


def build_db(excel_path: Path, out_path: Path, sheet: str = "Sheet1") -> None:
    df = pd.read_excel(excel_path, sheet_name=sheet, engine="openpyxl")

    # Expected columns (new schema)
    required = {"Brand", "Companion", "Channel_Cap", "Eleven_Labs_Voice_ID"}
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise SystemExit(f"Excel is missing required columns: {missing}. Found: {list(df.columns)}")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(out_path))
    try:
        cur = conn.cursor()
        cur.executescript(SCHEMA_SQL)

        rows = []
        for _, r in df.iterrows():
            brand_id = _none_if_blank(r.get("Brand_ID"))
            brand = _none_if_blank(r.get("Brand")) or ""
            companion_id = _none_if_blank(r.get("Companion_ID"))
            avatar = _none_if_blank(r.get("Companion")) or ""

            companion_type = _none_if_blank(r.get("Companion_Type"))
            voice_name = _none_if_blank(r.get("ElevenLabs Voice"))
            channel_cap = _none_if_blank(r.get("Channel_Cap"))
            communication = channel_cap  # legacy alias
            voice_id = _none_if_blank(r.get("Eleven_Labs_Voice_ID"))

            live = _none_if_blank(r.get("Live"))

            did_embed_code = _none_if_blank(r.get("D-ID_Embed_Code"))
            did_agent_link = _none_if_blank(r.get("D-ID_Agent_Link"))
            did_agent_id = _none_if_blank(r.get("D-ID_Agent_ID"))
            did_client_key = _none_if_blank(r.get("D-ID_Client_Key"))

            if not brand.strip() or not avatar.strip():
                continue

            rows.append(
                (
                    brand_id,
                    companion_id,
                    companion_type,
                    brand.strip(),
                    avatar.strip(),
                    voice_name,
                    voice_id,
                    channel_cap,
                    communication,
                    live,
                    did_embed_code,
                    did_agent_link,
                    did_agent_id,
                    did_client_key,
                )
            )

        cur.executemany(
            """
            INSERT INTO companion_mappings(
              brand_id, companion_id, companion_type,
              brand, avatar,
              eleven_voice_name, eleven_voice_id,
              channel_cap, communication,
              live,
              did_embed_code, did_agent_link, did_agent_id, did_client_key
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(LOWER(brand), LOWER(avatar)) DO UPDATE SET
              brand_id=excluded.brand_id,
              companion_id=excluded.companion_id,
              companion_type=excluded.companion_type,
              eleven_voice_name=excluded.eleven_voice_name,
              eleven_voice_id=excluded.eleven_voice_id,
              channel_cap=excluded.channel_cap,
              communication=excluded.communication,
              live=excluded.live,
              did_embed_code=excluded.did_embed_code,
              did_agent_link=excluded.did_agent_link,
              did_agent_id=excluded.did_agent_id,
              did_client_key=excluded.did_client_key
            ;
            """,
            rows,
        )
        conn.commit()

        count = cur.execute("SELECT COUNT(*) FROM companion_mappings").fetchone()[0]
        print(f"OK: wrote {count} rows to {out_path}")
    finally:
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--excel", required=True, type=Path, help="Path to the Excel file")
    ap.add_argument("--out", required=True, type=Path, help="Path to output sqlite3 db")
    ap.add_argument("--sheet", default="Sheet1", help="Sheet name (default: Sheet1)")
    args = ap.parse_args()
    build_db(args.excel, args.out, sheet=args.sheet)


if __name__ == "__main__":
    main()
