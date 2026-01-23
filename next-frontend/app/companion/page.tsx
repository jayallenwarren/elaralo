"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Role = "user" | "assistant";
type ExperienceMode = "chat" | "audio" | "video";
type Mode = "friend" | "romantic" | "intimate";
type PlanName = "Trial" | "Friend" | "Romantic" | "Intimate" | "Pro";

type Msg = { role: Role; content: string };

type SessionState = {
  mode: Mode;
  plan_name: PlanName;
  companion: string;
  companion_name?: string;
  companionName?: string;
  member_id?: string;
  memberId?: string;

  // Keep extra passthrough fields for compatibility with existing backends
  [k: string]: any;
};

type ChatApiResponse = {
  reply?: string;
  text?: string;
  audio_url?: string;
  status_mode?: string;
  session_state?: any;
};

const DEFAULT_COMPANION_NAME = "Elara";
const DEFAULT_AVATAR_URL = "/elaralo_logo.png";

// Use Elara as the key, but the voice id value is the one you previously used.
const ELEVEN_VOICE_IDS: Record<string, string> = {
  Elara: "rJ9XoWu8gbUhVKZnKY8X",
};

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate",
};

function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizePlanName(raw: any): PlanName {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "Trial";
  if (s.includes("trial") || s.includes("test")) return "Trial";
  if (s.includes("pro")) return "Pro";
  if (s.includes("intimate")) return "Intimate";
  if (s.includes("romantic")) return "Romantic";
  if (s.includes("friend")) return "Friend";
  return "Trial";
}

function normalizeMode(raw: any): Mode {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "friend";
  // Trial “mode” (if it appears) maps to Romantic pill/behavior.
  if (s.includes("trial")) return "romantic";
  if (s.includes("intimate")) return "intimate";
  if (s.includes("romantic")) return "romantic";
  if (s.includes("friend")) return "friend";
  return "friend";
}

function allowedModesForPlan(plan: PlanName): Mode[] {
  if (plan === "Friend") return ["friend"];
  if (plan === "Romantic") return ["friend", "romantic"];
  if (plan === "Trial") return ["friend", "romantic"];
  if (plan === "Intimate") return ["friend", "romantic", "intimate"];
  // Pro
  return ["friend", "romantic", "intimate"];
}

function getElevenVoiceIdForCompanionKey(companionKeyOrName: string): string {
  const key = (companionKeyOrName || "").trim();
  if (!key) return ELEVEN_VOICE_IDS.Elara;

  // If the key comes through as something like "Elara-Female-..." take the first token.
  const firstToken = key.split("-")[0]?.trim() || key;
  return ELEVEN_VOICE_IDS[firstToken] || ELEVEN_VOICE_IDS.Elara;
}

function getApiBase(): string {
  const env =
    (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE || "").trim();
  const base = (env || "http://127.0.0.1:8000").replace(/\/+$/, "");
  return base;
}

function trimMessagesForChat(msgs: Msg[], maxMsgs = 60): Msg[] {
  if (msgs.length <= maxMsgs) return msgs;
  return msgs.slice(msgs.length - maxMsgs);
}

function buildTodayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `elaralo_today_seconds_${yyyy}-${mm}-${dd}`;
}

function IconButton({
  title,
  onClick,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 44,
        height: 44,
        borderRadius: 10,
        border: "1px solid #cfcfcf",
        background: active ? "#eef5ff" : "#fff",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
      }}
    >
      {children}
    </button>
  );
}

function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 12px",
        borderRadius: 999,
        border: active ? "1px solid #2b6cb0" : "1px solid #cfcfcf",
        background: active ? "#eef5ff" : "#fff",
        cursor: "pointer",
        fontWeight: 700,
        fontSize: 12.5,
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}

export default function CompanionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const API_BASE = useMemo(() => getApiBase(), []);
  const VIDEO_MODE_URL = (process.env.NEXT_PUBLIC_VIDEO_MODE_URL || "").trim();

  // ---- Companion key parsing (supports JSON or string) ----
  const companionKeyRaw = (searchParams.get("companion_key") || "").trim();
  const parsedKey = useMemo(() => safeJsonParse<any>(companionKeyRaw), [companionKeyRaw]);

  const companionName = useMemo(() => {
    if (parsedKey) {
      return (
        parsedKey.first_name ||
        parsedKey.name ||
        parsedKey.companion_name ||
        parsedKey.companionName ||
        parsedKey.companion ||
        DEFAULT_COMPANION_NAME
      );
    }
    if (companionKeyRaw) return companionKeyRaw;
    return DEFAULT_COMPANION_NAME;
  }, [parsedKey, companionKeyRaw]);

  const planName: PlanName = useMemo(() => {
    if (parsedKey) {
      return normalizePlanName(
        parsedKey.plan ||
          parsedKey.plan_name ||
          parsedKey.planName ||
          parsedKey.member_plan ||
          parsedKey.memberPlan
      );
    }
    return "Trial";
  }, [parsedKey]);

  const memberId = useMemo(() => {
    if (!parsedKey) return "";
    return String(parsedKey.member_id || parsedKey.memberId || parsedKey.member || "").trim();
  }, [parsedKey]);

  const avatarUrl = useMemo(() => {
    if (parsedKey && parsedKey.avatar_url) return String(parsedKey.avatar_url);
    if (parsedKey && parsedKey.avatarUrl) return String(parsedKey.avatarUrl);
    return DEFAULT_AVATAR_URL;
  }, [parsedKey]);

  const initialMode: Mode = useMemo(() => {
    if (parsedKey) return normalizeMode(parsedKey.mode || parsedKey.relationship_mode);
    return "friend";
  }, [parsedKey]);

  const allowedModes = useMemo(() => allowedModesForPlan(planName), [planName]);

  const voiceId = useMemo(() => {
    const keyForVoice =
      (parsedKey && (parsedKey.companion_key || parsedKey.companion || parsedKey.name)) ||
      companionName ||
      DEFAULT_COMPANION_NAME;
    return getElevenVoiceIdForCompanionKey(String(keyForVoice));
  }, [parsedKey, companionName]);

  // ---- Session + timers ----
  const sessionIdRef = useRef<string>(
    (globalThis.crypto as any)?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const sessionStartMsRef = useRef<number>(Date.now());

  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [dailySeconds, setDailySeconds] = useState(0);

  useEffect(() => {
    const todayKey = buildTodayKey();
    const saved = Number(localStorage.getItem(todayKey) || "0");
    setDailySeconds(Number.isFinite(saved) ? saved : 0);

    const t = window.setInterval(() => {
      const now = Date.now();
      const sess = Math.floor((now - sessionStartMsRef.current) / 1000);
      setSessionSeconds(sess);

      const base = Number(localStorage.getItem(todayKey) || "0");
      const next = (Number.isFinite(base) ? base : 0) + 1;
      localStorage.setItem(todayKey, String(next));
      setDailySeconds(next);
    }, 1000);

    return () => window.clearInterval(t);
  }, []);

  // ---- Core UI state ----
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>("chat");
  const [showModePicker, setShowModePicker] = useState(false);

  const [sessionState, setSessionState] = useState<SessionState>(() => ({
    mode: allowedModes.includes(initialMode) ? initialMode : "friend",
    plan_name: planName,
    companion: companionName || DEFAULT_COMPANION_NAME,
    companion_name: companionName || DEFAULT_COMPANION_NAME,
    companionName: companionName || DEFAULT_COMPANION_NAME,
    member_id: memberId || "",
    memberId: memberId || "",
    companion_key_raw: companionKeyRaw || "",
  }));

  useEffect(() => {
    setSessionState((prev) => ({
      ...prev,
      plan_name: planName,
      companion: companionName || DEFAULT_COMPANION_NAME,
      companion_name: companionName || DEFAULT_COMPANION_NAME,
      companionName: companionName || DEFAULT_COMPANION_NAME,
      member_id: memberId || "",
      memberId: memberId || "",
      companion_key_raw: companionKeyRaw || "",
      mode: allowedModes.includes(prev.mode) ? prev.mode : "friend",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planName, companionName, memberId, companionKeyRaw, allowedModes.join(",")]);

  const [messages, setMessages] = useState<Msg[]>(() => [
    { role: "assistant", content: `Hi, ${companionName || DEFAULT_COMPANION_NAME} here. What’s on your mind?` },
    { role: "assistant", content: `Mode set to: ${MODE_LABELS[allowedModes.includes(initialMode) ? initialMode : "friend"]}` },
  ]);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState("");

  // ---- TTS playback via hidden video element ----
  const ttsVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const lastAssistantTextRef = useRef<string>("");
  const lastAssistantAudioUrlRef = useRef<string>("");

  const stopAudio = useCallback(() => {
    const v = ttsVideoRef.current;
    if (v) {
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {}
    }
    setIsSpeaking(false);
  }, []);

  const playAudioUrl = useCallback(async (url: string) => {
    const v = ttsVideoRef.current;
    if (!v) return;
    try {
      setIsSpeaking(false);
      v.pause();
      v.src = url;
      v.currentTime = 0;
      const p = v.play();
      if (p) await p;
      setIsSpeaking(true);
    } catch (e: any) {
      setStatusLine("Audio playback was blocked by the browser. Click once anywhere, then try Play again.");
      setIsSpeaking(false);
    }
  }, []);

  const callTtsAudioUrl = useCallback(
    async (text: string): Promise<string | null> => {
      const clean = (text || "").trim();
      if (!clean) return null;

      try {
        const res = await fetch(`${API_BASE}/tts/audio-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            voice_id: voiceId,
            voiceId: voiceId, // compatibility
            text: clean,
          }),
        });

        if (!res.ok) return null;
        const data = (await res.json()) as any;
        const url = String(data?.audio_url || data?.audioUrl || "").trim();
        return url || null;
      } catch {
        return null;
      }
    },
    [API_BASE, voiceId]
  );

  const speakLast = useCallback(async () => {
    const txt = (lastAssistantTextRef.current || "").trim();
    if (!txt) return;

    const existingUrl = (lastAssistantAudioUrlRef.current || "").trim();
    if (existingUrl) {
      await playAudioUrl(existingUrl);
      return;
    }

    const url = await callTtsAudioUrl(txt);
    if (url) {
      lastAssistantAudioUrlRef.current = url;
      await playAudioUrl(url);
    }
  }, [callTtsAudioUrl, playAudioUrl]);

  // ---- STT (Web Speech when available; otherwise backend /stt/transcribe as fallback) ----
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const [listening, setListening] = useState(false);

  const stopListening = useCallback(() => {
    setListening(false);

    // Web Speech
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    }

    // MediaRecorder
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    setStatusLine("");
    setListening(true);

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    // Prefer Web Speech if present
    if (SpeechRecognition) {
      try {
        const rec = new SpeechRecognition();
        recognitionRef.current = rec;

        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = "en-US";

        rec.onresult = (evt: any) => {
          const t = evt?.results?.[0]?.[0]?.transcript || "";
          const text = String(t).trim();
          if (text) {
            // In Audio/Video mode, auto-send on voice input.
            if (experienceMode !== "chat") {
              setInput("");
              void send(text);
            } else {
              setInput(text);
            }
          }
        };

        rec.onerror = () => {
          setStatusLine("Microphone recognition error.");
        };

        rec.onend = () => {
          setListening(false);
          recognitionRef.current = null;
        };

        rec.start();
        return;
      } catch {
        // fall through to MediaRecorder
      }
    }

    // Fallback: record a short clip and transcribe with backend
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];

      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        try {
          setListening(false);

          stream.getTracks().forEach((t) => t.stop());

          const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
          if (!blob.size) return;

          const fd = new FormData();
          fd.append("audio_file", blob, "speech.webm");

          const res = await fetch(`${API_BASE}/stt/transcribe`, {
            method: "POST",
            body: fd,
          });

          if (!res.ok) {
            setStatusLine("Speech transcription failed.");
            return;
          }

          const data = (await res.json()) as any;
          const text = String(data?.text || "").trim();
          if (text) {
            if (experienceMode !== "chat") {
              setInput("");
              void send(text);
            } else {
              setInput(text);
            }
          }
        } catch {
          setStatusLine("Speech transcription failed.");
        } finally {
          mediaRecorderRef.current = null;
          recordedChunksRef.current = [];
        }
      };

      mr.start();
      // Auto-stop after 7 seconds (short, predictable clip)
      window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          try {
            mediaRecorderRef.current.stop();
          } catch {}
        }
      }, 7000);
    } catch {
      setListening(false);
      setStatusLine("Microphone access is blocked in the browser.");
    }
  }, [API_BASE, experienceMode]);

  const toggleListening = useCallback(() => {
    if (listening) stopListening();
    else void startListening();
  }, [listening, startListening, stopListening]);

  // ---- Chat calls ----
  const callChat = useCallback(
    async (nextMessages: Msg[], stateToSend: SessionState): Promise<ChatApiResponse> => {
      const payload = {
        session_id: sessionIdRef.current,
        wants_explicit: false,
        voice_id: voiceId,
        voiceId: voiceId,
        session_state: {
          ...stateToSend,
          // enforce companion identity fields for backend compatibility
          companion: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
          companionName: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
          companion_name: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
          member_id: (memberId || "").trim(),
          memberId: (memberId || "").trim(),
        },
        messages: trimMessagesForChat(nextMessages).map((m) => ({ role: m.role, content: m.content })),
      };

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Backend error ${res.status}: ${txt}`);
      }

      return (await res.json()) as ChatApiResponse;
    },
    [API_BASE, voiceId, companionName, memberId]
  );

  const callSaveChatSummary = useCallback(
    async (nextMessages: Msg[], stateToSend: SessionState) => {
      const res = await fetch(`${API_BASE}/chat/save-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          session_state: {
            ...stateToSend,
            companion: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
            companionName: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
            companion_name: stateToSend.companion || companionName || DEFAULT_COMPANION_NAME,
            member_id: (memberId || "").trim(),
            memberId: (memberId || "").trim(),
          },
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Backend error ${res.status}: ${txt}`);
      }
      return (await res.json()) as any;
    },
    [API_BASE, companionName, memberId]
  );

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text) return;
      if (busy) return;

      setBusy(true);
      setStatusLine("");

      const nextMessages: Msg[] = [...messages, { role: "user", content: text }];
      setMessages(nextMessages);

      if (!textOverride) setInput("");

      try {
        const resp = await callChat(nextMessages, sessionState);

        const reply = String(resp.reply || resp.text || "").trim();
        if (resp.session_state) {
          setSessionState((prev) => ({ ...prev, ...resp.session_state }));
        }

        if (reply) {
          setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
          lastAssistantTextRef.current = reply;

          const audioUrl = String(resp.audio_url || "").trim();
          if (audioUrl) lastAssistantAudioUrlRef.current = audioUrl;

          // Auto-speak only in audio/video modes.
          if ((experienceMode === "audio" || experienceMode === "video") && (audioUrl || reply)) {
            const urlToPlay = audioUrl || (await callTtsAudioUrl(reply));
            if (urlToPlay) {
              lastAssistantAudioUrlRef.current = urlToPlay;
              await playAudioUrl(urlToPlay);
            }
          }
        }
      } catch (e: any) {
        setStatusLine(e?.message ? String(e.message) : "Chat failed.");
      } finally {
        setBusy(false);
      }
    },
    [input, busy, messages, callChat, sessionState, experienceMode, callTtsAudioUrl, playAudioUrl]
  );

  // ---- Relationship mode picker ----
  const visibleModePills: Mode[] = useMemo(() => {
    // Do not show any disabled pills: only show modes included in plan.
    return ["friend", "romantic", "intimate"].filter((m) => allowedModes.includes(m as Mode)) as Mode[];
  }, [allowedModes]);

  const setModeFromPill = useCallback(
    (m: Mode) => {
      if (!allowedModes.includes(m)) return; // should never happen because we only show allowed
      setSessionState((prev) => ({ ...prev, mode: m }));
      setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` }]);
      setShowModePicker(false);
    },
    [allowedModes]
  );

  // ---- Bottom actions ----
  const newSession = useCallback(() => {
    stopAudio();
    stopListening();

    sessionIdRef.current =
      (globalThis.crypto as any)?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStartMsRef.current = Date.now();
    setSessionSeconds(0);

    setMessages([
      { role: "assistant", content: `Hi, ${companionName || DEFAULT_COMPANION_NAME} here. What’s on your mind?` },
      { role: "assistant", content: `Mode set to: ${MODE_LABELS[sessionState.mode]}` },
    ]);
    setInput("");
    setStatusLine("");
  }, [companionName, sessionState.mode, stopAudio, stopListening]);

  const clearChat = useCallback(() => {
    stopAudio();
    stopListening();
    setMessages([{ role: "assistant", content: `Hi, ${companionName || DEFAULT_COMPANION_NAME} here. What’s on your mind?` }]);
    setStatusLine("");
  }, [companionName, stopAudio, stopListening]);

  const saveSummary = useCallback(async () => {
    setStatusLine("");
    try {
      const res = await callSaveChatSummary(messages, sessionState);
      if (res?.ok) setStatusLine("Summary saved.");
      else setStatusLine("Summary save failed.");
    } catch (e: any) {
      setStatusLine(e?.message ? String(e.message) : "Summary save failed.");
    }
  }, [callSaveChatSummary, messages, sessionState]);

  const switchCompanion = useCallback(() => {
    stopAudio();
    stopListening();
    router.push("/myelaralo");
  }, [router, stopAudio, stopListening]);

  // ---- UI ----
  const activeModeLabel = MODE_LABELS[sessionState.mode] || "Friend";

  return (
    <div style={{ minHeight: "100vh", background: "#f2f2f2" }}>
      <div style={{ maxWidth: 1050, margin: "0 auto", padding: "22px 18px" }}>
        {/* Header */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <img
            src={avatarUrl || DEFAULT_AVATAR_URL}
            alt="Companion avatar"
            style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", border: "1px solid #d6d6d6" }}
          />

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: "#111", lineHeight: 1.1 }}>
              Elaralo
            </div>

            <div style={{ marginTop: 6, color: "#444", fontSize: 14 }}>
              Companion: <strong>{companionName || DEFAULT_COMPANION_NAME}</strong> ·{" "}
              Plan: <strong>{planName}</strong>
            </div>

            <div style={{ marginTop: 2, color: "#555", fontSize: 14 }}>
              Mode: <strong>{activeModeLabel}</strong>
            </div>

            <div style={{ marginTop: 6, color: "#666", fontSize: 12.5 }}>
              Session: {formatSeconds(sessionSeconds)} · Today: {formatSeconds(dailySeconds)}
            </div>

            {/* Controls row (mirrors the referenced layout pattern) */}
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {/* Left: play/mic/stop + live avatar status */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <IconButton title="Play (Speak Last)" onClick={() => void speakLast()} active={isSpeaking}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </IconButton>

                <IconButton title={listening ? "Stop Listening" : "Start Listening"} onClick={toggleListening} active={listening}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
                    <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z" />
                  </svg>
                </IconButton>

                <IconButton
                  title="Stop Audio"
                  onClick={() => {
                    stopAudio();
                    stopListening();
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
                    <path d="M6 6h12v12H6z" />
                  </svg>
                </IconButton>

                <div style={{ marginLeft: 6, fontSize: 13, color: "#555" }}>
                  Live Avatar: <strong>{experienceMode === "video" ? "video" : "idle"}</strong>
                </div>

                {/* Experience mode pills (not condensed) */}
                <div style={{ display: "flex", gap: 8, marginLeft: 10, flexWrap: "wrap" }}>
                  <Pill label="Chat" active={experienceMode === "chat"} onClick={() => setExperienceMode("chat")} />
                  <Pill label="Audio" active={experienceMode === "audio"} onClick={() => setExperienceMode("audio")} />
                  <Pill label="Video" active={experienceMode === "video"} onClick={() => setExperienceMode("video")} />
                </div>
              </div>

              {/* Right: Set Mode + Switch Companion */}
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setShowModePicker((v) => !v)}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: "1px solid #cfcfcf",
                    background: "#fff",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Set Mode
                </button>

                <button
                  type="button"
                  onClick={switchCompanion}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: "1px solid #cfcfcf",
                    background: "#fff",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Switch Companion
                </button>
              </div>
            </div>

            {/* Relationship mode pills under Set Mode */}
            {showModePicker && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {visibleModePills.map((m) => (
                  <Pill
                    key={m}
                    label={MODE_LABELS[m]}
                    active={sessionState.mode === m}
                    onClick={() => setModeFromPill(m)}
                  />
                ))}

                <div style={{ fontSize: 12.5, color: "#666", marginLeft: 6 }}>
                  Only modes included in the member’s plan are shown. Trial maps to Romantic. No disabled pills are selectable.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Video mode panel */}
        {experienceMode === "video" && (
          <div
            style={{
              marginTop: 16,
              background: "#fff",
              border: "1px solid #d6d6d6",
              borderRadius: 14,
              padding: 12,
            }}
          >
            {VIDEO_MODE_URL ? (
              <iframe
                src={VIDEO_MODE_URL}
                style={{ width: "100%", height: 360, border: 0, borderRadius: 10 }}
                allow="camera; microphone; autoplay; clipboard-write; display-capture"
                title="Video mode"
              />
            ) : (
              <div style={{ color: "#444", fontSize: 14 }}>
                Video mode is enabled, but <code>NEXT_PUBLIC_VIDEO_MODE_URL</code> is not set.
              </div>
            )}
          </div>
        )}

        {/* Conversation box */}
        <div
          style={{
            marginTop: 16,
            background: "#fff",
            border: "1px solid #d6d6d6",
            borderRadius: 16,
            padding: 16,
            minHeight: 460,
          }}
        >
          {messages.map((m, idx) => (
            <div key={idx} style={{ marginBottom: 10, fontSize: 16, color: "#111" }}>
              <strong style={{ fontWeight: 800 }}>
                {m.role === "assistant" ? `${companionName || DEFAULT_COMPANION_NAME}:` : "You:"}
              </strong>{" "}
              <span>{m.content}</span>
            </div>
          ))}

          {statusLine && (
            <div style={{ marginTop: 10, fontSize: 13.5, color: "#b00020" }}>
              {statusLine}
            </div>
          )}
        </div>

        {/* Input row (icon controls + input + send) */}
        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => void saveSummary()}
            title="Save Summary"
            aria-label="Save Summary"
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: "1px solid #cfcfcf",
              background: "#fff",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
              <path d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM8 12h8v2H8v-2zm0 4h8v2H8v-2z" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => {
              // Keep behavior: New Session is separate from “clear chat”
              newSession();
            }}
            title="New Session"
            aria-label="New Session"
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: "1px solid #cfcfcf",
              background: "#fff",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
              <path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6a6 6 0 0 1-6 6 6 6 0 0 1-5.65-4H4.26A8 8 0 0 0 12 21a8 8 0 0 0 0-16z" />
            </svg>
          </button>

          <button
            type="button"
            onClick={clearChat}
            title="Clear Messages"
            aria-label="Clear Messages"
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: "1px solid #cfcfcf",
              background: "#fff",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#111" aria-hidden="true">
              <path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z" />
            </svg>
          </button>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            style={{
              flex: 1,
              minWidth: 260,
              height: 44,
              borderRadius: 12,
              border: "1px solid #cfcfcf",
              padding: "0 14px",
              fontSize: 16,
              outline: "none",
              background: "#fff",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy}
          />

          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            style={{
              height: 44,
              padding: "0 18px",
              borderRadius: 12,
              border: "1px solid #111",
              background: "#111",
              color: "#fff",
              fontWeight: 800,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Sending..." : "Send"}
          </button>
        </div>

        {/* Hidden TTS video element (audio playback stability) */}
        <video
          ref={ttsVideoRef}
          playsInline
          preload="auto"
          style={{ width: 0, height: 0, opacity: 0, position: "absolute", left: -9999 }}
          onEnded={() => setIsSpeaking(false)}
          onPause={() => setIsSpeaking(false)}
        />
      </div>
    </div>
  );
}

/**
 * D-ID integration placeholder (kept intentionally for future use)
 *
 * The Elaralo Video mode currently uses video conferencing / streaming (iframe).
 * If you re-enable live avatar rendering later, the D-ID wiring can be restored here.
 */
