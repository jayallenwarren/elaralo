"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const LS_COMPANION_KEY = "elaralo_companion_key_v1";

const DEFAULT_COMPANION_NAME = "Elara";
const DEFAULT_PLAN_NAME = "Trial";
const DEFAULT_AVATAR_URL = "/elaralo_logo.png";

type CompanionKeyMeta = Record<string, any>;

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function base64UrlToUtf8(b64url: string): string {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeCompanionKey(key: string): CompanionKeyMeta | null {
  const k = (key || "").trim();
  if (!k) return null;

  // If it already looks like JSON
  if (k.startsWith("{") && k.endsWith("}")) return safeJsonParse(k);

  // If it looks like a JWT, decode the payload (2nd segment)
  const parts = k.split(".");
  if (parts.length === 3) {
    const payload = parts[1];
    const jsonStr = base64UrlToUtf8(payload);
    return safeJsonParse(jsonStr);
  }

  // Otherwise try decoding the whole key as base64url JSON
  try {
    const jsonStr = base64UrlToUtf8(k);
    return safeJsonParse(jsonStr);
  } catch {
    return null;
  }
}

function normalizePlanName(raw?: string): string {
  const p = (raw || "").trim().toLowerCase();
  if (!p) return DEFAULT_PLAN_NAME;
  if (["trial", "free"].includes(p)) return "Trial";
  if (["friend", "basic"].includes(p)) return "Friend";
  if (["romantic", "romance"].includes(p)) return "Romantic";
  if (["intimate", "adult"].includes(p)) return "Intimate";
  if (["pro", "premium", "plus"].includes(p)) return "Pro";
  return DEFAULT_PLAN_NAME;
}

function pickMetaPlan(meta: CompanionKeyMeta | null): string {
  if (!meta) return DEFAULT_PLAN_NAME;
  return normalizePlanName(
    meta.plan_name ?? meta.planName ?? meta.plan ?? meta.membership_plan ?? meta.membership ?? meta.tier
  );
}

function pickMetaCompanionName(meta: CompanionKeyMeta | null): string {
  if (!meta) return DEFAULT_COMPANION_NAME;
  return (
    meta.companion_name ??
    meta.companionName ??
    meta.companion ??
    meta.name ??
    DEFAULT_COMPANION_NAME
  );
}

export default function MyElaraloPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [companionKey, setCompanionKey] = useState<string>("");

  // Load from query param first, then localStorage
  useEffect(() => {
    const fromUrl = searchParams.get("companion_key") || "";
    const fromLs = typeof window !== "undefined" ? localStorage.getItem(LS_COMPANION_KEY) || "" : "";
    const initial = (fromUrl || fromLs || "").trim();
    if (initial) setCompanionKey(initial);

    if (fromUrl) {
      try {
        localStorage.setItem(LS_COMPANION_KEY, fromUrl);
      } catch {}
    }
  }, [searchParams]);

  const meta = useMemo(() => decodeCompanionKey(companionKey), [companionKey]);

  const companionName = useMemo(() => pickMetaCompanionName(meta), [meta]);
  const planName = useMemo(() => pickMetaPlan(meta), [meta]);

  const openCompanion = () => {
    const ck = (companionKey || "").trim();
    if (!ck) {
      router.push("/companion");
      return;
    }
    try {
      localStorage.setItem(LS_COMPANION_KEY, ck);
    } catch {}
    router.push(`/companion?companion_key=${encodeURIComponent(ck)}`);
  };

  const saveKeyOnly = () => {
    const ck = (companionKey || "").trim();
    try {
      localStorage.setItem(LS_COMPANION_KEY, ck);
    } catch {}
  };

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "linear-gradient(180deg, #070A12, #05060B)" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: 18,
            borderRadius: 16,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 14px 40px rgba(0,0,0,0.35)",
          }}
        >
          <img
            src={DEFAULT_AVATAR_URL}
            alt="Elaralo"
            width={54}
            height={54}
            style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)" }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.2 }}>My Elaralo</div>
            <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }}>
              Companion: <span style={{ fontWeight: 600 }}>{companionName}</span>
              <span style={{ marginLeft: 10 }}>
                Plan: <span style={{ fontWeight: 600 }}>{planName}</span>
              </span>
            </div>
          </div>
          <button
            onClick={openCompanion}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.10)",
              border: "1px solid rgba(255,255,255,0.16)",
              color: "rgba(255,255,255,0.92)",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Open Companion
          </button>
        </header>

        <section
          style={{
            marginTop: 14,
            padding: 18,
            borderRadius: 16,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Companion Key</div>
          <textarea
            value={companionKey}
            onChange={(e) => setCompanionKey(e.target.value)}
            placeholder="Paste companion_key here (optional). If blank, defaults apply."
            rows={4}
            style={{
              width: "100%",
              resize: "vertical",
              borderRadius: 12,
              padding: 12,
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.92)",
              outline: "none",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: 12.5,
              lineHeight: 1.4,
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={saveKeyOnly}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.14)",
                color: "rgba(255,255,255,0.90)",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Save Key
            </button>
            <button
              onClick={openCompanion}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(122, 162, 247, 0.18)",
                border: "1px solid rgba(122, 162, 247, 0.32)",
                color: "rgba(255,255,255,0.92)",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Open Companion
            </button>
          </div>

          <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 12, marginTop: 10 }}>
            If <code style={{ color: "rgba(255,255,255,0.85)" }}>companion_key</code> does not include a plan, the UI defaults to{" "}
            <b>Trial</b>. If it does not include a mode, the UI defaults to <b>Friend</b>.
          </div>
        </section>

        <section
          style={{
            marginTop: 14,
            padding: 18,
            borderRadius: 16,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Quick Links</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <a
              href="/companion"
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.90)",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Companion (no key)
            </a>
            <a
              href={companionKey ? `/companion?companion_key=${encodeURIComponent(companionKey)}` : "/companion"}
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.90)",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Companion (with key)
            </a>
            <a
              href="/health"
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.90)",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Health
            </a>
            <a
              href="/site"
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.90)",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Site
            </a>
          </div>
        </section>

        <footer style={{ marginTop: 18, color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
          Elaralo • {new Date().getFullYear()}
        </footer>
      </div>
    </main>
  );
}
