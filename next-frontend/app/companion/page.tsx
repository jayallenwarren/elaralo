"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

type ChatRole = "user" | "assistant";
type RelationshipMode = "Friend" | "Romantic" | "Intimate";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type CompanionResolved = {
  companion_key: string | null;
  name: string;
  avatar_url: string;
  plan: string;
  mode: RelationshipMode;
  allowed_modes: RelationshipMode[];
  eleven_voice_id: string;
  user_name?: string;
  member_id?: string;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, "") || "http://localhost:8000";

const SWITCH_COMPANION_URL = process.env.NEXT_PUBLIC_SWITCH_COMPANION_URL || "/";

const UPGRADE_URL = process.env.NEXT_PUBLIC_UPGRADE_URL || "/pricing";

const VIDEO_EMBED_URL = process.env.NEXT_PUBLIC_VIDEO_EMBED_URL || "";

const DEFAULT_COMPANION_NAME =
  process.env.NEXT_PUBLIC_DEFAULT_COMPANION_NAME || "Elara";
const DEFAULT_AVATAR_URL =
  process.env.NEXT_PUBLIC_DEFAULT_AVATAR_URL || "/elaralo_logo.png";
const DEFAULT_PLAN = process.env.NEXT_PUBLIC_DEFAULT_PLAN || "Trial";
const DEFAULT_ELEVEN_VOICE_ID =
  process.env.NEXT_PUBLIC_DEFAULT_ELEVEN_VOICE_ID || "rJ9XoWu8gbUhVKZnKY8X";

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function base64UrlToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeCompanionKey(companionKey: string): any | null {
  const key = companionKey.trim();
  if (!key) return null;

  // JWT (header.payload.signature) style
  const parts = key.split(".");
  if (parts.length >= 2) {
    const payload = parts[1];
    const json = safeJsonParse(base64UrlToUtf8(payload));
    if (json) return json;
  }

  // base64 JSON
  try {
    const jsonStr = base64UrlToUtf8(key);
    const json = safeJsonParse(jsonStr);
    if (json) return json;
  } catch {
    // ignore
  }

  return null;
}

function normalizeMode(raw: any): RelationshipMode | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "friend") return "Friend";
  if (s === "romantic" || s === "romance") return "Romantic";
  if (s === "intimate" || s === "explicit") return "Intimate";
  return null;
}

function deriveAllowedModes(plan: string, rawAllowed?: any): RelationshipMode[] {
  if (Array.isArray(rawAllowed)) {
    const mapped = rawAllowed
      .map((m) => normalizeMode(m))
      .filter(Boolean) as RelationshipMode[];
    const unique = Array.from(new Set(mapped));
    if (unique.length) return unique;
  }

  const p = String(plan || "").toLowerCase();
  if (p.includes("intimate")) return ["Friend", "Romantic", "Intimate"];
  if (p.includes("romantic")) return ["Friend", "Romantic"];

  // Trial/test maps to Romantic entitlements (Friend + Romantic)
  if (p.includes("trial") || p.includes("test")) return ["Friend", "Romantic"];

  if (p.includes("friend")) return ["Friend"];

  // default (safe): Friend only
  return ["Friend"];
}

function resolveCompanion(companionKey: string | null): CompanionResolved {
  const decoded = companionKey ? decodeCompanionKey(companionKey) : null;

  const name =
    decoded?.companion_name ||
    decoded?.companionName ||
    decoded?.name ||
    DEFAULT_COMPANION_NAME;

  const avatar_url =
    decoded?.avatar_url ||
    decoded?.avatarUrl ||
    decoded?.avatar ||
    DEFAULT_AVATAR_URL;

  const plan = decoded?.plan || decoded?.plan_name || decoded?.planName || DEFAULT_PLAN;

  const allowed_modes = deriveAllowedModes(plan, decoded?.allowed_modes || decoded?.modes);

  let mode = normalizeMode(decoded?.mode) || "Friend";
  if (!allowed_modes.includes(mode)) mode = (allowed_modes[0] || "Friend") as RelationshipMode;

  const eleven_voice_id =
    decoded?.eleven_voice_id ||
    decoded?.elevenVoiceId ||
    decoded?.voice_id ||
    decoded?.voiceId ||
    DEFAULT_ELEVEN_VOICE_ID;

  const user_name =
    decoded?.user_name ||
    decoded?.userName ||
    decoded?.member_name ||
    decoded?.memberName ||
    decoded?.display_name ||
    decoded?.displayName ||
    undefined;

  const member_id = decoded?.member_id || decoded?.memberId || decoded?.user_id || decoded?.userId;

  return {
    companion_key: companionKey,
    name,
    avatar_url,
    plan,
    allowed_modes,
    mode,
    eleven_voice_id,
    user_name,
    member_id,
  };
}

function isSpeechRecognitionAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function downloadText(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function svgIcon(kind: "play" | "mic" | "stop" | "save" | "trash") {
  // Inline SVGs keep dependencies minimal.
  if (kind === "play") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "mic") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (kind === "stop") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6h12v12H6z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "save") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM6 8V5h9v3H6z"
          fill="currentColor"
        />
      </svg>
    );
  }
  // trash
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function CompanionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const companionKey = searchParams.get("companion_key");
  const companion = useMemo(() => resolveCompanion(companionKey), [companionKey]);

  const [relationshipMode, setRelationshipMode] = useState<RelationshipMode>(companion.mode);
  const [showModePicker, setShowModePicker] = useState<boolean>(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");

  const [isSending, setIsSending] = useState<boolean>(false);

  const [isVideoMode, setIsVideoMode] = useState<boolean>(false);

  const [isMicOn, setIsMicOn] = useState<boolean>(false);
  const micDesiredRef = useRef<boolean>(false);
  const sttHoldRef = useRef<boolean>(false);
  const ignoreNextRecordingStopRef = useRef<boolean>(false);

  const recognitionRef = useRef<any | null>(null);
  const [sttStatus, setSttStatus] = useState<"idle" | "listening" | "error">("idle");

  const sttFinalRef = useRef<string>("");
  const sttInterimRef = useRef<string>("");
  const sttSendTimerRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const fallbackRecordingRef = useRef<boolean>(false);

  const [isTtsPlaying, setIsTtsPlaying] = useState<boolean>(false);
  const ttsVideoRef = useRef<HTMLVideoElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  const audioUnlockedRef = useRef<boolean>(false);
  const volumeRef = useRef<number>(1.0);

  const [confirmClearOpen, setConfirmClearOpen] = useState<boolean>(false);
  const [confirmSaveOpen, setConfirmSaveOpen] = useState<boolean>(false);

  const chatBoxRef = useRef<HTMLDivElement | null>(null);

  const liveStatusText = useMemo(() => {
    return isVideoMode ? "Live Avatar: live" : "Live Avatar: idle";
  }, [isVideoMode]);

  // Greeting (first-load)
  useEffect(() => {
    setMessages([
      { role: "assistant", content: `Hi, ${companion.name} here. What's on your mind?` },
      { role: "assistant", content: `Mode set to: ${relationshipMode}` },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep relationshipMode in sync if companion changes
  useEffect(() => {
    setRelationshipMode(companion.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.mode, companion.name]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    const el = chatBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function ensureAudioUnlocked() {
    if (audioUnlockedRef.current) return;
    audioUnlockedRef.current = true;

    // 1) Resume an AudioContext (iOS/Safari unlock)
    try {
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        await ctx.resume();
        // short silent osc
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.01);
      }
    } catch {
      // ignore
    }

    // 2) Prime the hidden video element once
    const el = ttsVideoRef.current;
    if (!el) return;
    try {
      el.muted = true;
      el.volume = 0;
      // Tiny silent WAV (base64) to satisfy play() on iOS
      el.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
      await el.play();
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    } finally {
      try {
        el.muted = false;
        el.volume = volumeRef.current;
      } catch {
        // ignore
      }
    }
  }

  function stopAllAudio() {
    // stop ElevenLabs playback (hidden video)
    const el = ttsVideoRef.current;
    try {
      if (el) {
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
        el.load();
      }
    } catch {
      // ignore
    }

    // stop speech synthesis (video mode TTS)
    try {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // ignore
    }

    // abort any in-flight TTS request
    try {
      ttsAbortRef.current?.abort();
    } catch {
      // ignore
    } finally {
      ttsAbortRef.current = null;
    }

    setIsTtsPlaying(false);
  }

  function pauseSpeechToText() {
    // Temporarily pause (used while sending / speaking).
    sttHoldRef.current = true;

    // Stop SpeechRecognition (if active).
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }

    // Stop backend recording (if active), but do NOT transcribe on this stop.
    if (fallbackRecordingRef.current) {
      ignoreNextRecordingStopRef.current = true;
      stopFallbackRecording();
    }

    setSttStatus("idle");
  }

  async function resumeSpeechToTextIfDesired() {
    if (!micDesiredRef.current) return;
    sttHoldRef.current = false;
    if (isSpeechRecognitionAvailable()) {
      startSpeechRecognition();
    } else {
      await startFallbackRecording();
    }
  }

  function clearSttTimers() {
    if (sttSendTimerRef.current) {
      window.clearTimeout(sttSendTimerRef.current);
      sttSendTimerRef.current = null;
    }
  }

  function scheduleAutoSendFromStt() {
    clearSttTimers();
    sttSendTimerRef.current = window.setTimeout(async () => {
      const finalText = (sttFinalRef.current || "").trim();
      const interimText = (sttInterimRef.current || "").trim();
      if (!finalText || interimText) return;

      sttFinalRef.current = "";
      setInput("");
      await sendMessage(finalText, { spoken: true });
    }, 650);
  }

  function startSpeechRecognition() {
    if (typeof window === "undefined") return;
    if (!isSpeechRecognitionAvailable()) return;

    // tear down any existing instance
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }

    const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new RecognitionCtor();

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      setSttStatus("listening");
    };

    rec.onresult = (event: any) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0]?.transcript ?? "";
        if (res.isFinal) final += transcript;
        else interim += transcript;
      }

      if (final) {
        sttFinalRef.current = (sttFinalRef.current + " " + final).trim();
      }
      sttInterimRef.current = interim.trim();

      const composed = [sttFinalRef.current, sttInterimRef.current].filter(Boolean).join(" ");
      setInput(composed);

      // if we got a final result and no interim, likely user paused
      if (final && !sttInterimRef.current) {
        scheduleAutoSendFromStt();
      }
    };

    rec.onerror = (_e: any) => {
      setSttStatus("error");
      // attempt restart if mic is still desired
      if (micDesiredRef.current && !sttHoldRef.current) {
        window.setTimeout(() => {
          try {
            rec.stop();
          } catch {
            // ignore
          }
          startSpeechRecognition();
        }, 900);
      }
    };

    rec.onend = () => {
      if (micDesiredRef.current && !sttHoldRef.current) {
        // restart
        window.setTimeout(() => startSpeechRecognition(), 200);
      } else {
        setSttStatus("idle");
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      setSttStatus("error");
    }
  }

  async function startFallbackRecording() {
    fallbackRecordingRef.current = true;
    setSttStatus("listening");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
          recordedChunksRef.current = [];

          // If we intentionally stopped recording (e.g., to avoid capturing TTS),
          // skip transcription for this cycle.
          if (!ignoreNextRecordingStopRef.current) {
            await transcribeAndSend(blob);
          }
        } finally {
          ignoreNextRecordingStopRef.current = false;
          // cleanup stream
          try {
            mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          fallbackRecordingRef.current = false;

          if (micDesiredRef.current && !sttHoldRef.current) {
            // immediately record again for continuous conversation
            await startFallbackRecording();
          } else {
            setSttStatus("idle");
          }
        }
      };

      recorder.start();
    } catch {
      setSttStatus("error");
      fallbackRecordingRef.current = false;
    }
  }

  function stopFallbackRecording() {
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      // ignore
    }
  }

  async function transcribeAndSend(blob: Blob) {
    // Send audio blob to backend STT, then auto-send the transcript.
    const form = new FormData();
    form.append("file", blob, "speech.webm");
    if (companion.companion_key) form.append("companion_key", companion.companion_key);

    try {
      const res = await fetch(`${API_BASE}/stt/transcribe`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("stt_failed");
      const data = await res.json();
      const text = String(data?.text || "").trim();
      if (!text) return;

      setInput("");
      await sendMessage(text, { spoken: true });
    } catch {
      // Swallow; user can retry
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Microphone recognition error." },
      ]);
    }
  }

  async function toggleMic() {
    await ensureAudioUnlocked();

    const next = !micDesiredRef.current;
    micDesiredRef.current = next;
    setIsMicOn(next);

    if (next) sttHoldRef.current = false;

    if (!next) {
      // turning off
      pauseSpeechToText();
      clearSttTimers();
      sttFinalRef.current = "";
      sttInterimRef.current = "";
      setInput("");
      return;
    }

    // turning on
    if (isSpeechRecognitionAvailable()) {
      startSpeechRecognition();
    } else {
      await startFallbackRecording();
    }
  }

  async function speakViaElevenLabs(text: string) {
    await ensureAudioUnlocked();

    stopAllAudio();
    setIsTtsPlaying(true);

    const abort = new AbortController();
    ttsAbortRef.current = abort;

    const payload = {
      text,
      voice_id: companion.eleven_voice_id,
      session_state: {
        companion_key: companion.companion_key,
        companion: {
          name: companion.name,
            user_name: companion.user_name,
          plan: companion.plan,
          mode: relationshipMode,
          avatar_url: companion.avatar_url,
          eleven_voice_id: companion.eleven_voice_id,
          member_id: companion.member_id,
        },
      },
    };

    try {
      const res = await fetch(`${API_BASE}/tts/audio-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error("tts_failed");
      const data = await res.json();
      const audioUrl = String(data?.audio_url || "").trim();
      if (!audioUrl) throw new Error("tts_no_url");

      const src = audioUrl.startsWith("http") ? audioUrl : `${API_BASE}${audioUrl}`;
      const el = ttsVideoRef.current;
      if (!el) throw new Error("tts_no_element");

      el.volume = volumeRef.current;
      el.src = src;

      await el.play();

      await new Promise<void>((resolve) => {
        const done = () => resolve();
        el.onended = done;
        el.onerror = done;
      });
    } finally {
      setIsTtsPlaying(false);
      ttsAbortRef.current = null;
    }
  }

  async function speakViaSpeechSynthesis(text: string) {
    await ensureAudioUnlocked();

    stopAllAudio();
    setIsTtsPlaying(true);

    try {
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined" || !window.speechSynthesis) {
          resolve();
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      });
    } finally {
      setIsTtsPlaying(false);
    }
  }

  async function speakAssistant(text: string) {
    // In Video mode, do not use ElevenLabs. Use browser speechSynthesis.
    if (isVideoMode) {
      await speakViaSpeechSynthesis(text);
      return;
    }

    // In standard (chat) mode, only speak automatically when mic is active.
    if (!micDesiredRef.current) return;

    await speakViaElevenLabs(text);
  }

  async function sendMessage(text: string, opts?: { spoken?: boolean }) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isSending) return;

    // If user is speaking, pause STT while we send + while we speak the reply.
    const shouldResumeStt = micDesiredRef.current;
    if (shouldResumeStt) pauseSpeechToText();

    setIsSending(true);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);

    try {
      const payload = {
        messages: [
          ...messages,
          { role: "user", content: trimmed },
        ],
        session_state: {
          companion_key: companion.companion_key,
          companion: {
            name: companion.name,
            plan: companion.plan,
            mode: relationshipMode,
            avatar_url: companion.avatar_url,
            eleven_voice_id: companion.eleven_voice_id,
            member_id: companion.member_id,
          },
          plan: companion.plan,
          mode: relationshipMode,
          client: {
            spoken: Boolean(opts?.spoken),
            user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          },
        },
      };

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("chat_failed");

      const data = await res.json();
      const reply = String(data?.reply || "").trim() || "…";

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);

      // Speak after we paint the message, and then resume STT if needed.
      await speakAssistant(reply);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry — something went wrong.",
        },
      ]);
    } finally {
      setIsSending(false);
      if (shouldResumeStt) {
        await resumeSpeechToTextIfDesired();
      }
    }
  }

  function handleRelationshipModeClick(mode: RelationshipMode) {
    setRelationshipMode(mode);
    setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${mode}` }]);
    setShowModePicker(false);
  }

  function handleToggleVideo() {
    // Video conference / streaming mode.
    setIsVideoMode((v) => !v);

    // NOTE: D-ID avatar integration is intentionally kept out of this implementation.
    // If/when you re-enable it, the play button can start/stop the live avatar here.
  }

  function handleStop() {
    // Stop TTS + STT + video
    micDesiredRef.current = false;
    setIsMicOn(false);

    pauseSpeechToText();
    clearSttTimers();
    sttFinalRef.current = "";
    sttInterimRef.current = "";
    setInput("");

    stopAllAudio();
    setIsVideoMode(false);
  }

  function handleNewSessionClear() {
    setConfirmClearOpen(false);
    handleStop();
    setMessages([
      { role: "assistant", content: `Hi, ${companion.name} here. What's on your mind?` },
      { role: "assistant", content: `Mode set to: ${relationshipMode}` },
    ]);
  }

  async function handleSaveMessages() {
    setConfirmSaveOpen(false);

    const payload = {
      messages,
      session_state: {
        companion_key: companion.companion_key,
        companion: {
          name: companion.name,
          plan: companion.plan,
          mode: relationshipMode,
          avatar_url: companion.avatar_url,
          member_id: companion.member_id,
        },
      },
    };

    try {
      const res = await fetch(`${API_BASE}/chat/save-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("save_failed");

      const data = await res.json();
      const summary = String(data?.summary || "").trim();

      // Download a local copy for convenience.
      const filename = `elaralo_session_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
      downloadText(filename, summary || "(no summary returned)");

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Session saved." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Unable to save this session right now." },
      ]);
    }
  }

  const showUpgrade = useMemo(() => {
    const all: RelationshipMode[] = ["Friend", "Romantic", "Intimate"];
    const allowed = new Set(companion.allowed_modes);
    return all.some((m) => !allowed.has(m));
  }, [companion.allowed_modes]);

  const canUseMode = (m: RelationshipMode) => companion.allowed_modes.includes(m);

  return (
    <div className="page">
      <div className="card" style={{ padding: 18 }}>
        <div className="headerRow">
          <img className="avatar" src={companion.avatar_url} alt={companion.name} />
          <div className="headerText">
            <h1 className="h1">Elaralo</h1>
            <div className="subline">
              Companion: <strong>{companion.name}</strong> · Plan: <strong>{companion.plan}</strong>
            </div>
            <div className="subline">
              Mode: <strong>{relationshipMode}</strong>
            </div>
          </div>
        </div>

        <div className="controlsRow">
          <div className="leftControls">
            <button
              className={`iconBtn ${isVideoMode ? "iconBtnActive" : ""}`}
              onClick={handleToggleVideo}
              aria-label="Video"
              title="Video"
            >
              {svgIcon("play")}
            </button>

            <button
              className={`iconBtn ${isMicOn ? "iconBtnActive" : ""}`}
              onClick={toggleMic}
              aria-label="Microphone"
              title="Microphone"
            >
              {svgIcon("mic")}
            </button>

            <button className="iconBtn" onClick={handleStop} aria-label="Stop" title="Stop">
              {svgIcon("stop")}
            </button>

            <div className="liveStatus">
              <span>Live Avatar: </span>
              <strong>{isVideoMode ? "live" : "idle"}</strong>
              {sttStatus === "listening" ? (
                <span style={{ marginLeft: 10 }}>· Listening</span>
              ) : null}
              {isTtsPlaying ? <span style={{ marginLeft: 10 }}>· Speaking</span> : null}
            </div>
          </div>

          <div className="rightControls">
            <div className="rightButtons">
              <button className="btn" onClick={() => setShowModePicker((v) => !v)}>
                Set Mode
              </button>
              <button className="btn" onClick={() => router.push(SWITCH_COMPANION_URL)}>
                Switch Companion
              </button>
            </div>

            {showModePicker ? (
              <div className="pillRow">
                {canUseMode("Friend") ? (
                  <button
                    className={`pill ${relationshipMode === "Friend" ? "pillActive" : ""}`}
                    onClick={() => handleRelationshipModeClick("Friend")}
                  >
                    Friend
                  </button>
                ) : null}

                {canUseMode("Romantic") ? (
                  <button
                    className={`pill ${relationshipMode === "Romantic" ? "pillActive" : ""}`}
                    onClick={() => handleRelationshipModeClick("Romantic")}
                  >
                    Romantic
                  </button>
                ) : null}

                {canUseMode("Intimate") ? (
                  <button
                    className={`pill ${relationshipMode === "Intimate" ? "pillActive" : ""}`}
                    onClick={() => handleRelationshipModeClick("Intimate")}
                  >
                    Intimate
                  </button>
                ) : null}

                {showUpgrade ? (
                  <a className="pill pillLink" href={UPGRADE_URL}>
                    Upgrade
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Video panel (only when play is active) */}
        {isVideoMode ? (
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ padding: 12 }}>
              {VIDEO_EMBED_URL ? (
                <iframe
                  src={VIDEO_EMBED_URL}
                  title="Video session"
                  style={{ width: "100%", height: 320, border: "0", borderRadius: 12 }}
                  allow="camera; microphone; autoplay; encrypted-media; picture-in-picture"
                />
              ) : (
                <div className="mutedNote">
                  Video mode is enabled. Set <code>NEXT_PUBLIC_VIDEO_EMBED_URL</code> to embed a
                  conferencing or streaming URL.
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="chatBox" ref={chatBoxRef}>
          {messages.map((m, idx) => (
            <p className="msg" key={idx}>
              <span className="speaker">{m.role === "user" ? (companion.user_name || "You") : companion.name}:</span>
              {m.content}
            </p>
          ))}
        </div>

        <div className="composeRow">
          <button
            className="iconBtn"
            onClick={() => setConfirmSaveOpen(true)}
            aria-label="Save session"
            title="Save session"
          >
            {svgIcon("save")}
          </button>

          <button
            className="iconBtn"
            onClick={() => setConfirmClearOpen(true)}
            aria-label="New session"
            title="New session"
          >
            {svgIcon("trash")}
          </button>

          <input
            className="textInput"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage(input);
                setInput("");
              }
            }}
          />

          <button
            className="sendBtn"
            disabled={isSending || !input.trim()}
            onClick={() => {
              void sendMessage(input);
              setInput("");
            }}
          >
            Send
          </button>
        </div>

        {/* Hidden video element used for stable cross-device audio playback */}
        <video
          ref={ttsVideoRef}
          style={{ display: "none" }}
          playsInline
          // Do not set muted=true; we manage it during unlock only.
        />

        {/* Confirm Clear / New Session */}
        {confirmClearOpen ? (
          <div className="modalOverlay" role="dialog" aria-modal="true">
            <div className="modal">
              <div className="modalTitle">Start a new session?</div>
              <p className="modalBody">
                This will clear the current conversation from the screen.
              </p>
              <div className="modalActions">
                <button className="btn" onClick={() => setConfirmClearOpen(false)}>
                  Cancel
                </button>
                <button className="btn" onClick={handleNewSessionClear}>
                  New Session
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Confirm Save */}
        {confirmSaveOpen ? (
          <div className="modalOverlay" role="dialog" aria-modal="true">
            <div className="modal">
              <div className="modalTitle">Save this session?</div>
              <p className="modalBody">
                This will generate a summary and download it as a text file.
              </p>
              <div className="modalActions">
                <button className="btn" onClick={() => setConfirmSaveOpen(false)}>
                  Cancel
                </button>
                <button className="btn" onClick={() => void handleSaveMessages()}>
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------------------------------
   D-ID Live Avatar integration (commented out)

   This project intentionally ships with video-conferencing/streaming enabled and avatar synthesis
   vendors disabled. The block below is preserved as a starting point if you later choose to add a
   live avatar provider again.

   Notes:
   - Do not uncomment until you have installed the required SDK package(s) and added your credentials.
   - Keep this code path behind a feature flag so the standard experience remains provider-agnostic.

   Example skeleton (not active):

   async function startLiveAvatarWithDid() {
     // 1) Fetch a session token from your backend (recommended) OR directly from your provider if safe.
     // const tokenRes = await fetch(`${API_BASE}/avatar/token`, { method: "POST" });
     // const { token } = await tokenRes.json();

     // 2) Initialize SDK (requires: npm i @d-id/client-sdk)
     // const { createClient } = await import("@d-id/client-sdk");
     // const client = createClient({ token });

     // 3) Connect to agent / stream, and attach MediaStream to a video element
     // const agentId = "...";
     // const room = await client.rooms.join({ agentId });
     // const stream = room.getStream();
     // videoEl.srcObject = stream;
     // await videoEl.play();

     // 4) When you need to speak:
     // await client.speak({ text, voice: { provider: "elevenlabs", voice_id: companion.eleven_voice_id }});
   }

   async function stopLiveAvatarWithDid() {
     // room?.leave();
     // videoEl.srcObject = null;
   }

-------------------------------------------------------------------------------------------------- */
