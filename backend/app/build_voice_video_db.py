#!/usr/bin/env python3
"""
Build / refresh the SQLite companion capability database from the Excel sheet.

Input:
  Voice and Video Mappings - Elaralo.xlsx

Output:
  voice_video_mappings.sqlite3  (table: companion_mappings)

Usage:
  python build_voice_video_db.py \
    --xlsx "Voice and Video Mappings - Elaralo.xlsx" \
    --out  "voice_video_mappings.sqlite3"
"""
from __future__ import annotations

import argparse
import os
import sqlite3

import pandas as pd


def _clean(v):
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    s = str(v) if v is not None else ""
    s = s.strip()
    return s or None


def build_db(xlsx_path: str, out_path: str) -> None:
    df = pd.read_excel(xlsx_path)

    # Expected columns (kept tolerant so the sheet can evolve):
    # Brand, Avatar, ElevenLabs Voice, Communication, Eleven Labs Voice ID, Live,
    # D-ID Embed Code, D-ID Agent Link, D-ID Agent ID, D-ID Client Key
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    if os.path.exists(out_path):
        os.remove(out_path)

    conn = sqlite3.connect(out_path)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS companion_mappings (
                brand TEXT NOT NULL,
                avatar TEXT NOT NULL,
                eleven_voice_name TEXT,
                communication TEXT NOT NULL,
                eleven_voice_id TEXT,
                live TEXT,
                did_embed_code TEXT,
                did_agent_link TEXT,
                did_agent_id TEXT,
                did_client_key TEXT,
                PRIMARY KEY (brand, avatar)
            );
            """
        )

        records = []
        for _, row in df.iterrows():
            records.append(
                (
                    _clean(row.get("Brand")),
                    _clean(row.get("Avatar")),
                    _clean(row.get("ElevenLabs Voice")),
                    _clean(row.get("Communication")) or "Audio",
                    _clean(row.get("Eleven Labs Voice ID")),
                    _clean(row.get("Live")),
                    _clean(row.get("D-ID Embed Code")),
                    _clean(row.get("D-ID Agent Link")),
                    _clean(row.get("D-ID Agent ID")),
                    _clean(row.get("D-ID Client Key")),
                )
            )

        cur.executemany(
            """
            INSERT OR REPLACE INTO companion_mappings
            (brand, avatar, eleven_voice_name, communication, eleven_voice_id, live,
             did_embed_code, did_agent_link, did_agent_id, did_client_key)
            VALUES (?,?,?,?,?,?,?,?,?,?);
            """,
            records,
        )

        conn.commit()

        cur.execute("SELECT COUNT(*) FROM companion_mappings;")
        n = int(cur.fetchone()[0])
        print(f"OK: wrote {n} rows → {out_path}")
    finally:
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True, help="Path to the Excel mapping sheet")
    ap.add_argument("--out", required=True, help="Output SQLite path")
    args = ap.parse_args()

    build_db(args.xlsx, args.out)


if __name__ == "__main__":
    main()
