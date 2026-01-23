\
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Elaralo Companion Page
 *
 * Key requirements implemented:
 * - Uses Elaralo branding and companion name Elara (no legacy naming).
 * - Relationship Mode pills are NOT condensed:
 *   - only allowed modes are shown (no disabled pill concept)
 *   - pills are always visible underneath the "Set Mode" button
 * - Trial mode (legacy) maps to the Romantic pill
 * - If companion_key has no plan => default plan Trial
 * - If companion_key has no mode => default mode Friend
 * - Audio Mode plays TTS using a hidden <video> element (stable cross-device)
 * - Video Mode is a hosted video conference/streaming embed (no D-ID; no ElevenLabs in this mode)
 * - D‑ID code is retained but commented out for future use
 */

type ExperienceMode = "chat" | "audio" | "video";
type RelationshipMode = "friend" | "romantic" | "intimate";
type ChatRole = "user" | "assistant";

type CompanionKeyMeta = Record<string, any>;

const API_BASE =
  process.env.NEXT_PUBLIC_ELARALO_API_BASE ||
  process.env.NEXT_PUBLIC_ELARALO_API_BASE_URL ||
  "http://127.0.0.1:8000";

const VIDEO_MODE_URL =
  process.env.NEXT_PUBLIC_ELARALO_VIDEO_MODE_URL ||
  process.env.NEXT_PUBLIC_VIDEO_MODE_URL ||
  "";

const LS_COMPANION_KEY = "elaralo_companion_key_v1";
const LS_PLAN_NAME = "elaralo_plan_name_v1";
const LS_REL_MODE = "elaralo_relationship_mode_v1";

const DEFAULT_COMPANION_KEY = "elaralo";
const DEFAULT_COMPANION_NAME = "Elara";
const DEFAULT_PLAN_NAME = "Trial";
const DEFAULT_REL_MODE: RelationshipMode = "friend";
const DEFAULT_AVATAR_URL = "/elaralo_logo.png";

const ROMANTIC_ALLOWED_PLANS = new Set(["Trial", "Romantic", "Pro"]);
const INTIMATE_ALLOWED_PLANS = new Set(["Intimate", "Pro"]);

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

  // JSON
  if (k.startsWith("{") && k.endsWith("}")) return safeJsonParse(k);

  // JWT payload decode
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      const jsonStr = base64UrlToUtf8(parts[1]);
      return safeJsonParse(jsonStr);
    } catch {
      return null;
    }
  }

  // whole-key base64url JSON
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

function normalizeMode(raw?: string): RelationshipMode {
  const m = (raw || "").trim().toLowerCase();
  if (!m) return DEFAULT_REL_MODE;
  if (["friend", "friendly", "companion"].includes(m)) return "friend";
  if (["romantic", "romance", "flirty"].includes(m)) return "romantic";
  if (["trial"].includes(m)) return "romantic"; // legacy Trial pill -> Romantic pill
  if (["intimate", "adult"].includes(m)) return "intimate";
  return DEFAULT_REL_MODE;
}

function allowedModesForPlan(planName: string, explicitAllowed: boolean): RelationshipMode[] {
  const plan = normalizePlanName(planName);
  const out: RelationshipMode[] = ["friend"];

  if (ROMANTIC_ALLOWED_PLANS.has(plan)) out.push("romantic");
  if (INTIMATE_ALLOWED_PLANS.has(plan) && explicitAllowed) out.push("intimate");

  // de-dup
  return Array.from(new Set(out));
}

function pickMetaPlan(meta: CompanionKeyMeta | null): string {
  if (!meta) return DEFAULT_PLAN_NAME;
  return normalizePlanName(
    meta.plan_name ?? meta.planName ?? meta.plan ?? meta.membership_plan ?? meta.membership ?? meta.tier
  );
}

function pickMetaMode(meta: CompanionKeyMeta | null): RelationshipMode {
  if (!meta) return DEFAULT_REL_MODE;
  return normalizeMode(meta.mode ?? meta.relationship_mode ?? meta.relationshipMode);
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

function pickMetaAvatarUrl(meta: CompanionKeyMeta | null): string {
  if (!meta) return DEFAULT_AVATAR_URL;
  return (meta.avatar_url ?? meta.avatarUrl ?? meta.avatar ?? DEFAULT_AVATAR_URL) as string;
}

function pickMetaExplicitAllowed(meta: CompanionKeyMeta | null): boolean {
  if (!meta) return false;
  const v = meta.explicit_allowed ?? meta.explicitAllowed ?? meta.adult_allowed ?? meta.adultAllowed;
  return v === true;
}

function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type UiMessage = {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
};

function uuid(): string {
  // Good enough for UI ids without importing dependencies
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

export default function CompanionPage() {
  const searchParams = useSearchParams();

  // Session / identity
  const [sessionId, setSessionId] = useState<string>(() => uuid());
  const [companionKey, setCompanionKey] = useState<string>("");

  // Derived from companion_key (or defaults)
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarUrl, setAvatarUrl] = useState<string>(DEFAULT_AVATAR_URL);
  const [planName, setPlanName] = useState<string>(DEFAULT_PLAN_NAME);
  const [explicitAllowed, setExplicitAllowed] = useState<boolean>(false);

  // Relationship mode: active + pending
  const [mode, setMode] = useState<RelationshipMode>(DEFAULT_REL_MODE);
  const [pendingMode, setPendingMode] = useState<RelationshipMode>(DEFAULT_REL_MODE);

  // Experience mode
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>("chat");

  // Chat state
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("");

  // TTS: stable playback uses hidden <video>
  const ttsVideoRef = useRef<HTMLVideoElement | null>(null);
  const [ttsBusy, setTtsBusy] = useState<boolean>(false);

  // STT (browser)
  const recognitionRef = useRef<any>(null);
  const [listening, setListening] = useState<boolean>(false);

  // Time tracking (local)
  const [sessionSeconds, setSessionSeconds] = useState<number>(0);
  const [dailySeconds, setDailySeconds] = useState<number>(0);

  const allowedModes = useMemo(() => allowedModesForPlan(planName, explicitAllowed), [planName, explicitAllowed]);

  // ----------------------------------------------------------------------------
  // Load companion_key from URL or localStorage, then derive plan/mode/name
  // ----------------------------------------------------------------------------
  useEffect(() => {
    const fromUrl = (searchParams.get("companion_key") || "").trim();
    const fromLs = typeof window !== "undefined" ? (localStorage.getItem(LS_COMPANION_KEY) || "").trim() : "";
    const initialKey = fromUrl || fromLs || DEFAULT_COMPANION_KEY;

    setCompanionKey(initialKey);

    if (fromUrl) {
      try {
        localStorage.setItem(LS_COMPANION_KEY, fromUrl);
      } catch {}
    }

    const meta = decodeCompanionKey(initialKey);

    // Plan default is Trial if missing from key (per requirement)
    const nextPlan = pickMetaPlan(meta);
    setPlanName(nextPlan);

    // Mode default is Friend if missing from key (per requirement)
    const nextMode = pickMetaMode(meta);

    const nextCompanionName = pickMetaCompanionName(meta);
    setCompanionName(nextCompanionName);

    const nextAvatar = pickMetaAvatarUrl(meta);
    setAvatarUrl(nextAvatar);

    const nextExplicitAllowed = pickMetaExplicitAllowed(meta);
    setExplicitAllowed(nextExplicitAllowed);

    // If key doesn't specify, fall back to localStorage (optional; does not override explicit requirement defaults)
    let effectiveMode = nextMode;
    if (!meta) {
      const savedMode = (typeof window !== "undefined" ? localStorage.getItem(LS_REL_MODE) : "") || "";
      effectiveMode = normalizeMode(savedMode);
    }

    const effectiveAllowed = allowedModesForPlan(nextPlan, nextExplicitAllowed);
    if (!effectiveAllowed.includes(effectiveMode)) {
      effectiveMode = effectiveAllowed[0] || DEFAULT_REL_MODE;
    }

    setMode(effectiveMode);
    setPendingMode(effectiveMode);

    // Save plan for later pages (optional)
    try {
      localStorage.setItem(LS_PLAN_NAME, nextPlan);
      localStorage.setItem(LS_REL_MODE, effectiveMode);
    } catch {}
  }, [searchParams]);

  // Keep mode legal when plan changes
  useEffect(() => {
    if (!allowedModes.includes(mode)) {
      const fallback = allowedModes[0] || DEFAULT_REL_MODE;
      setMode(fallback);
      setPendingMode(fallback);
      try {
        localStorage.setItem(LS_REL_MODE, fallback);
      } catch {}
    }
  }, [allowedModes, mode]);

  // ----------------------------------------------------------------------------
  // Time tracking (session + daily)
  // ----------------------------------------------------------------------------
  useEffect(() => {
    const day = todayKey();
    const lsKey = `elaralo_daily_seconds_${day}`;
    try {
      const stored = parseInt(localStorage.getItem(lsKey) || "0", 10);
      setDailySeconds(Number.isFinite(stored) ? stored : 0);
    } catch {
      setDailySeconds(0);
    }

    const interval = window.setInterval(() => {
      setSessionSeconds((s) => s + 1);
      setDailySeconds((d) => {
        const nd = d + 1;
        try {
          localStorage.setItem(lsKey, String(nd));
        } catch {}
        return nd;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  // ----------------------------------------------------------------------------
  // STT: Browser speech recognition
  // ----------------------------------------------------------------------------
  const startListening = () => {
    const w = window as any;
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus("Speech Recognition is not supported in this browser.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event: any) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput((prev) => {
        // if user already typed, append; otherwise replace
        const base = prev.trim().length ? prev.trim() + " " : "";
        return (base + transcript).trimStart();
      });
    };

    rec.onerror = () => {
      setListening(false);
      setStatus("Speech recognition error.");
    };

    rec.onend = () => setListening(false);

    recognitionRef.current = rec;
    setListening(true);
    setStatus("");
    rec.start();
  };

  const stopListening = () => {
    try {
      recognitionRef.current?.stop?.();
    } catch {}
    setListening(false);
  };

  // ----------------------------------------------------------------------------
  // TTS helpers
  // ----------------------------------------------------------------------------
  const stopTts = () => {
    // Stop hidden video playback
    const vid = ttsVideoRef.current;
    if (vid) {
      try {
        vid.pause();
        vid.removeAttribute("src");
        vid.load();
      } catch {}
    }
    // Stop browser speech synthesis
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  };

  const speakWithBrowser = async (text: string) => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) {
      setStatus("Browser TTS is not available.");
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    } catch {
      setStatus("Browser TTS failed.");
    }
  };

  const speakWithElevenLabs = async (text: string) => {
    if (!text.trim()) return;
    setTtsBusy(true);
    setStatus("");
    try {
      const resp = await fetch(`${API_BASE}/tts/audio-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          text,
          companion_key: companionKey || DEFAULT_COMPANION_KEY,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err || `TTS failed (${resp.status})`);
      }

      const data = await resp.json();
      const audioUrl = data.audio_url as string;

      const vid = ttsVideoRef.current;
      if (!vid) {
        throw new Error("Hidden video element not available.");
      }

      // Important: Audio Mode uses a hidden <video> element for stable playback.
      vid.pause();
      vid.src = audioUrl;
      vid.load();

      // Attempt play; on iOS/Safari this requires a user gesture (Send / Speak button click satisfies)
      await vid.play();
    } finally {
      setTtsBusy(false);
    }
  };

  const speak = async (text: string) => {
    // Video Mode: no ElevenLabs; use browser TTS (vendor-agnostic)
    if (experienceMode === "video") {
      await speakWithBrowser(text);
      return;
    }

    // Chat/Audio: ElevenLabs audio URL
    await speakWithElevenLabs(text);
  };

  // ----------------------------------------------------------------------------
  // Chat send
  // ----------------------------------------------------------------------------
  const appendMessage = (role: ChatRole, content: string) => {
    const msg: UiMessage = { id: uuid(), role, content, ts: Date.now() };
    setMessages((m) => [...m, msg]);
    return msg;
  };

  const clearChat = () => {
    stopTts();
    setMessages([]);
    setInput("");
    setStatus("");
    setSessionId(uuid());
  };

  const commitMode = () => {
    if (!allowedModes.includes(pendingMode)) return;

    setMode(pendingMode);
    try {
      localStorage.setItem(LS_REL_MODE, pendingMode);
    } catch {}
    setStatus(`Mode set to ${pendingMode === "friend" ? "Friend" : pendingMode === "romantic" ? "Romantic" : "Intimate"}.`);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setStatus("");

    appendMessage("user", text);
    setInput("");

    // Build history in the shape backend expects
    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const resp = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
          history,
          companion_key: companionKey || DEFAULT_COMPANION_KEY,
          session_state: {
            companion_key: companionKey || DEFAULT_COMPANION_KEY,
            companion_name: companionName,
            plan_name: planName,
            mode,
            explicit_allowed: explicitAllowed,
          },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err || `Chat failed (${resp.status})`);
      }

      const data = await resp.json();
      const reply = (data.reply || "").toString();
      appendMessage("assistant", reply);

      // Auto-speak in Audio and Video modes
      if (experienceMode === "audio" || experienceMode === "video") {
        await speak(reply);
      }
    } catch (e: any) {
      setStatus(e?.message || "Chat failed.");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Enter to send; Shift+Enter for newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // ----------------------------------------------------------------------------
  // UI helpers
  // ----------------------------------------------------------------------------
  const modeLabel = (m: RelationshipMode) => {
    if (m === "friend") return "Friend";
    if (m === "romantic") return "Romantic";
    return "Intimate";
  };

  const pillStyle = (m: RelationshipMode, active: boolean, pending: boolean) => {
    const isActive = active;
    const isPending = pending && !active;

    return {
      padding: "10px 12px",
      borderRadius: 999,
      border: isActive
        ? "1px solid rgba(122, 162, 247, 0.55)"
        : isPending
        ? "1px solid rgba(255,255,255,0.38)"
        : "1px solid rgba(255,255,255,0.16)",
      background: isActive
        ? "rgba(122, 162, 247, 0.18)"
        : isPending
        ? "rgba(255,255,255,0.10)"
        : "rgba(255,255,255,0.06)",
      color: "rgba(255,255,255,0.92)",
      cursor: "pointer",
      fontWeight: 800,
      fontSize: 12.5,
      userSelect: "none" as const,
    };
  };

  // ----------------------------------------------------------------------------
  // D‑ID placeholder (kept for future use — intentionally commented out)
  // ----------------------------------------------------------------------------
  /*
  // NOTE: Elaralo Video Mode does NOT use avatar synthesis vendors in current release.
  // The below is retained for possible future iteration.

  const [didSessionId, setDidSessionId] = useState<string | null>(null);
  const [didStreamUrl, setDidStreamUrl] = useState<string | null>(null);

  async function startDidAvatarSession() {
    // 1) Call backend to create D‑ID session
    // 2) Attach WebRTC stream
    // 3) Drive speaking by sending audio URLs or phonemes
  }
  */

  return (
    <main style={{ minHeight: "100vh", padding: 18, background: "linear-gradient(180deg, #070A12, #05060B)" }}>
      {/* Hidden video element for stable audio playback (Audio/Chat mode) */}
      <video
        ref={ttsVideoRef}
        playsInline
        // Keep it truly hidden but still usable
        style={{ position: "absolute", left: -9999, top: -9999, width: 1, height: 1, opacity: 0 }}
      />

      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Header */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 14px 40px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img
              src={avatarUrl || DEFAULT_AVATAR_URL}
              alt="Elaralo"
              width={56}
              height={56}
              style={{
                borderRadius: 16,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(0,0,0,0.25)",
              }}
            />
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 0.2 }}>
                {companionName}
              </div>
              <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }}>
                Plan: <span style={{ fontWeight: 800 }}>{planName}</span>
                <span style={{ marginLeft: 10 }}>
                  Active Mode: <span style={{ fontWeight: 800 }}>{modeLabel(mode)}</span>
                </span>
              </div>
              <div style={{ color: "rgba(255,255,255,0.60)", fontSize: 12, marginTop: 4 }}>
                Session: {formatSeconds(sessionSeconds)} • Today: {formatSeconds(dailySeconds)}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* Experience mode pills */}
            {(["chat", "audio", "video"] as ExperienceMode[]).map((m) => {
              const active = experienceMode === m;
              const label = m === "chat" ? "Chat" : m === "audio" ? "Audio" : "Video";
              return (
                <button
                  key={m}
                  onClick={() => {
                    stopTts();
                    setStatus("");
                    setExperienceMode(m);
                  }}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: active ? "1px solid rgba(122, 162, 247, 0.55)" : "1px solid rgba(255,255,255,0.16)",
                    background: active ? "rgba(122, 162, 247, 0.18)" : "rgba(255,255,255,0.06)",
                    color: "rgba(255,255,255,0.92)",
                    cursor: "pointer",
                    fontWeight: 900,
                    fontSize: 12.5,
                  }}
                >
                  {label}
                </button>
              );
            })}

            <button
              onClick={clearChat}
              style={{
                padding: "10px 12px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.06)",
                color: "rgba(255,255,255,0.92)",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 12.5,
              }}
            >
              New Session
            </button>
          </div>
        </header>

        {/* Relationship mode selection */}
        <section
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 14, fontWeight: 900 }}>Relationship Mode</div>

            <button
              onClick={commitMode}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.14)",
                color: "rgba(255,255,255,0.90)",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Set Mode
            </button>
          </div>

          {/* Pills are always visible under Set Mode (not condensed) */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {allowedModes.map((m) => (
              <div
                key={m}
                onClick={() => setPendingMode(m)}
                style={pillStyle(m, mode === m, pendingMode === m)}
                title={modeLabel(m)}
              >
                {modeLabel(m)}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, color: "rgba(255,255,255,0.60)", fontSize: 12 }}>
            Only modes included in the member’s plan are shown. Trial maps to Romantic. No disabled pills are selectable.
          </div>
        </section>

        {/* Video Mode */}
        {experienceMode === "video" && (
          <section
            style={{
              marginTop: 14,
              padding: 16,
              borderRadius: 16,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>Live Video</div>
            {VIDEO_MODE_URL ? (
              <iframe
                src={VIDEO_MODE_URL}
                style={{
                  width: "100%",
                  height: 520,
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.40)",
                }}
                allow="camera; microphone; fullscreen; speaker; display-capture"
              />
            ) : (
              <div style={{ color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                Set <code>NEXT_PUBLIC_ELARALO_VIDEO_MODE_URL</code> to an embeddable video-conference or streaming URL.
                <div style={{ marginTop: 8, color: "rgba(255,255,255,0.55)" }}>
                  Video Mode does not use avatar synthesis vendors. TTS and STT still run (browser TTS + browser speech recognition).
                </div>
              </div>
            )}
          </section>
        )}

        {/* Chat */}
        <section
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 14, fontWeight: 900 }}>Conversation</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => stopTts()}
                disabled={ttsBusy}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(255,255,255,0.90)",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 12.5,
                  opacity: ttsBusy ? 0.6 : 1,
                }}
              >
                Stop Audio
              </button>

              <button
                onClick={() => {
                  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
                  if (lastAssistant) speak(lastAssistant.content);
                }}
                disabled={ttsBusy || messages.length === 0}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(255,255,255,0.90)",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 12.5,
                  opacity: ttsBusy ? 0.6 : 1,
                }}
              >
                Speak Last
              </button>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(0,0,0,0.30)",
              padding: 14,
              minHeight: 260,
              maxHeight: 420,
              overflow: "auto",
            }}
          >
            {messages.length === 0 ? (
              <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13 }}>
                Start a conversation with {companionName}. Audio mode will speak responses automatically.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                    <div
                      style={{
                        maxWidth: "82%",
                        padding: "10px 12px",
                        borderRadius: 14,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background: m.role === "user" ? "rgba(122, 162, 247, 0.16)" : "rgba(255,255,255,0.06)",
                        color: "rgba(255,255,255,0.92)",
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.45,
                        fontSize: 13.5,
                      }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 11.5, color: "rgba(255,255,255,0.65)", marginBottom: 6 }}>
                        {m.role === "user" ? "You" : companionName}
                      </div>
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder={experienceMode === "video" ? "Type here… (Video Mode uses browser TTS)" : "Type here…"}
              style={{
                flex: 1,
                resize: "vertical",
                borderRadius: 14,
                padding: 12,
                background: "rgba(0,0,0,0.35)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.92)",
                outline: "none",
                fontSize: 13.5,
                lineHeight: 1.4,
              }}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={send}
                disabled={sending || !input.trim()}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: sending ? "rgba(255,255,255,0.06)" : "rgba(122, 162, 247, 0.18)",
                  border: sending ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(122, 162, 247, 0.32)",
                  color: "rgba(255,255,255,0.92)",
                  cursor: sending ? "not-allowed" : "pointer",
                  fontWeight: 900,
                }}
              >
                {sending ? "Sending…" : "Send"}
              </button>

              <button
                onClick={listening ? stopListening : startListening}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: listening ? "rgba(239, 68, 68, 0.18)" : "rgba(255,255,255,0.06)",
                  border: listening ? "1px solid rgba(239, 68, 68, 0.35)" : "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(255,255,255,0.92)",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                {listening ? "Stop Mic" : "Mic"}
              </button>
            </div>
          </div>

          {status && (
            <div style={{ marginTop: 10, color: "rgba(255,255,255,0.70)", fontSize: 12 }}>
              {status}
            </div>
          )}

          <div style={{ marginTop: 10, color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            Backend: <code>{API_BASE}</code>
          </div>
        </section>
      </div>
    </main>
  );
}
