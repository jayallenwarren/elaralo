"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

/**
 * Elaralo Companion (Elara)
 * - Single companion (no multi-companion selection)
 * - No avatar synthesis vendors
 * - Video Mode = embedded video conference / streaming video URL (vendor-agnostic)
 * - TTS + STT remain available in all modes
 * - Mode pills are ONLY shown when allowed by the member's plan (no disabled pills)
 * - "Trial" is a plan label (shown next to Plan), not a mode pill; if an incoming mode is "trial", it maps to "romantic"
 */

type Role = "user" | "assistant" | "system";
type Mode = "friend" | "romantic" | "intimate" | "video";

type PlanName = "Free" | "Trial" | "Starter" | "Plus" | "Pro";

type ChatMessage = {
  id: string;
  role: Exclude<Role, "system">;
  content: string;
  ts: number;
};

type SessionState = {
  session_id?: string;
  member_id?: string;
  member_email?: string;

  // Elaralo fields
  plan?: PlanName;
  companion_key?: string; // wiring for backend
  mode?: Mode;

  // time tracking
  session_started_at_ms?: number;
  session_elapsed_seconds?: number;
  mode_elapsed_seconds?: Partial<Record<Mode, number>>;

  // misc
  last_client_ts_ms?: number;
};

const BRAND = "Elaralo";
const COMPANION_DISPLAY_NAME = "Elara";

// Frontend defaults (can be overridden by env)
const DEFAULT_PLAN: PlanName = "Trial";
const DEFAULT_AVATAR_SRC = "/elaralo-logo.png";

// This is the ElevenLabs voice_id you asked us to use (no name references in code).
const DEFAULT_ELEVENLABS_VOICE_ID = "rJ9XoWu8gbUhVKZnKY8X";

// If you embed this page (Wix, etc.), a postMessage payload can set these values.
// Keep the allowed origin list tight; extend if needed.
function isAllowedOrigin(origin: string) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();

    // Elaralo properties
    if (host.endsWith("elaralo.com")) return true;

    // Wix hosting / embeds
    if (host.endsWith("wix.com")) return true;
    if (host.endsWith("wixsite.com")) return true;

    // Local dev
    if (host === "localhost" || host === "127.0.0.1") return true;

    return false;
  } catch {
    return false;
  }
}

function uid(prefix = "m") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function formatHMS(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

// Plan -> allowed modes (ONLY show allowed pills; no disabled pills).
function allowedModesForPlan(plan: PlanName): Mode[] {
  const modes: Mode[] = ["friend", "video"];

  // Trial plan maps to Romantic access (no Trial mode pill).
  if (plan === "Trial" || plan === "Starter" || plan === "Plus" || plan === "Pro") {
    modes.push("romantic");
  }

  if (plan === "Starter" || plan === "Plus" || plan === "Pro") {
    modes.push("intimate");
  }

  return modes;
}

// Normalize incoming "mode" strings (from parent embed, query params, etc.).
function normalizeMode(raw: any): Mode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;

  // Important: map "trial" => "romantic" (Trial is a plan label, not a mode pill).
  if (t === "trial") return "romantic";

  if (t === "friend" || t === "friendly") return "friend";
  if (t === "romantic" || t === "romance") return "romantic";
  if (t === "intimate" || t === "explicit" || t === "adult" || t === "18+" || t === "18") return "intimate";
  if (t === "video" || t === "call" || t === "conference" || t === "stream") return "video";

  return null;
}

// Detects a mode switch request in user text and removes explicit tokens.
function detectModeSwitchAndClean(text: string): { mode: Mode | null; cleaned: string } {
  const raw = text || "";
  const t = raw.toLowerCase();

  // explicit tokens
  const tokenRe =
    /\[mode:(friend|romantic|romance|intimate|explicit|video|trial)\]|mode:(friend|romantic|romance|intimate|explicit|video|trial)/gi;

  let tokenMode: Mode | null = null;
  let cleaned = raw.replace(tokenRe, (m) => {
    const mm = m.toLowerCase();
    if (mm.includes("friend")) tokenMode = "friend";
    else if (mm.includes("romantic") || mm.includes("romance") || mm.includes("trial")) tokenMode = "romantic";
    else if (mm.includes("intimate") || mm.includes("explicit")) tokenMode = "intimate";
    else if (mm.includes("video")) tokenMode = "video";
    return "";
  });

  cleaned = cleaned.trim();
  if (tokenMode) return { mode: tokenMode, cleaned };

  // soft phrasing
  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back)\b.*\bfriend\b/.test(soft) || /\bfriend mode\b/.test(soft);

  const wantsRomantic =
    /\b(romantic|romance)\s+mode\b/.test(soft) ||
    /\b(switch|set|turn|go|back)\b.*\b(romantic|romance|trial)\b/.test(soft) ||
    /\b(let['’]?s|lets)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\b(try|trying)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\bromantic conversation\b/.test(soft);

  const wantsIntimate =
    /\b(switch|set|turn|go|back)\b.*\b(intimate|explicit|adult|18\+)\b/.test(soft) ||
    /\b(intimate|explicit)\s+mode\b/.test(soft);

  const wantsVideo =
    /\b(switch|set|turn|go|back)\b.*\b(video|call|conference)\b/.test(soft) || /\bvideo mode\b/.test(soft);

  if (wantsFriend) return { mode: "friend", cleaned: raw };
  if (wantsRomantic) return { mode: "romantic", cleaned: raw };
  if (wantsIntimate) return { mode: "intimate", cleaned: raw };
  if (wantsVideo) return { mode: "video", cleaned: raw };

  return { mode: null, cleaned: raw.trim() };
}

function modeLabel(mode: Mode): string {
  switch (mode) {
    case "friend":
      return "Friend";
    case "romantic":
      return "Romantic";
    case "intimate":
      return "Intimate";
    case "video":
      return "Video";
  }
}

function planLabel(plan: PlanName): string {
  return plan;
}

function ensureAllowedMode(requested: Mode, plan: PlanName): { ok: boolean; fallback: Mode } {
  const allowed = allowedModesForPlan(plan);
  if (allowed.includes(requested)) return { ok: true, fallback: requested };
  // fallback default if not allowed
  return { ok: false, fallback: "friend" };
}

function HoverLink(props: React.PropsWithChildren<{ href: string; target?: string; rel?: string }>) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={props.href}
      target={props.target}
      rel={props.rel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      style={{
        display: "inline-block",
        padding: "8px 10px",
        borderRadius: 10,
        border: hover ? "1px solid rgba(255,255,255,0.25)" : "1px solid rgba(255,255,255,0.12)",
        background: hover ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
        textDecoration: "none",
        fontSize: 12,
      }}
    >
      {props.children}
    </a>
  );
}

function ModePills({
  allowed,
  active,
  onPick,
}: {
  allowed: Mode[];
  active: Mode;
  onPick: (m: Mode) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {allowed.map((m) => {
        const isActive = m === active;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onPick(m)}
            style={{
              cursor: "pointer",
              borderRadius: 999,
              padding: "6px 12px",
              border: isActive ? "1px solid rgba(255,255,255,0.35)" : "1px solid rgba(255,255,255,0.14)",
              background: isActive ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
              color: "white",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {modeLabel(m)}
          </button>
        );
      })}
    </div>
  );
}

export default function CompanionPage() {
  const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").trim(); // "" means same-origin

  const [planName, setPlanName] = useState<PlanName>(DEFAULT_PLAN);
  const [memberId, setMemberId] = useState<string>("");
  const [memberEmail, setMemberEmail] = useState<string>("");
  const [companionKey, setCompanionKey] = useState<string>(COMPANION_DISPLAY_NAME);

  // active mode (default: Friend)
  const [activeMode, setActiveMode] = useState<Mode>("friend");

  const allowedModes = useMemo(() => allowedModesForPlan(planName), [planName]);

  // UI state
  const [showModePills, setShowModePills] = useState<boolean>(true);
  const [input, setInput] = useState<string>("");

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: uid("a"),
      role: "assistant",
      content: `Hi, ${COMPANION_DISPLAY_NAME} here. What would you like to talk about?`,
      ts: Date.now(),
    },
  ]);

  // TTS/STT toggles
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(true);
  const [sttEnabled, setSttEnabled] = useState<boolean>(false);
  const [handsFreeStt, setHandsFreeStt] = useState<boolean>(false);

  // recording / stt
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);

  // web speech recognition (hands-free)
  const speechRecRef = useRef<any>(null);
  const [speechStatus, setSpeechStatus] = useState<string>("off");

  // audio element for TTS
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // time tracking
  const sessionStartedAtMsRef = useRef<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // session state passed to backend
  const [sessionState, setSessionState] = useState<SessionState>(() => ({
    session_id: uid("sess"),
    plan: DEFAULT_PLAN,
    companion_key: COMPANION_DISPLAY_NAME,
    mode: "friend",
    session_started_at_ms: Date.now(),
    session_elapsed_seconds: 0,
    mode_elapsed_seconds: { friend: 0, romantic: 0, intimate: 0, video: 0 },
    last_client_ts_ms: Date.now(),
  }));

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const videoModeUrl = (process.env.NEXT_PUBLIC_VIDEO_MODE_URL || "").trim();

  // Auto tick the session timer.
  useEffect(() => {
    const t = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - sessionStartedAtMsRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Keep sessionState in sync with timer + mode.
  useEffect(() => {
    setSessionState((prev) => {
      const modeElapsed = { ...(prev.mode_elapsed_seconds || {}) };
      const currentMode = activeMode;
      modeElapsed[currentMode] = Math.max(0, (modeElapsed[currentMode] || 0) + 1);

      return {
        ...prev,
        plan: planName,
        member_id: memberId || prev.member_id,
        member_email: memberEmail || prev.member_email,
        companion_key: companionKey || prev.companion_key,
        mode: activeMode,
        session_elapsed_seconds: elapsedSeconds,
        mode_elapsed_seconds: modeElapsed,
        last_client_ts_ms: Date.now(),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedSeconds]);

  // Scroll chat to bottom when messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Ensure active mode stays allowed when plan changes.
  useEffect(() => {
    const { ok, fallback } = ensureAllowedMode(activeMode, planName);
    if (!ok) setActiveMode(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planName]);

  // Companion initialization from query params (optional) + postMessage (primary for embeds).
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Query params fallback (useful for local dev / direct navigation):
    const sp = new URLSearchParams(window.location.search);
    const qpPlan = sp.get("plan");
    const qpMode = sp.get("mode");
    const qpCompanionKey = sp.get("companion_key") || sp.get("companionKey");

    if (qpPlan) {
      const normalizedPlan = String(qpPlan).trim() as PlanName;
      if (["Free", "Trial", "Starter", "Plus", "Pro"].includes(normalizedPlan)) {
        setPlanName(normalizedPlan);
      }
    }
    if (qpMode) {
      const m = normalizeMode(qpMode);
      if (m) setActiveMode(m);
    }
    if (qpCompanionKey) {
      setCompanionKey(String(qpCompanionKey).trim());
    }

    // postMessage handler (Wix, etc.)
    const onMessage = (event: MessageEvent) => {
      if (!event?.origin || !isAllowedOrigin(event.origin)) return;

      const payload = event.data;
      if (!payload || typeof payload !== "object") return;

      // Normalize payload fields (support camelCase + snake_case)
      const incomingPlan = (payload.plan || payload.plan_name || payload.planName || DEFAULT_PLAN) as PlanName;
      const incomingMode = normalizeMode(payload.mode) || "friend";
      const incomingMemberId = String(payload.memberId || payload.member_id || "");
      const incomingEmail = String(payload.email || payload.member_email || payload.memberEmail || "");

      const resolvedCompanionKey = String(
        payload.companionKey || payload.companion_key || payload.companion || payload.avatar || COMPANION_DISPLAY_NAME
      );

      // Apply
      if (["Free", "Trial", "Starter", "Plus", "Pro"].includes(incomingPlan)) setPlanName(incomingPlan);
      if (incomingMemberId) setMemberId(incomingMemberId);
      if (incomingEmail) setMemberEmail(incomingEmail);
      if (resolvedCompanionKey) setCompanionKey(resolvedCompanionKey);

      // Important: if the incoming mode is absent, map to Friend; if it's "Trial", normalizeMode maps to Romantic.
      setActiveMode(incomingMode);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // iOS / Safari: ensure we have an <audio> element ready.
  const ensureAudioEl = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  }, []);

  // Audio unlock (helps iOS Safari).
  const unlockAudio = useCallback(async () => {
    try {
      const a = ensureAudioEl();
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" + "AAAAAAAAAAAAAAAAAAAA"; // tiny stub
      await a.play();
      a.pause();
    } catch {
      // ignore
    }
  }, [ensureAudioEl]);

  const appendMessage = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((prev) => [...prev, { id: uid(role === "user" ? "u" : "a"), role, content, ts: Date.now() }]);
  }, []);

  const setModeWithPlanGuard = useCallback(
    (requested: Mode) => {
      const { ok, fallback } = ensureAllowedMode(requested, planName);
      if (!ok) {
        appendMessage(
          "assistant",
          `Your current plan (${planLabel(planName)}) does not include ${modeLabel(requested)} mode. Switching to Friend mode.`
        );
      }
      setActiveMode(ok ? requested : fallback);
    },
    [appendMessage, planName]
  );

  // Hands-free STT using Web Speech API (optional).
  useEffect(() => {
    if (!handsFreeStt) {
      // stop if running
      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {}
      }
      setSpeechStatus("off");
      return;
    }

    if (typeof window === "undefined") return;

    const SpeechRecognition: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;

    if (!SpeechRecognition) {
      setSpeechStatus("unavailable");
      return;
    }

    const rec = new SpeechRecognition();
    speechRecRef.current = rec;

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    let interim = "";

    rec.onstart = () => setSpeechStatus("listening");
    rec.onerror = () => setSpeechStatus("error");
    rec.onend = () => {
      // try to keep alive
      if (handsFreeStt) {
        try {
          rec.start();
        } catch {}
      } else {
        setSpeechStatus("off");
      }
    };

    rec.onresult = (event: any) => {
      let finalText = "";
      interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const transcript = String(r[0]?.transcript || "");
        if (r.isFinal) finalText += transcript;
        else interim += transcript;
      }

      if (finalText.trim()) {
        setInput((prev) => (prev ? prev : "") + finalText.trim() + " ");
      }
    };

    try {
      rec.start();
    } catch {
      setSpeechStatus("error");
    }

    return () => {
      try {
        rec.stop();
      } catch {}
      speechRecRef.current = null;
    };
  }, [handsFreeStt]);

  // Backend STT via MediaRecorder -> /stt/transcribe
  const startRecording = useCallback(async () => {
    if (!sttEnabled) return;

    await unlockAudio();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      appendMessage("assistant", "Microphone capture is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeTypeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "audio/mp4",
      ];
      const chosenMime = mimeTypeCandidates.find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "";

      recordedChunksRef.current = [];
      const rec = new MediaRecorder(stream, chosenMime ? { mimeType: chosenMime } : undefined);
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        setIsRecording(false);

        // stop tracks
        for (const t of stream.getTracks()) t.stop();

        const blob = new Blob(recordedChunksRef.current, { type: chosenMime || "audio/webm" });
        recordedChunksRef.current = [];

        // send to backend
        try {
          const url = (API_BASE ? `${API_BASE}` : "") + "/stt/transcribe";
          const form = new FormData();
          form.append("audio", blob, "audio.webm");
          form.append("companion_key", companionKey);
          form.append("member_id", memberId);
          form.append("plan", planName);

          const res = await fetch(url, { method: "POST", body: form });
          if (!res.ok) {
            const t = await res.text();
            appendMessage("assistant", `STT failed (${res.status}): ${t}`);
            return;
          }
          const data = await res.json();
          const text = String(data.text || "").trim();
          if (text) setInput(text);
        } catch (e: any) {
          appendMessage("assistant", `STT error: ${String(e?.message || e)}`);
        }
      };

      rec.start(250);
      setIsRecording(true);
    } catch (e: any) {
      appendMessage("assistant", `Could not start recording: ${String(e?.message || e)}`);
    }
  }, [API_BASE, appendMessage, companionKey, memberId, planName, sttEnabled, unlockAudio]);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {}
    mediaRecorderRef.current = null;
  }, []);

  // Video-mode TTS (no ElevenLabs): browser speech synthesis
  const speakInVideoMode = useCallback(async (text: string) => {
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth) return;

    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 1.0;
      u.pitch = 1.0;
      synth.speak(u);
    } catch {
      // ignore
    }
  }, []);

  // Audio-mode TTS: ElevenLabs via backend /tts/audio-url
  const speakWithAudioTts = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      await unlockAudio();

      const url = (API_BASE ? `${API_BASE}` : "") + "/tts/audio-url";
      const payload = {
        text,
        voice_id: DEFAULT_ELEVENLABS_VOICE_ID,
        companion_key: companionKey,
        plan: planName,
        member_id: memberId,
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text();
        appendMessage("assistant", `TTS failed (${res.status}): ${t}`);
        return;
      }

      const data = await res.json();
      let audioUrl = String(data.audio_url || "").trim();
      if (!audioUrl) {
        appendMessage("assistant", "TTS failed: missing audio_url.");
        return;
      }

      // If backend returns a relative URL, prefix with API_BASE.
      if (audioUrl.startsWith("/") && API_BASE) audioUrl = `${API_BASE}${audioUrl}`;

      const a = ensureAudioEl();
      a.src = audioUrl;
      a.crossOrigin = "anonymous";
      a.currentTime = 0;
      await a.play();
    },
    [API_BASE, appendMessage, companionKey, ensureAudioEl, memberId, planName, unlockAudio]
  );

  const maybeSpeakAssistant = useCallback(
    async (text: string) => {
      if (!ttsEnabled) return;

      // No ElevenLabs in Video Mode; use browser TTS.
      if (activeMode === "video") {
        await speakInVideoMode(text);
        return;
      }

      await speakWithAudioTts(text);
    },
    [activeMode, speakInVideoMode, speakWithAudioTts, ttsEnabled]
  );

  // Chat call -> backend /chat
  const callChat = useCallback(
    async (userText: string, mode: Mode): Promise<string> => {
      const url = (API_BASE ? `${API_BASE}` : "") + "/chat";

      const body = {
        message: userText,
        mode,
        companion_key: companionKey,
        plan: planName,
        member_id: memberId,
        member_email: memberEmail,
        session_state: sessionState,
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Chat failed (${res.status}): ${t}`);
      }

      const data = await res.json();
      const reply = String(data.reply || "").trim() || "…";
      const ss = data.session_state || null;

      if (ss && typeof ss === "object") {
        setSessionState((prev) => ({ ...prev, ...ss }));
      }

      return reply;
    },
    [API_BASE, companionKey, memberEmail, memberId, planName, sessionState]
  );

  // Save chat summary (optional; no-op backend is fine)
  const saveChatSummary = useCallback(async () => {
    try {
      const url = (API_BASE ? `${API_BASE}` : "") + "/chat/save-summary";
      const payload = {
        companion_key: companionKey,
        plan: planName,
        member_id: memberId,
        session_state: sessionState,
        messages: messages.slice(-30),
      };
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch {
      // ignore
    }
  }, [API_BASE, companionKey, memberId, messages, planName, sessionState]);

  const send = useCallback(async () => {
    const raw = input.trim();
    if (!raw) return;

    // Mode switch detection embedded in user input
    const { mode: requestedMode, cleaned } = detectModeSwitchAndClean(raw);
    const usedText = cleaned || raw;

    let nextMode = activeMode;

    if (requestedMode) {
      const { ok, fallback } = ensureAllowedMode(requestedMode, planName);
      nextMode = ok ? requestedMode : fallback;
      setActiveMode(nextMode);

      if (!ok) {
        appendMessage(
          "assistant",
          `Your current plan (${planLabel(planName)}) does not include ${modeLabel(requestedMode)} mode. Staying in Friend mode.`
        );
      }
    }

    setInput("");
    appendMessage("user", usedText);

    try {
      const reply = await callChat(usedText, nextMode);
      appendMessage("assistant", reply);
      await maybeSpeakAssistant(reply);
      void saveChatSummary();
    } catch (e: any) {
      appendMessage("assistant", String(e?.message || e));
    }
  }, [activeMode, appendMessage, callChat, input, maybeSpeakAssistant, planName, saveChatSummary]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send]
  );

  const goToPricing = useCallback(() => {
    if (typeof window === "undefined") return;
    window.open("https://www.elaralo.com/pricing-plans/list", "_blank", "noreferrer");
  }, []);

  const goToMyElaralo = useCallback(() => {
    if (typeof window === "undefined") return;
    window.open("https://www.elaralo.com/myelaralo", "_blank", "noreferrer");
  }, []);

  return (
    <main style={ui.shell}>
      <div style={ui.container}>
        {/* Header */}
        <header style={ui.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img
              src={DEFAULT_AVATAR_SRC}
              alt={BRAND}
              width={44}
              height={44}
              style={{ borderRadius: 9999, display: "block" }}
            />
            <div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{BRAND}</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Companion: {COMPANION_DISPLAY_NAME}</div>
            </div>
          </div>

          <div style={ui.headerRight}>
            <div style={ui.planPill}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Plan</div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>{planLabel(planName)}</div>
            </div>

            <div style={ui.planPill}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Time</div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>{formatHMS(elapsedSeconds)}</div>
            </div>

            <button type="button" onClick={goToMyElaralo} style={ui.smallButton}>
              My Elaralo
            </button>

            <button type="button" onClick={goToPricing} style={ui.smallButton}>
              Upgrade
            </button>
          </div>
        </header>

        {/* Main layout */}
        <div style={ui.mainGrid}>
          {/* Left: Avatar / Video + Mode */}
          <section style={ui.leftCol}>
            <div style={ui.card}>
              <div style={ui.cardTitleRow}>
                <div style={ui.cardTitle}>Mode</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Active: <b>{modeLabel(activeMode)}</b>
                </div>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowModePills((v) => !v)}
                  style={ui.primaryButton}
                >
                  Set Mode
                </button>

                {/* Per your request: pills remain un-condensed; only allowed pills are shown; no disabled pills. */}
                {showModePills && (
                  <ModePills
                    allowed={allowedModes}
                    active={activeMode}
                    onPick={(m) => setModeWithPlanGuard(m)}
                  />
                )}
              </div>
            </div>

            <div style={ui.card}>
              <div style={ui.cardTitleRow}>
                <div style={ui.cardTitle}>Video</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {activeMode === "video" ? "Video Mode is ON" : "Switch to Video mode to open the conference/stream."}
                </div>
              </div>

              {activeMode !== "video" ? (
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  Video Mode is a hosted video conference or streaming video experience. It does not use avatar synthesis
                  vendors. STT and TTS remain available in all modes.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {videoModeUrl ? (
                    <iframe
                      title="Video Mode"
                      src={videoModeUrl}
                      style={{
                        width: "100%",
                        height: 360,
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 12,
                        background: "#000",
                      }}
                      allow="camera; microphone; fullscreen; display-capture"
                    />
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      Set <code>NEXT_PUBLIC_VIDEO_MODE_URL</code> to embed your video conference or streaming URL.
                    </div>
                  )}

                  {videoModeUrl && (
                    <HoverLink href={videoModeUrl} target="_blank" rel="noreferrer">
                      Open video in new tab
                    </HoverLink>
                  )}
                </div>
              )}
            </div>

            <div style={ui.card}>
              <div style={ui.cardTitleRow}>
                <div style={ui.cardTitle}>Quick Links</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Link href="/" style={ui.linkLike}>
                  Home
                </Link>
                <HoverLink href="/docs">Docs</HoverLink>
                <HoverLink href="/site">Site</HoverLink>
                <HoverLink href={(API_BASE ? `${API_BASE}` : "") + "/health"} target="_blank" rel="noreferrer">
                  API Health
                </HoverLink>
              </div>
            </div>
          </section>

          {/* Right: Chat + Controls */}
          <section style={ui.rightCol}>
            <div style={{ ...ui.card, height: "100%", display: "flex", flexDirection: "column" }}>
              <div style={ui.cardTitleRow}>
                <div style={ui.cardTitle}>Chat</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <label style={ui.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={ttsEnabled}
                      onChange={(e) => setTtsEnabled(e.target.checked)}
                    />
                    <span style={{ marginLeft: 6 }}>TTS</span>
                  </label>

                  <label style={ui.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={sttEnabled}
                      onChange={(e) => setSttEnabled(e.target.checked)}
                    />
                    <span style={{ marginLeft: 6 }}>Mic STT</span>
                  </label>

                  <label style={ui.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={handsFreeStt}
                      onChange={(e) => setHandsFreeStt(e.target.checked)}
                    />
                    <span style={{ marginLeft: 6 }}>Hands-free</span>
                  </label>
                </div>
              </div>

              {handsFreeStt && (
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                  Hands-free STT status: <b>{speechStatus}</b>
                </div>
              )}

              <div ref={scrollRef} style={ui.chatScroll}>
                {messages.map((m) => (
                  <div key={m.id} style={m.role === "user" ? ui.userMsg : ui.assistantMsg}>
                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
                      {m.role === "user" ? "You" : COMPANION_DISPLAY_NAME} •{" "}
                      {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{m.content}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                  style={ui.textarea}
                  rows={3}
                />

                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button type="button" onClick={() => void send()} style={ui.primaryButton}>
                    Send
                  </button>

                  <button
                    type="button"
                    onClick={() => void unlockAudio()}
                    style={ui.secondaryButton}
                    title="If iOS Safari blocks audio until user interaction, click once."
                  >
                    Unlock Audio
                  </button>

                  <button
                    type="button"
                    disabled={!sttEnabled}
                    onClick={() => {
                      if (!sttEnabled) return;
                      if (!isRecording) void startRecording();
                      else stopRecording();
                    }}
                    style={{
                      ...ui.secondaryButton,
                      opacity: sttEnabled ? 1 : 0.5,
                    }}
                    title={!sttEnabled ? "Enable Mic STT first" : isRecording ? "Stop recording" : "Start recording"}
                  >
                    {isRecording ? "Stop Mic" : "Start Mic"}
                  </button>
                </div>

                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", opacity: 0.85, fontSize: 12 }}>Debug</summary>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8, lineHeight: 1.35 }}>
                    <div>
                      <b>API_BASE</b>: {API_BASE || "(same-origin)"}
                    </div>
                    <div>
                      <b>member_id</b>: {memberId || "(not set)"}
                    </div>
                    <div>
                      <b>member_email</b>: {memberEmail || "(not set)"}
                    </div>
                    <div>
                      <b>companion_key</b>: {companionKey || "(not set)"}
                    </div>
                    <div>
                      <b>allowed_modes</b>: {allowedModes.join(", ")}
                    </div>
                    <div>
                      <b>session_id</b>: {sessionState.session_id}
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </section>
        </div>

        <footer style={ui.footer}>
          <div style={{ opacity: 0.7 }}>
            Tip: If you’re embedding this page in another site, send a <code>postMessage</code> payload containing
            <code> plan</code>, <code>member_id</code>, and <code>companion_key</code>.
          </div>
        </footer>
      </div>
    </main>
  );
}

const ui: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 600px at 20% 0%, rgba(255,255,255,0.08), transparent 60%), #0b0b0b",
    padding: 18,
  },
  container: { maxWidth: 1200, margin: "0 auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },
  planPill: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    minWidth: 86,
    textAlign: "center",
  },
  smallButton: {
    cursor: "pointer",
    borderRadius: 10,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    fontWeight: 700,
    fontSize: 12,
  },
  mainGrid: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 14,
  },
  leftCol: { display: "grid", gap: 14 },
  rightCol: { minHeight: 680 },
  card: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    background: "rgba(255,255,255,0.04)",
    padding: 14,
  },
  cardTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 },
  cardTitle: { fontWeight: 800, fontSize: 13, letterSpacing: 0.3 },
  primaryButton: {
    cursor: "pointer",
    borderRadius: 12,
    padding: "12px 14px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.10)",
    color: "#fff",
    fontWeight: 800,
    fontSize: 13,
    textAlign: "center",
  },
  secondaryButton: {
    cursor: "pointer",
    borderRadius: 12,
    padding: "12px 14px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    fontWeight: 700,
    fontSize: 13,
  },
  toggleLabel: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 12,
    opacity: 0.9,
    userSelect: "none",
    gap: 6,
  },
  chatScroll: {
    flex: 1,
    overflowY: "auto",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 12,
    padding: 12,
    background: "rgba(0,0,0,0.25)",
    minHeight: 380,
  },
  userMsg: {
    marginBottom: 10,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
  },
  assistantMsg: {
    marginBottom: 10,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.03)",
  },
  textarea: {
    width: "100%",
    resize: "vertical",
    borderRadius: 12,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.25)",
    color: "#fff",
    outline: "none",
    fontSize: 13,
    lineHeight: 1.35,
  },
  linkLike: {
    display: "inline-block",
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    textDecoration: "none",
    fontSize: 12,
  },
  footer: { marginTop: 12, padding: 6, fontSize: 12 },
};
