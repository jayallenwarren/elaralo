"use client";
// v10.0.0-alpha15.14: mobile companion-card layout only; protected STT/TTS/media behavior unchanged.
// v9.1.17: Preserve v9.1.16 auto-mode behavior and add DulceMoon/white-label
// hyphenated companion-key -> SQL avatar aliasing for mapping lookup.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
// v9.1.38: immediate DulceMoon Host Console plan handling + public Intro/Mate/Mature label sanitation for Host Console.
import { LiveKitRoom, VideoConference, GridLayout, ParticipantTile, useTracks, RoomAudioRenderer, StartAudio, useRoomContext } from "@livekit/components-react";
import { Track, RoomEvent } from "livekit-client";
import "@livekit/components-styles";
import Hls from "hls.js";
import elaraLogo from "../public/elaralo-logo.png";
// v9.1.13: preserve selected companion mapping identity separately from the
// logged-in host/member identity. Direct My Elaralo launches pass companionType
// so AI selections cannot resolve to the host's Human row.
const PlayIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    <path d="M8 5v14l11-7z" fill="currentColor" />
  </svg>
);

const PauseIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
  </svg>
);


const StopIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6h12v12H6z" fill="currentColor" />
  </svg>
);

const MicOnIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    <path
      d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
      fill="currentColor"
    />
  </svg>
);

const MicOffIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    {/* Muted mic: lighter mic + slash */}
    <path
      d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
      fill="currentColor"
      opacity="0.35"
    />
    <path
      d="M4 4l16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
  </svg>
);
const TrashIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    <path
      d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM6 9h2v10H6V9z"
      fill="currentColor"
    />
  </svg>
);


function LiveKitHlsPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Native HLS (Safari) fallback
    const canNative = v.canPlayType("application/vnd.apple.mpegurl");
    if (canNative) {
      v.src = src;
      v.play().catch(() => {});
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hls.loadSource(src);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        v.play().catch(() => {});
      });
      return () => {
        try { hls.destroy(); } catch {}
      };
    } else {
      v.src = src;
      v.play().catch(() => {});
    }
  }, [src]);

  return (
    <video
      ref={videoRef}
      style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      controls
      playsInline
      autoPlay
      muted={false}
    />
  );
}

type Role = "user" | "assistant";
// `meta` is used for UI-only bookkeeping (e.g., in-stream live chat sender ids).
// It is never serialized to the backend /chat API.
type Msg = { role: Role; content: string; meta?: any };

type UploadedAttachment = {
  url: string;
  name: string;
  size: number;
  contentType: string;
  container?: string;
  blobName?: string;
};

type Mode = "friend" | "romantic" | "intimate";

type LiveProvider = "d-id" | "stream" | "";

type SessionKind = "stream" | "private" | "conference" | "";

// LiveKit is the sole live-session provider.
type ChannelCap = "audio" | "video" | "";

type CompanionMappingRow = {
  found?: boolean;
  brand?: string;
  avatar?: string;

  // DB columns
  channel_cap?: string; // "Video" | "Audio"
  channelCap?: string;  // API alias (optional)
  live?: string;        // "Stream" | "D-ID" | ""

  // Provider-specific fields (optional)
  didClientKey?: string;
  didAgentId?: string;
  elevenVoiceId?: string;
  elevenVoiceName?: string;

  // Optional DB column used by backend TTS normalization.
  // Pronunciation guidance only; never display this value as the companion name.
  phonetic?: string | null;
  mapping_phonetic?: string | null;
  mappingPhonetic?: string | null;
  companion_phonetic?: string | null;
  companionPhonetic?: string | null;

  // Optional DB column used for UI labeling.
  // Expected values: "Human" | "AI" (case-insensitive), but treated as a free-form string.
  companion_type?: string | null;
  companionType?: string | null; // optional API alias

  // Exported onboarding assets preferred by Connect when present.
  headshot_url?: string | null;
  headshotUrl?: string | null;
};

type ChatStatus = "safe" | "explicit_blocked" | "explicit_allowed";

// PayGo top-up UI state (used to correlate non-member payments via email)
type TopupStage = "idle" | "collect_email" | "creating" | "checkout" | "waiting" | "credited" | "error";


type SessionState = {
  mode: Mode;
  adult_verified: boolean;
  romance_consented: boolean;
  explicit_consented: boolean;
  pending_consent: "intimate" | null;
  model: string;
  // optional extras tolerated
  [k: string]: any;
};

type ContentDelivery = {
  message?: string;
  folder?: Mode;
  sequence?: string;
  stage?: string;
  attachment?: UploadedAttachment;
  // tolerate future additions from the backend without breaking builds
  [k: string]: any;
};

type PendingContentItem = {
  token: string;
  triggerMinute?: number;
  content: ContentDelivery;
  createdTs?: number;
};


type ChatApiResponse = {
  reply: string;
  display_reply?: string;
  displayReply?: string;
  reply_translation?: any;
  replyTranslation?: any;
  turn_translation?: any;
  turnTranslation?: any;
  mode?: ChatStatus; // IMPORTANT: this is STATUS, not the UI pill mode
  session_state?: Partial<SessionState>;
  audio_url?: string;
  content?: ContentDelivery;
  content_batch?: ContentDelivery[];
  contentBatch?: ContentDelivery[];
  // tolerate future additions from the backend without breaking builds
  [k: string]: any;
};


type RelayEvent = {
  seq: number;
  ts: number;
  role: "user" | "assistant" | "system";
  content: string;
  sender: "user" | "ai" | "xai" | "host" | "system" | string;
  audience?: "all" | "user" | "host" | string;
  kind?: string;
  payload?: any;
};

type HostActiveChat = {
  session_id: string;
  member_id: string;
  user_name?: string;
  brand?: string;
  avatar?: string;
  last_seen?: number;
  override_active?: boolean;
  override_started_at?: number | null;
  unread?: number;
  summary?: string;
  summary_source?: string;
  usage_ok?: boolean;
  minutes_used?: number;
  minutes_allowed?: number;
  minutes_total?: number;
  minutes_remaining?: number;
  plan_label?: string;
  is_trial?: boolean;
};

type HostInsightsTranscriptMessage = {
  seq?: number;
  ts?: number;
  role?: string;
  sender?: string;
  content?: string;
  kind?: string;
  user_name?: string;
};

type HostInsightsSummaryItem = {
  createDatetime: string;
  sessionId: string;
  reason?: string;
  summary: string;
  userName?: string;
  messages?: HostInsightsTranscriptMessage[];
};

function mergeRelayEventsBySeq(prev: RelayEvent[], incoming: RelayEvent[]): RelayEvent[] {
  const out: RelayEvent[] = [];
  const seen = new Set<string>();

  const push = (ev: RelayEvent) => {
    if (!ev || typeof ev !== "object") return;
    const seq = Number((ev as any)?.seq || 0);
    const sender = String((ev as any)?.sender || "").trim();
    const kind = String((ev as any)?.kind || "").trim();
    const content = String((ev as any)?.content || "");
    const payload = (() => {
      try {
        return JSON.stringify((ev as any)?.payload ?? null);
      } catch {
        return "";
      }
    })();
    const key = seq > 0 ? `seq:${seq}` : `fallback:${sender}:${kind}:${content}:${payload}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ev);
  };

  [...(prev || []), ...(incoming || [])].forEach(push);
  out.sort((a, b) => Number((a as any)?.seq || 0) - Number((b as any)?.seq || 0));
  return out.slice(-400);
}

function dedupeHostInsightsTranscript(messages: HostInsightsTranscriptMessage[]): HostInsightsTranscriptMessage[] {
  const out: HostInsightsTranscriptMessage[] = [];
  const seen = new Set<string>();
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    const seq = Number((m as any)?.seq || 0);
    const sender = String((m as any)?.sender || "").trim();
    const kind = String((m as any)?.kind || "").trim();
    const content = String((m as any)?.content || "").trim();
    const key = seq > 0 ? `seq:${seq}` : `fallback:${sender}:${kind}:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function dedupeHostInsightsSummaries(items: HostInsightsSummaryItem[]): HostInsightsSummaryItem[] {
  const out: HostInsightsSummaryItem[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const transcript = dedupeHostInsightsTranscript(Array.isArray(item.messages) ? item.messages : []);
    const transcriptSig = transcript
      .map((m) => `${Number((m as any)?.seq || 0)}|${String((m as any)?.sender || "").trim()}|${String((m as any)?.content || "").trim()}`)
      .join("\n");
    const key = [
      String(item.sessionId || "").trim(),
      String(item.reason || "").trim(),
      String(item.summary || "").trim(),
      String(item.userName || "").trim(),
      transcriptSig,
    ].join("||");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, messages: transcript });
  }
  return out;
}

function hostActiveChatDisplayDedupKey(chat: HostActiveChat): string {
  const brand = String(chat?.brand || "").trim().toLowerCase();
  const avatar = String(chat?.avatar || "").trim().toLowerCase();
  const memberId = String(chat?.member_id || "").trim().toLowerCase();
  const userName = String(chat?.user_name || "").trim().toLowerCase();
  const summary = String(chat?.summary || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 240);
  if (memberId) return `member:${brand}:${avatar}:${memberId}:${summary || "-"}`;
  if (userName) return `user:${brand}:${avatar}:${userName}:${summary || "-"}`;
  return `session:${String(chat?.session_id || "").trim()}`;
}

function dedupeHostActiveChats(chats: HostActiveChat[]): HostActiveChat[] {
  const byKey = new Map<string, HostActiveChat>();
  const ordered = [...(chats || [])].sort(
    (a, b) => Number((b as any)?.last_seen || 0) - Number((a as any)?.last_seen || 0)
  );
  for (const chat of ordered) {
    if (!chat || typeof chat !== "object") continue;
    const key = hostActiveChatDisplayDedupKey(chat);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, chat);
      continue;
    }
    const keepCurrent =
      Number((chat as any)?.last_seen || 0) > Number((prev as any)?.last_seen || 0) ||
      (Number((chat as any)?.last_seen || 0) === Number((prev as any)?.last_seen || 0) &&
        Number((chat as any)?.unread || 0) > Number((prev as any)?.unread || 0));
    const primary = keepCurrent ? chat : prev;
    const secondary = keepCurrent ? prev : chat;
    byKey.set(key, {
      ...secondary,
      ...primary,
      unread: Math.max(Number((prev as any)?.unread || 0), Number((chat as any)?.unread || 0)),
      summary: String((primary as any)?.summary || "").trim() || String((secondary as any)?.summary || "").trim(),
      summary_source: String((primary as any)?.summary_source || "").trim() || String((secondary as any)?.summary_source || "").trim(),
      override_active: Boolean((prev as any)?.override_active || (chat as any)?.override_active),
    });
  }
  return Array.from(byKey.values()).sort(
    (a, b) => Number((b as any)?.last_seen || 0) - Number((a as any)?.last_seen || 0)
  );
}

type PlanName =
  | "Trial"
  | "Discover"
  | "Explore"
  | "Encounter"
  | "Friend"
  | "Premium"
  | "Elite"
  | "Romantic"
  | "Supreme"
  | "Ultimate"
  | "Intimate"
  | "Exclusive"
  | "Mature"
  | "Pay as You Go"
  | "Test - Discover"
  | "Test - Explore"
  | "Test - Encounter"
  | "Test - Friend"
  | "Test - Premium"
  | "Test - Elite"
  | "Test - Romantic"
  | "Test - Supreme"
  | "Test - Ultimate"
  | "Test - Intimate"
  | "Test - Exclusive"
  | "Test - Mature"
  | "Test - Pay as You Go"
  | null;

// -----------------------------------------------------------------------------
// Visitor identity (anon) helpers
// - We store a per-brand anon id in localStorage so visitors without a Wix memberId
//   can still be consistently identified for freeMinutes usage tracking.
// - IMPORTANT: localStorage is scoped to the iframe origin (azurestaticapps.net),
//   so we namespace by brand to avoid cross-site collisions across white-label embeds.
// -----------------------------------------------------------------------------
const ANON_ID_PREFIX = "anon:";
const ANON_ID_STORAGE_KEY_PREFIX = "ELARALO_ANON_ID::";

function safeBrandKey(raw: string): string {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "core";
  const cleaned = s.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "core";
}

function getAnonIdStorageKey(brand: string): string {
  return `${ANON_ID_STORAGE_KEY_PREFIX}${safeBrandKey(brand)}`;
}

function generateAnonId(): string {
  try {
    // @ts-ignore
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      // @ts-ignore
      return crypto.randomUUID();
    }
  } catch (e) {}
  // Fallback: 32-hex chars
  const rand32 = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${rand32()}${rand32()}${rand32()}${rand32()}`;
}

function getOrCreateAnonMemberId(brand: string): string {
  if (typeof window === "undefined") return "";
  const storageKey = getAnonIdStorageKey(brand);

  // Primary: localStorage (sticky across sessions)
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing && existing.trim()) return `${ANON_ID_PREFIX}${existing.trim()}`;
    const id = generateAnonId();
    window.localStorage.setItem(storageKey, id);
    return `${ANON_ID_PREFIX}${id}`;
  } catch (e) {
    // Some browsers/settings can block localStorage in a third-party iframe context.
    // Secondary: sessionStorage (sticky for the tab session).
    try {
      const ssKey = `ELARALO_SESSION_ANON_ID::${safeBrandKey(brand)}`;
      const existing = window.sessionStorage.getItem(ssKey);
      if (existing && existing.trim()) return `${ANON_ID_PREFIX}${existing.trim()}`;
      const id = generateAnonId();
      window.sessionStorage.setItem(ssKey, id);
      return `${ANON_ID_PREFIX}${id}`;
    } catch (e) {
      return "";
    }
  }
}

function isAnonMemberId(memberId: string): boolean {
  return (memberId || "").trim().toLowerCase().startsWith(ANON_ID_PREFIX);
}


const LANGUAGE_NAME_OVERRIDES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  "pt-pt": "Portuguese (Portugal)",
  nl: "Dutch",
  ru: "Russian",
  uk: "Ukrainian",
  pl: "Polish",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
  fa: "Persian",
  hi: "Hindi",
  bn: "Bengali",
  ur: "Urdu",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-cn": "Chinese (Simplified)",
  "zh-tw": "Chinese (Traditional)",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ms: "Malay",
  tl: "Tagalog",
  fil: "Filipino",
  ro: "Romanian",
  el: "Greek",
  sv: "Swedish",
  no: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  sk: "Slovak",
  hu: "Hungarian",
  hr: "Croatian",
  sr: "Serbian",
  bg: "Bulgarian",
};

function normalizeLanguageTag(raw: any): string {
  const value = String(raw ?? "").trim().replace(/_/g, "-");
  if (!value) return "";
  const parts = value.split("-").filter(Boolean);
  if (!parts.length) return "";
  const base = parts[0].replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!base) return "";
  const out = [base];
  for (const part of parts.slice(1)) {
    const cleaned = String(part || "").replace(/[^A-Za-z0-9]/g, "");
    if (!cleaned) continue;
    out.push(cleaned.length <= 3 ? cleaned.toUpperCase() : cleaned);
  }
  return out.join("-");
}

function languageBase(code: any): string {
  return normalizeLanguageTag(code).split("-", 1)[0] || "";
}

function isEnglishLanguage(code: any): boolean {
  const base = languageBase(code);
  return !base || base === "en";
}

function languageNameFromCode(code: any): string {
  const norm = normalizeLanguageTag(code).toLowerCase();
  if (!norm) return "English";
  if (LANGUAGE_NAME_OVERRIDES[norm]) return LANGUAGE_NAME_OVERRIDES[norm];
  const base = norm.split("-", 1)[0];
  if (LANGUAGE_NAME_OVERRIDES[base]) return LANGUAGE_NAME_OVERRIDES[base];
  return norm;
}

type DetectedLanguagePreference = {
  code: string;
  known: boolean;
};

function detectInitialLanguagePreference(): DetectedLanguagePreference {
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const fromQuery =
        params.get("preferredLanguage") ||
        params.get("preferred_language") ||
        params.get("userPreferredLanguage") ||
        params.get("user_preferred_language") ||
        params.get("userLanguage") ||
        params.get("user_language") ||
        params.get("language") ||
        params.get("locale") ||
        params.get("lang") ||
        "";
      const normalizedQuery = normalizeLanguageTag(fromQuery);
      if (normalizedQuery) return { code: normalizedQuery, known: true };
    } catch (e) {}

    try {
      const langs = Array.isArray(window.navigator?.languages) ? window.navigator.languages : [];
      const candidate = normalizeLanguageTag(langs[0] || window.navigator?.language || "");
      if (candidate) return { code: candidate, known: false };
    } catch (e) {}
  }
  return { code: "en", known: false };
}

function detectInitialUserLanguageCode(): string {
  return detectInitialLanguagePreference().code;
}

function coerceBooleanLike(raw: any): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return null;
  const txt = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(txt)) return true;
  if (["0", "false", "no", "off"].includes(txt)) return false;
  return null;
}

function messageEnglishText(m: Msg): string {
  const meta: any = (m as any)?.meta || {};
  const translation: any = meta?.translation || {};
  return String(
    translation?.englishText ||
    meta?.englishText ||
    meta?.english_text ||
    (m as any)?.english_content ||
    m.content ||
    ""
  ).trim();
}

function relayEventPayloadNativeText(ev: RelayEvent | any): string {
  const payload: any = (ev as any)?.payload || {};
  return String(payload?.display_text || payload?.native_text || "").trim();
}

function relayEventPayloadEnglishText(ev: RelayEvent | any): string {
  const payload: any = (ev as any)?.payload || {};
  return String(payload?.english_text || "").trim();
}

function relayEventPayloadLanguageName(ev: RelayEvent | any): string {
  const payload: any = (ev as any)?.payload || {};
  return String(payload?.user_language_name || languageNameFromCode(payload?.user_language_code || "")).trim();
}

function relayEventUserFacingText(ev: RelayEvent | any): string {
  return relayEventPayloadNativeText(ev) || String((ev as any)?.content || relayEventPayloadEnglishText(ev) || "").trim();
}

function relayEventHostFacingText(ev: RelayEvent | any): string {
  const nativeText = relayEventPayloadNativeText(ev);
  const englishText = relayEventPayloadEnglishText(ev);
  const langName = relayEventPayloadLanguageName(ev) || "Native";
  const fallback = String((ev as any)?.content || englishText || nativeText || "").trim();
  if (!nativeText || !englishText || nativeText === englishText) return fallback;
  return `English:
${englishText}

${langName}:
${nativeText}`;
}


type NormalizedTurnTranslation = {
  displayText: string;
  englishText: string;
  userLanguageCode: string;
  userLanguageName: string;
};

function normalizeTurnTranslation(raw: any): NormalizedTurnTranslation | null {
  const payload: any = raw && typeof raw === "object" ? raw : {};
  const displayText = String(
    payload?.display_text ?? payload?.displayText ?? payload?.native_text ?? payload?.nativeText ?? ""
  ).trim();
  const englishText = String(payload?.english_text ?? payload?.englishText ?? "").trim();
  const userLanguageCode = normalizeLanguageTag(payload?.user_language_code ?? payload?.userLanguageCode ?? "");
  const userLanguageName = String(
    payload?.user_language_name ?? payload?.userLanguageName ?? languageNameFromCode(userLanguageCode || "")
  ).trim();
  if (!displayText && !englishText && !userLanguageCode && !userLanguageName) return null;
  return {
    displayText: displayText || englishText,
    englishText,
    userLanguageCode,
    userLanguageName: userLanguageName || languageNameFromCode(userLanguageCode || ""),
  };
}

function buildTranslationMeta(raw: any, fallbackDisplayText: string = ""): any | null {
  const normalized = normalizeTurnTranslation(raw);
  const fallback = String(fallbackDisplayText || "").trim();
  if (!normalized && !fallback) return null;
  const displayText = String(normalized?.displayText || fallback).trim();
  const englishText = String(normalized?.englishText || "").trim();
  const userLanguageCode = normalizeLanguageTag(normalized?.userLanguageCode || "");
  const userLanguageName = String(
    normalized?.userLanguageName || languageNameFromCode(userLanguageCode || "")
  ).trim();
  if (!displayText && !englishText) return null;
  return {
    displayText,
    nativeText: displayText,
    englishText,
    userLanguageCode,
    userLanguageName: userLanguageName || languageNameFromCode(userLanguageCode || ""),
  };
}

function applyTranslationMetaToMsg(msg: Msg, raw: any, fallbackDisplayText: string = ""): Msg {
  const translationMeta = buildTranslationMeta(raw, fallbackDisplayText);
  if (!translationMeta) return msg;
  const prevMeta: any = (msg as any)?.meta || {};
  const nextMeta: any = {
    ...prevMeta,
    translation: translationMeta,
  };
  if (translationMeta.englishText) {
    nextMeta.englishText = translationMeta.englishText;
    nextMeta.english_text = translationMeta.englishText;
  }
  return { ...msg, meta: nextMeta };
}

function buildAssistantTurnMsg(displayText: string, rawTranslation: any, sender: string = "ai"): Msg | null {
  const content = String(displayText || "").trim();
  if (!content) return null;
  return applyTranslationMetaToMsg(
    { role: "assistant", content, meta: { sender } },
    rawTranslation,
    content,
  );
}



// --- Plan and companion helpers (no UI changes beyond required labels) ---
function normalizePlanName(raw: any): PlanName {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const normalized = s
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*membership\s*$/i, "")
    .trim();
  const isTest = /^test\s+/i.test(normalized);
  const base = normalized.replace(/^test\s+/i, "").trim();
  const key = base.toLowerCase();

  const canonical: Record<string, Exclude<PlanName, null>> = {
    trial: "Trial",
    discover: "Discover",
    explore: "Explore",
    encounter: "Encounter",
    friend: "Friend",
    premium: "Premium",
    elite: "Elite",
    romantic: "Romantic",
    supreme: "Supreme",
    ultimate: "Ultimate",
    intimate: "Intimate",
    "intimate 18+": "Intimate",
    exclusive: "Exclusive",
    mature: "Mature",
    "pay as you go": "Pay as You Go",
  };

  const mapped = canonical[key];
  if (!mapped) return null;

  // Wix test plans such as "Test - Exclusive" are legacy operational plans.
  // Normalize them to the paid canonical plan so Connect does not fall back to Trial
  // and so the Host Console can unlock immediately for the actual member payload.
  if (isTest) return mapped;
  return mapped;
}

function stripTrialControlsFromRebrandingKey(key: string): string {
  const normalizedKey = normalizeRebrandingKeyValue(key);
  const p = parseRebrandingKey(normalizedKey);
  if (!p) return normalizedKey;

  // IMPORTANT:
  // Historically some backend paths read the *plan* segment (6th field) from the rebrandingKey to decide
  // included minutes. For white-label sites, the 6th field may be the white-label plan label (e.g. "Test - Exclusive")
  // and the Elaralo entitlement plan is carried in `elaraloPlanMap` (e.g. "Mature").
  //
  // Keep format stable (9 segments) but DO NOT blank-out FreeMinutes/CycleDays.
  // For white-label, `FreeMinutes` is treated as the plan's top-up/included minutes value.
  // Backend uses `elaraloPlanMap` for entitlement gating and `FreeMinutes` for quota overrides.
  return [
    p.rebranding,
    p.upgradeLink,
    p.payGoLink,
    p.payGoPrice,
    p.payGoMinutes,
    p.plan,
    p.elaraloPlanMap,
    p.freeMinutes,
    p.cycleDays,
  ].join("|");
}

function displayPlanLabel(planName: PlanName, memberId: string, planLabelOverride?: string, loggedIn: boolean = true): string {
  const mid = String(memberId || "").trim();
  const hasMemberId = Boolean(mid) && !isAnonMemberId(mid) && Boolean(loggedIn);

  // Product rule: absence of a paid plan is Trial for visitors and logged-in
  // members alike.  Display both cases as Free Trial.
  if (!hasMemberId || !planName || planName === "Trial") return "Free Trial";

  // White-label: show the rebranding site's plan label when provided (e.g., "Supreme"),
  // while still using ElaraloPlanMap for capability gating.
  const override = String(planLabelOverride || "").trim();
  if (override) return override;

  return planName;
}

type CompanionKeySplit = {
  baseKey: string;
  flags: Record<string, string>;
};

/**
 * Companion keys can include optional metadata after a pipe.
 * Example:
 *   "Elara-Female-Caucasian-GenZ|live=stream"
 *
 * The baseKey is used for parsing/display and file lookups.
 * Flags are used for live behavior (D-ID vs streaming/web conference).
 */
function splitCompanionKey(raw: string): CompanionKeySplit {
  const s = String(raw ?? "").trim();
  if (!s) return { baseKey: "", flags: {} };

  const parts = s.split("|").map((p) => p.trim()).filter(Boolean);
  const baseKey = parts[0] || "";
  const flags: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const piece = parts[i] || "";
    const eq = piece.indexOf("=");
    if (eq === -1) {
      flags[piece.toLowerCase()] = "1";
      continue;
    }
    const k = piece.slice(0, eq).trim().toLowerCase();
    const v = piece.slice(eq + 1).trim();
    if (k) flags[k] = v;
  }

  return { baseKey, flags };
}

function modeFromElaraloPlanMap(raw: unknown): Mode | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("mature") || s.includes("intimate")) return "intimate";
  if (s.includes("mate") || s.includes("romantic")) return "romantic";
  if (s.includes("intro") || s.includes("friend")) return "friend";
  return null;
}

// Companion payload override:
// - modePill is a backend/secret-driven hint for which UI pill should be selected on initial render.
// - Accepts common string variants ("Romantic", "romantic", "MODE_PILL_ROMANTIC", etc.).
function modeFromModePill(raw: unknown): Mode | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("mature") || s.includes("intimate")) return "intimate";
  if (s.includes("mate") || s.includes("romantic")) return "romantic";
  if (s.includes("intro") || s.includes("friend")) return "friend";
  return null;
}

type CompanionMeta = {
  first: string;
  gender: string;
  ethnicity: string;
  generation: string;
  key: string;
};

const DEFAULT_COMPANION_NAME = "Elara";

function trimQueryValue(raw: any): string {
  return String(raw ?? "").trim();
}

function firstQueryValue(params: URLSearchParams, names: string[]): string {
  for (const name of names) {
    const value = trimQueryValue(params.get(name));
    if (value) return value;
  }
  return "";
}

function booleanFromQuery(raw: string): boolean | null {
  const v = trimQueryValue(raw).toLowerCase();
  if (!v) return null;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

type CompanionListReturnContext = {
  enabled: boolean;
  count: number;
  url: string;
};

function readCompanionListReturnContextFromUrl(): CompanionListReturnContext {
  if (typeof window === "undefined") return { enabled: false, count: 0, url: "" };
  try {
    const params = new URLSearchParams(window.location.search || "");
    const sourceKey = firstQueryValue(params, ["source", "launchSource", "launch_source"])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const fromSummaryPublic = sourceKey === "summarypublic";
    const countRaw = firstQueryValue(params, [
      "selectableCompanionCount",
      "selectable_companion_count",
      "companionCount",
      "companion_count",
    ]);
    const parsedCount = Math.max(0, Number.parseInt(countRaw || "0", 10) || 0);
    const count = Math.max(parsedCount, fromSummaryPublic ? 2 : 0);

    const explicitWantsReturnButton = booleanFromQuery(firstQueryValue(params, [
      "returnToCompanions",
      "return_to_companions",
      "showCompanionListButton",
      "show_companion_list_button",
    ])) === true;
    // Summary Public launches are single-profile pages, so they do not always carry
    // the selector's companion-count handoff.  Treat source=summary-public as a
    // valid return-to-list launch and build the same safe /my-elaralo fallback.
    const wantsReturnButton = explicitWantsReturnButton || fromSummaryPublic;

    if (count <= 1 || !wantsReturnButton) return { enabled: false, count, url: "" };

    const rawUrl = firstQueryValue(params, ["companionListUrl", "companion_list_url", "returnUrl", "return_url"]);
    let target: URL | null = null;
    if (rawUrl) {
      try {
        const candidate = new URL(rawUrl, window.location.origin);
        if (candidate.origin === window.location.origin) target = candidate;
      } catch {
        target = null;
      }
    }

    if (!target) {
      target = new URL("/my-elaralo", window.location.origin);
      const brand = firstQueryValue(params, ["brand", "rebranding", "companyName", "company_name", "company"]) || DEFAULT_COMPANY_NAME;
      target.searchParams.set("brand", brand);
      const loggedInRaw = firstQueryValue(params, ["loggedIn", "logged_in"]);
      if (loggedInRaw) target.searchParams.set("loggedIn", loggedInRaw);
      const memberId = firstQueryValue(params, ["memberId", "member_id"]);
      if (memberId) target.searchParams.set("memberId", memberId);
      const displayName = firstQueryValue(params, ["displayName", "display_name", "userName", "user_name"]);
      if (displayName) target.searchParams.set("displayName", displayName);
      const email = firstQueryValue(params, ["email"]);
      if (email) target.searchParams.set("email", email);
    }

    for (const name of ["autoOpenSingle", "auto_open_single", "autoOpen", "auto_open"]) {
      target.searchParams.delete(name);
    }
    target.searchParams.set("forceSelector", "1");
    target.searchParams.set("showCompanionList", "1");
    target.searchParams.set("returningFromConnect", "1");

    return { enabled: true, count, url: target.toString() };
  } catch {
    return { enabled: false, count: 0, url: "" };
  }
}

function readableError(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => readableError(item)).filter(Boolean).join("; ").trim();
  if (typeof value === "object") {
    const preferred =
      readableError((value as any).message) ||
      readableError((value as any).error) ||
      readableError((value as any).detail) ||
      readableError((value as any).reason);
    if (preferred) return preferred;
    try { return JSON.stringify(value); } catch { return "Unexpected API error."; }
  }
  return String(value || "").trim();
}

function compactBrandKey(raw: any): string {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isElaraloBrandName(raw: any): boolean {
  return compactBrandKey(raw || DEFAULT_COMPANY_NAME) === "elaralo";
}

function isAiCompanionFilenameKey(raw: any): boolean {
  const base = splitCompanionKey(String(raw || "")).baseKey || String(raw || "");
  const cleaned = stripExt(base).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  return parts.length >= 4;
}

function aiFirstNameFromKey(raw: any): string {
  const base = splitCompanionKey(String(raw || "")).baseKey || String(raw || "");
  const cleaned = stripExt(base).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.split("-", 1)[0]?.trim() || "";
}

function normalizeCompanionTypeHint(raw: any): "AI" | "Human" | "" {
  const s = String(raw || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return "";
  if (s === "ai" || s === "ai companion") return "AI";
  if (s === "human" || s === "human companion") return "Human";
  return "";
}

function readDirectCompanionHandoffFromUrl(): Record<string, any> | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search || "");
    const rawCompanion = firstQueryValue(params, [
      "avatar",
      "avatarName",
      "avatar_name",
      "companion",
      "companionName",
      "companion_name",
      "selectedAvatar",
      "selected_avatar",
      "selectedCompanion",
      "selected_companion",
    ]);
    const explicitCompanionKey = firstQueryValue(params, ["companionKey", "companion_key"]);
    const companionKey = explicitCompanionKey || rawCompanion;
    if (!companionKey) return null;

    const explicitBrand = firstQueryValue(params, ["brand", "companyName", "company_name", "company", "rebranding"]);
    const source = firstQueryValue(params, ["source", "handoffSource", "handoff_source", "origin"]);
    const normalizedSource = source.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const isMyElaraloDirect = ["myelaralo", "elaraloapp", "elaralocatalog", "elaralo"].includes(normalizedSource);
    const isExplicitElaraloBrand = Boolean(explicitBrand && isElaraloBrandName(explicitBrand));

    // DulceMoon and other white-label Connect payloads are provided by Wix postMessage.
    // Direct URL handoff is reserved for My Elaralo / Elaralo catalog launches.
    if (!isMyElaraloDirect && !isExplicitElaraloBrand) return null;

    const brand = explicitBrand || DEFAULT_COMPANY_NAME;
    const isAiKey = isAiCompanionFilenameKey(companionKey);
    const companionDisplayName =
      firstQueryValue(params, ["companionDisplayName", "companion_display_name", "displayCompanionName", "display_companion_name"]) ||
      (isAiKey ? aiFirstNameFromKey(companionKey) : "") ||
      rawCompanion ||
      companionKey;

    const explicitMappingAvatar = firstQueryValue(params, ["mappingAvatar", "mapping_avatar", "sqlAvatar", "sql_avatar"]);
    const mappingAvatar = explicitMappingAvatar || rawCompanion || (isAiKey ? aiFirstNameFromKey(companionKey) : companionDisplayName) || companionKey;
    const companionTypeHint = normalizeCompanionTypeHint(firstQueryValue(params, ["companionType", "companion_type", "type"]));
    const rebrandingKey = firstQueryValue(params, ["rebrandingKey", "rebranding_key", "RebrandingKey", "rebrandingkey"]);
    const memberId = firstQueryValue(params, ["memberId", "member_id"]);
    const displayName = firstQueryValue(params, ["displayName", "display_name", "userName", "user_name", "username"]);
    const planName = firstQueryValue(params, ["planName", "plan_name", "plan"]);
    const modePill = firstQueryValue(params, ["modePill", "mode_pill", "modepill", "mode"]);
    const freeMinutes = firstQueryValue(params, ["freeMinutes", "free_minutes", "includedMinutes", "included_minutes"]);
    const cycleDays = firstQueryValue(params, ["cycleDays", "cycle_days"]);
    const preferredLanguage = firstQueryValue(params, ["preferredLanguage", "preferred_language", "userLanguage", "user_language", "language", "locale", "lang"]);
    const headshotUrl = firstQueryValue(params, ["headshotUrl", "headshot_url", "imageUrl", "image_url", "photoUrl", "photo_url"]);
    const loggedInValue = booleanFromQuery(firstQueryValue(params, ["loggedIn", "logged_in"]));
    const loggedIn = loggedInValue !== null ? loggedInValue : Boolean(memberId);

    const payload: Record<string, any> = {
      type: "MEMBER_PLAN",
      source: source || "my-elaralo",
      directQueryOverride: true,
      loggedIn,
      logged_in: loggedIn,
      memberId,
      member_id: memberId,
      displayName,
      display_name: displayName,
      userName: displayName,
      user_name: displayName,
      brand,
      companyName: brand,
      company_name: brand,
      company: brand,
      rebranding: brand,

      // Mapping/display identifiers.  For Elaralo AI, the mapping avatar is the
      // display first name, while companionKey remains the full filename stem.
      avatar: mappingAvatar,
      avatarName: mappingAvatar,
      avatar_name: mappingAvatar,
      companion: mappingAvatar,
      companionName: mappingAvatar,
      companion_name: mappingAvatar,
      companionDisplayName,
      companion_display_name: companionDisplayName,
      companionKey: companionKey,
      companion_key: companionKey,
    };

    const isVisitorHandoff = !memberId && !loggedIn;
    if (isVisitorHandoff && isElaraloBrandName(brand)) {
      payload.planName = planName || "Trial";
      payload.plan_name = planName || "Trial";
      const trialMinutesOverride = freeMinutes || ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE;
      if (trialMinutesOverride) {
        payload.freeMinutes = trialMinutesOverride;
        payload.free_minutes = trialMinutesOverride;
        payload.includedMinutes = trialMinutesOverride;
        payload.included_minutes = trialMinutesOverride;
      }
      if (cycleDays) {
        payload.cycleDays = cycleDays;
        payload.cycle_days = cycleDays;
      }
      if (!modePill) {
        payload.modePill = "Mate";
        payload.mode_pill = "Mate";
      }
    }

    if (companionTypeHint) {
      payload.companionType = companionTypeHint;
      payload.companion_type = companionTypeHint;
    }

    if (rebrandingKey) {
      payload.rebrandingKey = rebrandingKey;
      payload.rebranding_key = rebrandingKey;
      payload.RebrandingKey = rebrandingKey;
    }
    if (planName) {
      payload.planName = planName;
      payload.plan_name = planName;
    }
    if (modePill) {
      payload.modePill = modePill;
      payload.mode_pill = modePill;
    }
    if (freeMinutes) {
      payload.freeMinutes = freeMinutes;
      payload.free_minutes = freeMinutes;
      payload.includedMinutes = freeMinutes;
      payload.included_minutes = freeMinutes;
    }
    if (cycleDays) {
      payload.cycleDays = cycleDays;
      payload.cycle_days = cycleDays;
    }
    if (preferredLanguage) {
      payload.preferredLanguage = preferredLanguage;
      payload.preferred_language = preferredLanguage;
      payload.userLanguage = preferredLanguage;
      payload.user_language = preferredLanguage;
    }
    if (headshotUrl) {
      payload.headshotUrl = headshotUrl;
      payload.headshot_url = headshotUrl;
    }

    return payload;
  } catch (e) {
    return null;
  }
}

function mergeDirectCompanionHandoff(data: any, direct: Record<string, any> | null): any {
  if (!direct || !direct.avatar) return data;
  const input = data && typeof data === "object" ? data : {};
  const merged: Record<string, any> = { ...input, ...direct };

  // Preserve authoritative Wix/member context when the parent provides it, while
  // keeping the directly selected companion key from the My Elaralo button.
  if ("loggedIn" in input) merged.loggedIn = (input as any).loggedIn;
  if ("logged_in" in input) merged.logged_in = (input as any).logged_in;
  if (trimQueryValue((input as any).memberId || (input as any).member_id)) {
    merged.memberId = trimQueryValue((input as any).memberId || (input as any).member_id);
    merged.member_id = merged.memberId;
  }
  if (trimQueryValue((input as any).planName || (input as any).plan_name)) {
    merged.planName = trimQueryValue((input as any).planName || (input as any).plan_name);
    merged.plan_name = merged.planName;
  }
  if (trimQueryValue((input as any).displayName || (input as any).display_name || (input as any).userName || (input as any).user_name)) {
    merged.displayName = trimQueryValue((input as any).displayName || (input as any).display_name || (input as any).userName || (input as any).user_name);
    merged.display_name = merged.displayName;
    merged.userName = merged.displayName;
    merged.user_name = merged.displayName;
  }

  return merged;
}


// Step C (Latency): limit how much chat history we send to /chat.
// 20 turns ~= 40 messages (user+assistant). System prompt (if present) is always preserved.
const MAX_MESSAGES_TO_SEND = 40;

function trimMessagesForChat<T extends { role: string; content: any }>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length <= MAX_MESSAGES_TO_SEND) return messages;

  const first = messages[0];
  const hasSystem = first && first.role === "system";

  const body = hasSystem ? messages.slice(1) : messages.slice();

  const trimmedBody = body.slice(Math.max(0, body.length - MAX_MESSAGES_TO_SEND));

  return hasSystem ? ([first, ...trimmedBody] as T[]) : (trimmedBody as T[]);
}


// -----------------------------------------------------------------------------
// In-session conversation "summaries" (client-side digests)
// - When older turns are trimmed before sending to /chat, we keep a compact digest
//   in session_state so the backend can inject it as context.
// - These digests are NOT the same as the explicit user-authorized /chat/save-summary.
// -----------------------------------------------------------------------------
const MAX_IN_SESSION_SUMMARY_CHUNKS = 8;
const DIGEST_MAX_LINES = 12;
const DIGEST_MAX_CHARS_PER_LINE = 220;

function normalizeDigestLine(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildDigestFromDroppedMessages(dropped: Msg[]): string {
  if (!Array.isArray(dropped) || dropped.length === 0) return "";
  const lines: string[] = [];

  for (let i = 0; i < dropped.length && lines.length < DIGEST_MAX_LINES; i++) {
    const m = dropped[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

    let c = normalizeDigestLine(messageEnglishText(m));
    if (!c) continue;

    if (c.length > DIGEST_MAX_CHARS_PER_LINE) c = c.slice(0, DIGEST_MAX_CHARS_PER_LINE) + "…";
    const senderLabel = m.role === "user" ? "User" : ((m as any)?.meta?.sender === "host" ? "Host" : "Assistant");
    lines.push(`${senderLabel}: ${c}`);
  }

  const remaining = dropped.length - lines.length;
  if (remaining > 0) lines.push(`(… ${remaining} earlier message(s) omitted)`);

  return lines.join("\n");
}


const HEADSHOT_DIR = "/companion/headshot";

function isCompanionImageUrl(raw: any): boolean {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes(`${HEADSHOT_DIR}/`) ||
    s.includes("/brand/elaralo/companion/ai/") ||
    s.includes("/brand/elaralo/companion/human/") ||
    s.includes("/host-onboarding/") ||
    s.includes("/connect-platform/companion/headshot/")
  );
}

// Resolve companion key/name for backend requests and TTS voice selection.
// This must be browser-safe and never rely on DOM parsing.
function resolveCompanionForBackend(opts: { companionKey?: string; companionName?: string }): string {
  const ck = (opts.companionKey || '').trim();
  if (ck) return ck;
  const cn = (opts.companionName || '').trim();
  if (cn) return cn;
  return DEFAULT_COMPANION_NAME;
}

const GREET_ONCE_KEY = "ELARALO_GREETED";
const DEFAULT_AVATAR = elaraLogo.src;
const DEFAULT_COMPANY_NAME = "Elaralo";
// v9.1.28: Elaralo visitors are allowed 10 free Connect minutes before the same PayGo/Upgrade paywall used by DulceMoon.
const ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE = String(
  process.env.NEXT_PUBLIC_ELARALO_TRIAL_MINUTES || process.env.NEXT_PUBLIC_TRIAL_MINUTES_ELARALO || ""
).trim();
// Wix handoff / query param: a single "|" separated key (Rebranding|UpgradeLink|PayGoLink|PayGoPrice|PayGoMinutes|Plan|ElaraloPlanMap|FreeMinutes|CycleDays)
const REBRANDING_KEY_QUERY_PARAM = "rebrandingKey";

// Back-compat: older embeds/tests may still pass ?rebranding=BrandName
const LEGACY_REBRANDING_QUERY_PARAM = "rebranding";

// Public asset root for white-label rebrands
const REBRANDING_PUBLIC_DIR = "/rebranding";

type RebrandingKeyParts = {
  rebranding: string;
  upgradeLink: string;
  payGoLink: string;
  payGoPrice: string;
  payGoMinutes: string;
  plan: string;
  elaraloPlanMap: string;
  freeMinutes: string;
  cycleDays: string;
};

function stripRebrandingKeyLabel(part: string): string {
  const s = String(part || "").trim();
  // Accept either raw values ("DulceMoon") or labeled values ("Rebranding: DulceMoon")
  const m = s.match(/^[A-Za-z0-9_ ()+-]+\s*[:=]\s*(.+)$/);
  return m ? String(m[1] || "").trim() : s;
}

function normalizeRebrandingKeyValue(raw: any): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const folded = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  const lower = folded.toLowerCase();
  if (lower === "null" || lower === "undefined") return "";
  if (folded === '""' || folded === "''") return "";

  if (folded.length >= 2) {
    const first = folded[0];
    const last = folded[folded.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      const inner = folded.slice(1, -1).trim();
      const innerLower = inner.toLowerCase();
      if (!inner || inner === '""' || inner === "''" || innerLower === "null" || innerLower === "undefined") {
        return "";
      }
    }
  }

  return folded;
}

function parseRebrandingKey(raw: string): RebrandingKeyParts | null {
  const v = normalizeRebrandingKeyValue(raw);
  if (!v) return null;

  // Legacy support: if there is no "|" delimiter, treat this as just the brand name.
  if (!v.includes("|")) {
    const brand = normalizeRebrandingKeyValue(stripRebrandingKeyLabel(v));
    if (!brand) return null;
    return {
      rebranding: brand,
      upgradeLink: "",
      payGoLink: "",
      payGoPrice: "",
      payGoMinutes: "",
      plan: "",
      elaraloPlanMap: "",
      freeMinutes: "",
      cycleDays: "",
    };
  }

  const parts = v.split("|").map((p) => normalizeRebrandingKeyValue(stripRebrandingKeyLabel(p)));

  const [
    rebranding = "",
    upgradeLink = "",
    payGoLink = "",
    payGoPrice = "",
    payGoMinutes = "",
    plan = "",
    elaraloPlanMap = "",
    freeMinutes = "",
    cycleDays = "",
  ] = parts;

  return {
    rebranding: String(rebranding || "").trim(),
    upgradeLink: String(upgradeLink || "").trim(),
    payGoLink: String(payGoLink || "").trim(),
    payGoPrice: String(payGoPrice || "").trim(),
    payGoMinutes: String(payGoMinutes || "").trim(),
    plan: String(plan || "").trim(),
    elaraloPlanMap: String(elaraloPlanMap || "").trim(),
    freeMinutes: String(freeMinutes || "").trim(),
    cycleDays: String(cycleDays || "").trim(),
  };
}


type MemberPlanCacheEnvelope = {
  v?: number;
  cachedAt?: number;
  payload?: any;
};

function buildVisitorSafeMemberPlanCachePayload(raw: any): Record<string, any> | null {
  const candidate =
    raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as any).payload === "object"
      ? (raw as any).payload
      : raw;
  const data = candidate && typeof candidate === "object" ? (candidate as any) : null;
  if (!data || String(data.type || "").trim() !== "MEMBER_PLAN") return null;

  const explicitRebrandingKey = normalizeRebrandingKeyValue(
    data.rebrandingKey ?? data.rebranding_key ?? data.RebrandingKey ?? data.rebrandingkey ?? ""
  );
  const parsedKey = parseRebrandingKey(explicitRebrandingKey);
  const brand = normalizeRebrandingKeyValue(
    parsedKey?.rebranding ||
      data.brand ||
      data.companyName ||
      data.company_name ||
      data.company ||
      data.rebranding ||
      ""
  );
  const avatar = String(
    data.avatar || data.avatarName || data.avatar_name || data.companion || data.companionName || data.companion_name || ""
  ).trim();
  if (!brand || !avatar) return null;

  const modePill =
    typeof data.modePill === "string"
      ? String(data.modePill).trim()
      : typeof data.mode_pill === "string"
        ? String(data.mode_pill).trim()
        : typeof data.modepill === "string"
          ? String(data.modepill).trim()
          : "";

  const out: Record<string, any> = {
    type: "MEMBER_PLAN",
    loggedIn: false,
    planName: "Trial",
    plan_name: "Trial",
    memberId: "",
    member_id: "",
    brand,
    companyName: brand,
    company_name: brand,
    company: brand,
    rebranding: brand,
    rebrandingKey: brand,
    rebranding_key: brand,
    RebrandingKey: brand,
    avatar,
    companion: avatar,
    companionName: avatar,
    companion_name: avatar,
  };
  if (modePill) {
    out.modePill = modePill;
    out.mode_pill = modePill;
  }
  return out;
}

function encodeMemberPlanCachePayload(raw: any): string {
  const payload = buildVisitorSafeMemberPlanCachePayload(raw);
  if (!payload) return "";
  const envelope: MemberPlanCacheEnvelope = {
    v: 2,
    cachedAt: Date.now(),
    payload,
  };
  return JSON.stringify(envelope);
}

function decodeMemberPlanCachePayload(rawText: string): Record<string, any> | null {
  const parsed = JSON.parse(String(rawText || ""));
  return buildVisitorSafeMemberPlanCachePayload(parsed);
}

function normalizeRebrandingSlug(rawBrand: string): string {
  const raw = String(rawBrand || "").trim();
  if (!raw) return "";

  // Match the prior logo normalization rules so:
  // - "Dulce Moon" and "DulceMoon" both -> "dulcemoon"
  // - also works if someone includes an extension or "-logo" suffix
  const normalizedBase = raw
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .replace(/-logo$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  return normalizedBase || raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}


function getAppBasePathFromAsset(assetPath: string): string {
  const p = String(assetPath || "");
  const idx = p.indexOf("/_next/");
  // If Next.js is configured with a basePath, imported assets will include it (e.g., "/foo/_next/...").
  // We want to prefix rebrand logos with the same basePath so they resolve correctly in all deployments.
  if (idx > 0) return p.slice(0, idx);
  return "";
}

function joinUrlPrefix(prefix: string, path: string): string {
  const pre = String(prefix || "").trim();
  const p = String(path || "");
  if (!pre) return p;
  if (pre.endsWith("/") && p.startsWith("/")) return pre.slice(0, -1) + p;
  if (!pre.endsWith("/") && !p.startsWith("/")) return pre + "/" + p;
  return pre + p;
}

const APP_BASE_PATH = getAppBasePathFromAsset(DEFAULT_AVATAR);

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const STRIPE_PUBLISHABLE_KEY = String(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "").trim();


const API_BASE_TRIM = String(API_BASE || "").replace(/\/+$/, "");

function absolutizeApiUrl(url: string): string {
  const u = String(url || "").trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (!API_BASE_TRIM) return u;
  const p = u.startsWith("/") ? u : `/${u}`;
  return joinUrlPrefix(API_BASE_TRIM, p);
}

function normalizeUploadedAttachment(raw: any): UploadedAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const url = absolutizeApiUrl(String((raw as any).url || ""));
  if (!url) return null;

  const name = String((raw as any).name || "content");
  const sizeNum = Number((raw as any).size ?? 0);
  const size = Number.isFinite(sizeNum) && sizeNum >= 0 ? sizeNum : 0;

  const ct = String((raw as any).contentType || (raw as any).content_type || "application/octet-stream");
  const contentType = ct.trim() || "application/octet-stream";

  const containerRaw = (raw as any).container;
  const blobRaw = (raw as any).blobName ?? (raw as any).blob_name;

  const container = containerRaw ? String(containerRaw) : undefined;
  const blobName = blobRaw ? String(blobRaw) : undefined;

  return { url, name, size, contentType, container, blobName };
}

function isRequestedHumanPhotoDelivery(meta: any): boolean {
  const delivery = meta?.contentDelivery || {};
  const kind = String(delivery?.deliveryKind || delivery?.delivery_kind || "").trim().toLowerCase();
  return (
    kind === "requested_human_photo" ||
    Boolean(delivery?.requestedHumanPhoto || delivery?.requested_human_photo || meta?.requestedHumanPhoto || meta?.requested_human_photo)
  );
}

function platformContentLabel(meta: any): string {
  return isRequestedHumanPhotoDelivery(meta) ? "Requested Human Companion photo" : "Scheduled content";
}

function isPlatformContentPlaceholderText(contentText: string): boolean {
  const text = String(contentText || "").trim();
  return /^(Scheduled content|Requested Human Companion photo) was delivered by the platform\b/i.test(text);
}

function extractPlatformContentFileName(contentText: string, meta: any): string {
  const fromMeta = String(meta?.attachment?.name || meta?.contentDelivery?.fileName || "").trim();
  if (fromMeta) return fromMeta;

  const text = String(contentText || "");
  const blockMatch = text.match(/(?:^|\n)\s*(?:Attachment|File(?: name)?)\s*:\s*([^\n]+)/i);
  if (blockMatch) return String(blockMatch[1] || "").trim().replace(/[.,;:!?]+$/, "");

  const inlineMatch = text.match(/\bFile(?: name)?\s*:\s*([^\n]+)/i);
  if (inlineMatch) return String(inlineMatch[1] || "").trim().replace(/[.,;:!?]+$/, "");

  return "";
}

function platformContentPlaceholder(contentText: string, meta: any): string {
  const fileName = extractPlatformContentFileName(contentText, meta);
  const label = platformContentLabel(meta);
  return fileName ? `${label} was delivered by the platform: ${fileName}.` : `${label} was delivered by the platform.`;
}

function extractDeliveredContentFileNamesFromMessages(messages: Msg[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (String((m as any).role || "") !== "assistant") continue;

    const meta: any = (m as any).meta || {};
    const content = String((m as any).content || "");
    const isPlatformContent =
      Boolean(meta?.contentDelivery) || isPlatformContentPlaceholderText(content);
    if (!isPlatformContent) continue;

    const fileName = extractPlatformContentFileName(content, meta);
    if (!fileName) continue;

    const key = fileName.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(fileName.trim());
  }

  return out;
}

function normalizePlatformContentMessage(contentText: string, meta: any): string {
  const text = String(contentText || "").trim();
  if (!text) return platformContentPlaceholder(text, meta);
  if (/^(Scheduled content|Requested Human Companion photo) was delivered by the platform\.?$/i.test(text)) {
    return platformContentPlaceholder(text, meta);
  }
  return text;
}

function buildContentAssistantMsg(rawContent: any): Msg | null {
  if (!rawContent || typeof rawContent !== "object") return null;
  const att = normalizeUploadedAttachment((rawContent as any).attachment);
  const message = String((rawContent as any).message || "").trim();
  if (!att && !message) return null;

  const meta: any = { sender: "ai" };
  if (att) meta.attachment = att;
  const deliveryKind = String((rawContent as any).deliveryKind || (rawContent as any).delivery_kind || "").trim();
  const requestedHumanPhoto =
    deliveryKind === "requested_human_photo" ||
    Boolean((rawContent as any).requestedHumanPhoto || (rawContent as any).requested_human_photo);
  meta.contentDelivery = {
    folder: String((rawContent as any).folder || ""),
    sequence: String((rawContent as any).sequence || ""),
    stage: String((rawContent as any).stage || ""),
    fileName: String((rawContent as any).fileName || (rawContent as any).filename || att?.name || ""),
    deliveryKind,
    delivery_kind: deliveryKind,
    requestedHumanPhoto,
    requested_human_photo: requestedHumanPhoto,
  };

  return {
    role: "assistant",
    content: normalizePlatformContentMessage(message, meta),
    meta,
  };
}

function serializeMessageForBackend(m: Msg, opts?: { forSummary?: boolean }): Record<string, any> {
  const role = m.role;
  const meta: any = m.meta || {};
  let content = String(m.content || "");
  const isPlatformContent = Boolean(meta?.contentDelivery) || isPlatformContentPlaceholderText(content);

  if (isPlatformContent) {
    // Always send the stable placeholder with filename so the backend can preserve the delivered file name
    // without exposing raw /content or /human-photo URLs or re-feeding the descriptive delivery line into model context.
    content = Boolean(meta?.contentDelivery) ? platformContentPlaceholder(content, meta) : content.trim();
    return { role, content };
  }

  const translationMeta = buildTranslationMeta(
    meta?.translation || {
      displayText: meta?.displayText || meta?.display_text || content,
      nativeText: meta?.nativeText || meta?.native_text || content,
      englishText: meta?.englishText || meta?.english_text || "",
      userLanguageCode: meta?.userLanguageCode || meta?.user_language_code || "",
      userLanguageName: meta?.userLanguageName || meta?.user_language_name || "",
    },
    content,
  );

  let displayContent = String(
    translationMeta?.displayText || translationMeta?.nativeText || content || ""
  ).trim();
  let englishContent = String(
    translationMeta?.englishText || meta?.englishText || meta?.english_text || ""
  ).trim();

  const att = meta?.attachment;
  if (att?.url) {
    const name = att.name || "attachment";
    const attachmentBlock = `Attachment: ${name}
${att.url}`;
    displayContent = `${displayContent}${displayContent ? "\n\n" : ""}${attachmentBlock}`;
    englishContent = `${englishContent}${englishContent ? "\n\n" : ""}${attachmentBlock}`;
  }

  const out: Record<string, any> = {
    role,
    content: englishContent || displayContent || content,
    display_content: displayContent || content,
    original_content: displayContent || content,
  };

  if (englishContent) {
    out.english_content = englishContent;
  }

  if (translationMeta) {
    out.translation = {
      display_text: String(translationMeta.displayText || displayContent || content || "").trim(),
      native_text: String(translationMeta.nativeText || translationMeta.displayText || displayContent || content || "").trim(),
      english_text: String(translationMeta.englishText || englishContent || "").trim(),
      user_language_code: String(translationMeta.userLanguageCode || "").trim(),
      user_language_name: String(
        translationMeta.userLanguageName || languageNameFromCode(translationMeta.userLanguageCode || "")
      ).trim(),
    };
  }

  return out;
}


function buildContentAssistantMsgs(rawPayload: any): Msg[] {
  const visit = (node: any): any[] => {
    if (!node || typeof node !== "object") return [];

    const directBatch = (node as any).content_batch ?? (node as any).contentBatch ?? (node as any).items;
    if (Array.isArray(directBatch)) {
      return directBatch.filter((item) => item && typeof item === "object");
    }

    const directSingle = buildContentAssistantMsg(node);
    if (directSingle) return [node];

    if ((node as any).content && typeof (node as any).content === "object") {
      return visit((node as any).content);
    }

    return [];
  };

  const raws = visit(rawPayload);
  const out: Msg[] = [];
  for (const raw of raws) {
    const msg = buildContentAssistantMsg(raw);
    if (msg) out.push(msg);
  }
  return out;
}

function normalizeShortAssistantDeliveryText(value: any): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
}

function toWsBaseUrl(httpBase: string): string {
  const raw = String(httpBase || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    // Ensure no trailing slash so path joins are predictable.
    return u.toString().replace(/\/$/, '');
  } catch (e) {
    // Fallback for relative/incomplete bases
    if (raw.startsWith('https://')) return 'wss://' + raw.slice('https://'.length).replace(/\/$/, '');
    if (raw.startsWith('http://')) return 'ws://' + raw.slice('http://'.length).replace(/\/$/, '');
    return raw.replace(/\/$/, '');
  }
}

function buildWsUrl(httpBase: string, path: string, query: Record<string, string>): string {
  const base = toWsBaseUrl(httpBase);
  const p = String(path || '').startsWith('/') ? String(path || '') : '/' + String(path || '');
  const u = new URL(base + p);
  Object.entries(query || {}).forEach(([k, v]) => {
    const vv = String(v ?? '').trim();
    if (vv) u.searchParams.set(k, vv);
  });
  return u.toString();
}

type DidAvatarMedia = {
  didAgentId: string;
  didClientKey: string;
  elevenVoiceId: string;
};

const ELEVEN_VOICE_ID_BY_AVATAR: Record<string, string> = {
  "Jennifer": "19STyYD15bswVz51nqLf",
  "Jason": "j0jBf06B5YHDbCWVmlmr",
  "Tonya": "Hybl6rg76ZOcgqZqN5WN",
  "Darnell": "gYr8yTP0q4RkX1HnzQfX",
  "Michelle": "ui11Rd52NKH2DbWlcbvw",
  "Daniel": "tcO8jJ1XXzdQ4pzViV9c",
  "Veronica": "GDzHdQOi6jjf8zaXhCYD",
  "Ricardo": "l1zE9xgNpUTaQCZzpNJa",
  "Linda": "flHkNRp1BlvT73UL6gyz",
  "Robert": "uA0L9FxeLpzlG615Ueay",
  "Patricia": "zwbQ2XUiIlOKD6b3JWXd",
  "Clarence": "CXAc4DNZL6wonQQNlNgZ",
  "Mei": "bQQWtYx9EodAqMdkrNAc",
  "Minh": "cALE2CwoMM2QxiEdDEhv",
  "Maria": "WLjZnm4PkNmYtNCyiCq8",
  "Jose": "IP2syKL31S2JthzSSfZH",
  "Ashley": "GbDIo39THauInuigCmPM",
  "Ryan": "qIT7IrVUa21IEiKE1lug",
  "Latoya": "BZgkqPqms7Kj9ulSkVzn",
  "Jamal": "3w1kUvxu1LioQcLgp1KY",
  "Tiffany": "XeomjLZoU5rr4yNIg16w",
  "Kevin": "69Na567Zr0bPvmBYuGdc",
  "Adriana": "FGLJyeekUzxl8M3CTG9M",
  "Miguel": "dlGxemPxFMTY7iXagmOj",
  "Elara": "rJ9XoWu8gbUhVKZnKY8X",
};

function getElevenVoiceIdForAvatar(avatarName: string | null | undefined): string {
  const raw = (avatarName || "").trim();
  if (raw && ELEVEN_VOICE_ID_BY_AVATAR[raw]) return ELEVEN_VOICE_ID_BY_AVATAR[raw];

  const firstToken = raw.split("-")[0]?.trim() || "";
  if (firstToken && ELEVEN_VOICE_ID_BY_AVATAR[firstToken]) return ELEVEN_VOICE_ID_BY_AVATAR[firstToken];

  const ciKey = Object.keys(ELEVEN_VOICE_ID_BY_AVATAR).find(
    (k) => k.toLowerCase() === raw.toLowerCase() || (firstToken && k.toLowerCase() === firstToken.toLowerCase())
  );
  if (ciKey) return ELEVEN_VOICE_ID_BY_AVATAR[ciKey];

  return ELEVEN_VOICE_ID_BY_AVATAR["Elara"] || "";
}

function getDidAvatarMediaFromMapping(mapping: CompanionMappingRow | null, companionKeyOrName: string | null | undefined): DidAvatarMedia | null {
  const row: any = mapping || {};
  const didAgentId = String(row.didAgentId || row.did_agent_id || "").trim();
  const didClientKey = String(row.didClientKey || row.did_client_key || "").trim();
  if (!didAgentId || !didClientKey) return null;
  const elevenVoiceId = String(row.elevenVoiceId || row.eleven_voice_id || "").trim() || getElevenVoiceIdForAvatar(companionKeyOrName);
  return { didAgentId, didClientKey, elevenVoiceId };
}

function isDidSessionError(err: any): boolean {
  const kind = typeof err?.kind === "string" ? err.kind : "";
  const description = typeof err?.description === "string" ? err.description : "";
  const message = typeof err?.message === "string" ? err.message : "";

  // The SDK sometimes uses { kind, description } and sometimes uses message strings.
  return (
    kind === "SessionError" ||
    description.toLowerCase().includes("session_id") ||
    message.toLowerCase().includes("session_id")
  );
}

function formatDidError(err: any): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err?.message === "string") return err.message;

  const kind = typeof err?.kind === "string" ? err.kind : undefined;
  const description = typeof err?.description === "string" ? err.description : undefined;

  if (kind || description) {
    return JSON.stringify({ kind, description });
  }

  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

const UPGRADE_URL = process.env.NEXT_PUBLIC_UPGRADE_URL || "https://www.elaralo.com/pricing-plans/list";
const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || "";

const MODE_LABELS: Record<Mode, string> = {
  friend: "Intro",
  romantic: "Mate",
  intimate: "Mature",
};

function sanitizePublicModeLabelsText(value: any): string {
  let body = String(value ?? "");
  if (!body) return body;

  const replacements: Array<[RegExp, string]> = [
    [/\bfriend\s+mode\b/gi, "Intro mode"],
    [/\bfriendly\s+mode\b/gi, "Intro mode"],
    [/\bromantic\s+mode\b/gi, "Mate mode"],
    [/\bromance\s+mode\b/gi, "Mate mode"],
    [/\bintimate\s*(?:\(\s*18\+\s*\))?\s+mode\b/gi, "Mature mode"],
    [/\bexplicit\s+mode\b/gi, "Mature mode"],
    [/\badult\s+mode\b/gi, "Mature mode"],
  ];

  for (const [rx, replacement] of replacements) {
    body = body.replace(rx, replacement);
  }

  return body;
}

// Plan → mode availability mapping (UI pills)
// Public labels shown in the UI:
// - Intro  = internal friend
// - Mate   = internal romantic
// - Mature = internal intimate
// DulceMoon current public plans:
// - Free Trial -> Intro + Mate only; Mature is excluded
// - Discover / Explore / Encounter -> Intro + Mate + Mature
// Legacy Intro/Mate/Intimate plan names are retained as hidden/backward-compatible aliases.
const ROMANTIC_ALLOWED_PLANS: PlanName[] = [
  "Trial",
  "Discover",
  "Explore",
  "Encounter",
  "Friend",
  "Premium",
  "Elite",
  "Romantic",
  "Supreme",
  "Ultimate",
  "Intimate",
  "Exclusive",
  "Mature",
  "Pay as You Go",
  "Test - Discover",
  "Test - Explore",
  "Test - Encounter",
  "Test - Friend",
  "Test - Premium",
  "Test - Elite",
  "Test - Romantic",
  "Test - Supreme",
  "Test - Ultimate",
  "Test - Intimate",
  "Test - Exclusive",
  "Test - Mature",
  "Test - Pay as You Go",
];

const MATURE_ALLOWED_PLANS: PlanName[] = [
  "Discover",
  "Explore",
  "Encounter",
  "Premium",
  "Elite",
  "Supreme",
  "Ultimate",
  "Intimate",
  "Exclusive",
  "Mature",
  "Pay as You Go",
  "Test - Discover",
  "Test - Explore",
  "Test - Encounter",
  "Test - Premium",
  "Test - Elite",
  "Test - Supreme",
  "Test - Ultimate",
  "Test - Intimate",
  "Test - Exclusive",
  "Test - Mature",
  "Test - Pay as You Go",
];

function allowedModesForPlan(planName: PlanName): Mode[] {
  const modes: Mode[] = ["friend"];
  if (ROMANTIC_ALLOWED_PLANS.includes(planName)) modes.push("romantic");
  if (MATURE_ALLOWED_PLANS.includes(planName)) modes.push("intimate");
  return modes;
}

// White-label support:
// The companion page provides an Elaralo entitlement plan name via RebrandingKey.elaraloPlanMap.
// That plan name determines how many Mode pills are available:
//   Intro  -> [Intro]
//   Mate   -> [Intro, Mate]
//   Mature -> [Intro, Mate, Mature]
// We keep a fallback to the legacy PlanName mapping when elaraloPlanMap is missing/unknown.
function allowedModesFromElaraloPlanMap(rawPlanMap: unknown, fallbackPlan: PlanName): Mode[] {
  const topMode = modeFromElaraloPlanMap(rawPlanMap);
  if (topMode === "intimate") return ["friend", "romantic", "intimate"];
  if (topMode === "romantic") return ["friend", "romantic"];
  if (topMode === "friend") return ["friend"];
  return allowedModesForPlan(fallbackPlan);
}

function clampAllowedModesForIdentity(memberId: string, modes: Mode[]): Mode[] {
  const mid = String(memberId || "").trim();
  if (!mid || isAnonMemberId(mid)) return ["friend", "romantic"];
  return modes;
}

function fallbackModeForAllowedModes(modes: Mode[]): Mode {
  return modes.includes("romantic") ? "romantic" : "friend";
}

const INTIMATE_CONSENT_STORAGE_PREFIX = "ELARALO_INTIMATE_CONSENT::";

function intimateConsentMemberKey(memberId: string): string {
  return String(memberId || "").trim().toLowerCase().replace(/\s+/g, "");
}

function intimateConsentStorageKey(memberId: string): string {
  const key = intimateConsentMemberKey(memberId);
  return `${INTIMATE_CONSENT_STORAGE_PREFIX}${key}`;
}

function readStoredIntimateConsent(memberId: string): boolean {
  const key = intimateConsentMemberKey(memberId);
  if (!key || isAnonMemberId(key)) return false;
  if (typeof window === "undefined") return false;
  try {
    const raw = String(window.localStorage.getItem(intimateConsentStorageKey(key)) || "").trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.granted === true);
  } catch {
    try {
      return String(window.localStorage.getItem(intimateConsentStorageKey(key)) || "").trim() === "1";
    } catch {
      return false;
    }
  }
}

function writeStoredIntimateConsent(memberId: string, payload?: Record<string, any>): void {
  const key = intimateConsentMemberKey(memberId);
  if (!key || isAnonMemberId(key)) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      intimateConsentStorageKey(key),
      JSON.stringify({
        granted: true,
        memberId: String(memberId || "").trim(),
        grantedAt: Date.now(),
        ...(payload || {}),
      }),
    );
  } catch {
    // localStorage can be blocked in some iframe contexts. Backend persistence still applies.
  }
}

function stripExt(s: string) {
  return (s || "").replace(/\.(png|jpg|jpeg|webp)$/i, "");
}

function normalizeKeyForFile(raw: string) {
  return (raw || "").trim().replace(/\s+/g, "-");
}

// Some Wix implementations append a member UUID to the companion key for uniqueness.
// Example: "dulce-female-black-millennials-ebf0bfb2-11b4-4638-ad3c-4909c6f810e6"
// For static asset lookup (headshots), we should strip that UUID suffix.
function stripTrailingUuid(raw: string): string {
  const s = String(raw || "").trim();
  return s.replace(
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "",
  );
}

function titleCaseToken(token: string): string {
  const lower = String(token || "").toLowerCase();
  // Common generation tokens found in your asset naming convention.
  if (lower === "genz") return "GenZ";
  if (lower === "genx") return "GenX";
  if (lower === "geny") return "GenY";
  if (lower === "genalpha") return "GenAlpha";
  if (!lower) return "";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function toTitleCaseHyphenated(s: string): string {
  return String(s || "")
    .split("-")
    .map((t) => titleCaseToken(t))
    .join("-");
}

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of items) {
    const s = String(v || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseCompanionMeta(raw: string): CompanionMeta {
  const cleaned = stripExt(raw || "");
  const parts = cleaned
    .split("-")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 4) {
    return {
      first: cleaned || DEFAULT_COMPANION_NAME,
      gender: "",
      ethnicity: "",
      generation: "",
      key: cleaned || DEFAULT_COMPANION_NAME,
    };
  }

  const [first, gender, ethnicity, ...rest] = parts;
  const generation = rest.join("-");

  return {
    first: first || DEFAULT_COMPANION_NAME,
    gender: gender || "",
    ethnicity: ethnicity || "",
    generation: generation || "",
    key: cleaned,
  };
}

function buildAvatarCandidates(companionKeyOrName: string, rebrandingSlug?: string) {
  const raw = stripExt(String(companionKeyOrName || "").trim());
  if (!raw) return [DEFAULT_AVATAR];

  // Build multiple name variants so headshot lookup remains robust even when:
  // - companion keys are lower-cased by Wix
  // - a member UUID suffix is appended
  const baseInputs = Array.from(
    new Set([raw, stripTrailingUuid(raw)].map((v) => String(v || "").trim()).filter(Boolean))
  );

  const encVariants: string[] = [];
  const seenEnc = new Set<string>();

  for (const baseInput of baseInputs) {
    const normalized = normalizeKeyForFile(baseInput);
    const lower = normalized.toLowerCase();
    const title = toTitleCaseHyphenated(lower);

    for (const v of [normalized, title, lower]) {
      const trimmed = String(v || "").trim();
      if (!trimmed) continue;
      const enc = encodeURIComponent(trimmed);
      if (!seenEnc.has(enc)) {
        seenEnc.add(enc);
        encVariants.push(enc);
      }
    }
  }

  const slug = String(rebrandingSlug || "").trim();
  const slugEnc = slug ? encodeURIComponent(slug) : "";

  const candidates: string[] = [];
  // Some repos store images with uppercase extensions on Windows (e.g. ".JPG"),
  // and the exported static output can be case-sensitive.
  const exts = ["jpeg", "JPEG", "jpg", "JPG", "png", "PNG", "webp", "WEBP"] as const;

  const isElaraloStaticContext = !slug || normalizeRebrandingSlug(slug) === "elaralo";

  for (const enc of encVariants) {
    // Elaralo AI companion images now live on the API/Linux filesystem.
    // Try this API-served path before static-app fallbacks so Connect does
    // not lose the working headshot while probing unavailable frontend paths.
    if (API_BASE_TRIM && isElaraloStaticContext) {
      const apiBase = `${API_BASE_TRIM}/brand/elaralo/companion/ai/${enc}`;
      candidates.push(apiBase);
      for (const ext of exts) candidates.push(`${apiBase}.${ext}`);
    }
    // Rebrand-specific headshots (preferred when RebrandingKey is present):
    //   /rebranding/<brand>/companion/headshot/<CompanionName>[.<ext>]
    if (slugEnc) {
      const rebrandBase = joinUrlPrefix(
        APP_BASE_PATH,
        `${REBRANDING_PUBLIC_DIR}/${slugEnc}${HEADSHOT_DIR}/${enc}`
      );

      // Allow extension-less filenames too (Windows may hide extensions, or assets may be committed without one).
      candidates.push(rebrandBase);

      for (const ext of exts) candidates.push(`${rebrandBase}.${ext}`);
    }

    // Default (non-rebranded) headshots:
    //   /companion/headshot/<CompanionName>[.<ext>]
    const base = joinUrlPrefix(APP_BASE_PATH, `${HEADSHOT_DIR}/${enc}`);

    // Allow extension-less filenames too.
    candidates.push(base);

    for (const ext of exts) candidates.push(`${base}.${ext}`);
  }

  candidates.push(DEFAULT_AVATAR);
  return candidates;
}

async function pickFirstExisting(urls: string[]) {
  for (const url of urls) {
    if (url === DEFAULT_AVATAR) return url;
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (res.ok) return url;
    } catch (e) {
      // ignore
    }
  }
  return DEFAULT_AVATAR;
}

// Like pickFirstExisting (HEAD probe), but validates by actually loading the image in the browser.
// This avoids false positives on platforms that rewrite missing assets to index.html (HTTP 200).
function pickFirstLoadableImage(urls: string[]): Promise<string> {
  return new Promise((resolve) => {
    let i = 0;

    const tryNext = () => {
      if (i >= urls.length) return resolve(DEFAULT_AVATAR);

      const url = String(urls[i++] || "").trim();
      if (!url) return tryNext();
      if (url === DEFAULT_AVATAR) return resolve(DEFAULT_AVATAR);

      const img = new Image();

      img.onload = () => {
        // Some hosting stacks rewrite missing assets to HTML (200) which can still trigger load.
        // Ensure the browser actually decoded an image.
        if ((img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0) return resolve(url);
        return tryNext();
      };
      img.onerror = () => tryNext();

      // Cache-busting probe so newly-added logos are discovered immediately after deployment.
      const bust = `__probe=${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const probeUrl = url.includes("?") ? `${url}&${bust}` : `${url}?${bust}`;
      img.src = probeUrl;
    };

    tryNext();
  });
}

function greetingFor(name: string) {
  const n = (name || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
  return `Hi, ${n} here. 😊 What's on your mind?`;
}

function greetingForSpeech(name: string) {
  const n = (name || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
  // Spoken-only variant: some iOS/Safari + TTS combinations collapse "Hi, <name>"
  // into one phrase. Use a sentence break for the first spoken greeting while
  // keeping the visible chat greeting unchanged.
  return `Hi. ${n} here. 😊 What's on your mind?`;
}

function isAllowedOrigin(origin: string) {
  try {
    const u = new URL(origin);
    const hostRaw = u.hostname.toLowerCase();
    const host = hostRaw.startsWith("www.") ? hostRaw.slice(4) : hostRaw;

    // First-party + Wix domains (Editor/Studio/Preview).
    if (host.endsWith("elaralo.com")) return true;
    if (host.endsWith("wix.com")) return true;
    if (host.endsWith("wixsite.com")) return true;

    // White-label custom domains:
    // In an iframe, Wix will postMessage from the parent page origin (e.g. https://www.dulcemoon.net).
    // Allow the *embedding page* origin by matching document.referrer (and tolerating www vs non-www).
    try {
      const ref = typeof document !== "undefined" ? document.referrer : "";
      if (ref) {
        const refHostRaw = new URL(ref).hostname.toLowerCase();
        const refHost = refHostRaw.startsWith("www.") ? refHostRaw.slice(4) : refHostRaw;

        if (host === refHost) return true;
        if (host.endsWith("." + refHost)) return true; // subdomain match
        if (refHost.endsWith("." + host)) return true; // inverse (defensive)
      }
    } catch (e) {
      // ignore referrer parse issues
    }

    // Chrome-only fallback (helps in some embedded contexts)
    try {
      const ancestorOrigins = (typeof window !== "undefined" ? (window.location as any).ancestorOrigins : null) as
        | { length: number; [idx: number]: string }
        | null;
      if (ancestorOrigins && typeof ancestorOrigins.length === "number") {
        for (let i = 0; i < ancestorOrigins.length; i++) {
          try {
            const aHostRaw = new URL(ancestorOrigins[i]).hostname.toLowerCase();
            const aHost = aHostRaw.startsWith("www.") ? aHostRaw.slice(4) : aHostRaw;
            if (host === aHost) return true;
            if (host.endsWith("." + aHost)) return true;
            if (aHost.endsWith("." + host)) return true;
          } catch (e) {
            // ignore per-origin parse issues
          }
        }
      }
    } catch (e) {
      // ignore ancestorOrigins issues
    }

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Detects a mode switch request in *user text* and returns:
 * - mode: desired mode
 * - cleaned: text with explicit [mode:*] removed (so it won't pollute the chat)
 *
 * Supports public labels and legacy labels:
 * - [mode:mate], mode:mate, [mode:romantic], mode:romantic
 * - "switch to mate", "mate mode", "set mode to mature", etc.
 */
function detectModeSwitchAndClean(text: string): { mode: Mode | null; cleaned: string } {
  const raw = text || "";
  const t = raw.toLowerCase();

  // explicit tokens
  // NOTE: allow legacy tokens from older builds as synonyms for the public labels.
  const tokenRe =
    /\[mode:(intro|friend|mate|romantic|romance|mature|intimate|explicit)\]|mode:(intro|friend|mate|romantic|romance|mature|intimate|explicit)/gi;

  let tokenMode: Mode | null = null;
  let cleaned = raw.replace(tokenRe, (m) => {
    const mm = m.toLowerCase();
    if (mm.includes("intro") || mm.includes("friend")) tokenMode = "friend";
    else if (mm.includes("mate") || mm.includes("romantic") || mm.includes("romance")) tokenMode = "romantic";
    else if (mm.includes("mature") || mm.includes("intimate") || mm.includes("explicit")) tokenMode = "intimate";
    return "";
  });

  cleaned = cleaned.trim();

  if (tokenMode) return { mode: tokenMode, cleaned };

  // soft phrasing (supports both public labels and legacy labels)
  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back|change|move|make|put)\b.*\b(intro|friend)\b/.test(soft) ||
    /\b(intro|friend) mode\b/.test(soft);

  const wantsRomantic =
    // "mate mode" / legacy "romantic mode" / "romance mode"
    /\b(mate|romantic|romance) mode\b/.test(soft) ||
    // switch/set/back/go/turn ... mate/romantic
    /\b(switch|set|turn|go|back|change|move|make|put)\b.*\b(mate|romantic|romance)\b/.test(soft) ||
    // natural phrasing users actually type
    /\b(let['’]?s|lets)\b.*\b(mate|romantic|romance)\b/.test(soft) ||
    /\b(be|being|try|trying|have|having)\b.*\b(mate|romantic|romance)\b/.test(soft) ||
    /\b(mate|romantic) conversation\b/.test(soft) ||
    /\bromance again\b/.test(soft) ||
    /\btry romance again\b/.test(soft);

  const wantsIntimate =
    /\b(switch|set|turn|go|back|change|move|make|put)\b.*\b(mature|intimate|explicit|adult|18\+)\b/.test(soft) ||
    /\b(mature|intimate|explicit) mode\b/.test(soft);

  if (wantsFriend) return { mode: "friend", cleaned: raw };
  if (wantsRomantic) return { mode: "romantic", cleaned: raw };
  if (wantsIntimate) return { mode: "intimate", cleaned: raw };

  return { mode: null, cleaned: raw.trim() };
}

function normalizeMode(raw: any): Mode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;

  if (t === "friend") return "friend";
  if (t === "romantic" || t === "romance") return "romantic";
  if (t === "intimate" || t === "explicit" || t === "adult" || t === "18+" || t === "18") return "intimate";

  return null;
}



/**
 * Stream viewer stage (subscribe-only): shows the host's LiveKit video full-size.
 * We avoid the full VideoConference UI for viewers in "stream" sessions to keep the UX simple
 * and to prevent viewer-side publish controls from appearing.
 */
function LiveKitStreamViewerStage() {
  const allTracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: false,
  });

  const remoteTracks = allTracks.filter((t) => !t.participant.isLocal);
  const hostTracks = remoteTracks.filter((t) =>
    String((t.participant as any)?.identity || "").startsWith("host:")
  );

  const tracksToShow = hostTracks.length ? hostTracks : remoteTracks;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <RoomAudioRenderer />
      <StartAudio label="Click to enable audio" />

      {tracksToShow.length ? (
        <GridLayout tracks={tracksToShow} style={{ height: "100%" }}>
          <ParticipantTile />
        </GridLayout>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            background: "rgba(0,0,0,0.6)",
            borderRadius: 18,
            padding: 24,
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          Waiting for the host video…
        </div>
      )}
    </div>
  );
}

/**
 * Private conference stage (interactive):
 *  - split: show both participants side-by-side
 *  - focus: show only the *other* participant full-frame
 */
function LiveKitPrivateConferenceStage(props: { viewMode: "split" | "focus" }) {
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );

  const remoteCameraTracks = cameraTracks.filter((t) => !t.participant.isLocal);

  const tracksToShow =
    props.viewMode === "focus" ? (remoteCameraTracks.length ? [remoteCameraTracks[0]] : []) : cameraTracks;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <RoomAudioRenderer />

      {tracksToShow.length ? (
        <GridLayout tracks={tracksToShow} style={{ height: "100%" }}>
          <ParticipantTile />
        </GridLayout>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            background: "rgba(0,0,0,0.6)",
            borderRadius: 18,
            padding: 24,
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          Waiting for the other participant video…
        </div>
      )}
    </div>
  );
}


function LiveKitAutoPublish(props: {
  enabled: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  onError?: (msg: string) => void;
}) {
  const room = useRoomContext();
  const [roomConnected, setRoomConnected] = useState<boolean>(false);
  const lastRef = useRef<{ mic?: boolean; cam?: boolean }>({});

  // Track connection state so mic/camera toggles reliably apply on the FIRST session.
  // In some iframe/browser combos, calling setMicrophoneEnabled/setCameraEnabled before the
  // Room is connected can throw, and if we "remember" the desired state too early we won't retry.
  useEffect(() => {
    const isConnectedNow = () => String((room as any)?.state ?? "").toLowerCase() === "connected";

    const handleConnected = () => {
      // Force a re-apply of mic/cam on every connect/reconnect.
      lastRef.current = {};
      setRoomConnected(true);
    };
    const handleDisconnected = () => {
      setRoomConnected(false);
    };

    setRoomConnected(isConnectedNow());

    try {
      (room as any).on?.(RoomEvent.Connected, handleConnected);
      (room as any).on?.(RoomEvent.Disconnected, handleDisconnected);
      (room as any).on?.(RoomEvent.Reconnecting, handleDisconnected);
      (room as any).on?.(RoomEvent.Reconnected, handleConnected);
    } catch {
      // no-op
    }

    return () => {
      try {
        (room as any).off?.(RoomEvent.Connected, handleConnected);
        (room as any).off?.(RoomEvent.Disconnected, handleDisconnected);
        (room as any).off?.(RoomEvent.Reconnecting, handleDisconnected);
        (room as any).off?.(RoomEvent.Reconnected, handleConnected);
      } catch {
        // no-op
      }
    };
  }, [room]);

  useEffect(() => {
    if (!props.enabled) return;
    if (!roomConnected) return;
    const lp: any = (room as any)?.localParticipant;
    if (!lp) return;
    const desiredMic = Boolean(props.micEnabled);
    if (lastRef.current.mic === desiredMic) return;
    Promise.resolve(lp.setMicrophoneEnabled(desiredMic))
      .then(() => {
        lastRef.current.mic = desiredMic;
      })
      .catch((err: any) => {
        props.onError?.(`Microphone error: ${String(err?.message || err)}`);
      });
  }, [room, roomConnected, props.enabled, props.micEnabled, props.onError]);

  useEffect(() => {
    if (!props.enabled) return;
    if (!roomConnected) return;
    const lp: any = (room as any)?.localParticipant;
    if (!lp) return;
    const desiredCam = Boolean(props.cameraEnabled);
    if (lastRef.current.cam === desiredCam) return;
    Promise.resolve(lp.setCameraEnabled(desiredCam))
      .then(() => {
        lastRef.current.cam = desiredCam;
      })
      .catch((err: any) => {
        props.onError?.(`Camera error: ${String(err?.message || err)}`);
      });
  }, [room, roomConnected, props.enabled, props.cameraEnabled, props.onError]);

  return null;
}


// Shared button style used by the small Mic/Stop controls in the LiveKit section.
const smallBtn: React.CSSProperties = {
  borderRadius: 10,
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: "16px",
  border: "1px solid rgba(0,0,0,0.18)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
};


type HOStep = "welcome" | "basics" | "photos" | "processing" | "review" | "completion" | "final_approval";

type HOGenderModel = {
  mode: "picklist" | "self_describe" | "prefer_not_to_say";
  picklist_value: string;
  custom_text: string;
  display_value?: string;
};

type HOBasicForm = {
  legal_name: string;
  stage_name: string;
  gender_model: HOGenderModel;
  birthdate: string;
  birth_city: string;
  birth_state_region: string;
  birth_country_name: string;
  birth_country_code: string;
  race_codes: string[];
  race_self_describe: string;
  ethnicity_primary_bucket: string;
  ethnicity_labels: string[];
  ethnicity_other_text: string;
};

type HOAssetRow = {
  asset_id: string;
  slot_key: string;
  original_file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number | null;
  height?: number | null;
  preview_url?: string;
  validation_status?: string;
  validation_errors?: string[];
  validation_warnings?: string[];
  required_slot?: boolean;
};

type HOSectionRow = {
  section_key: string;
  source_type?: string;
  review_status?: string;
  visibility?: string;
  payload?: any;
  provenance?: any;
};

type HOSessionEnvelope = {
  ok?: boolean;
  session_id?: string;
  status?: string;
  current_step?: string;
  latest_saved_step?: string;
  updated_at?: string;
  created_at?: string;
  display_name?: string;
  basics?: any;
  assets?: HOAssetRow[];
  sections?: HOSectionRow[];
  latest_job?: any;
  required_slots?: Array<{ slot_key: string; label: string; required: boolean }>;
  optional_slots?: Array<{ slot_key: string; label: string; required: boolean }>;
  limited_ready?: boolean;
  full_ready?: boolean;
  limited_blockers?: string[];
  full_blockers?: string[];
  taxonomy?: any;
  active_version_id?: string | null;
  input_hash?: string;
  photo_3d_opt_in?: boolean;
};

type HOReviewResponse = {
  ok?: boolean;
  session_id?: string;
  status?: string;
  sections?: HOSectionRow[];
  nationalities?: { suggested?: string[]; host_confirmed?: string[] };
  job?: any;
};

const HO_GENDER_OPTIONS = ["Woman", "Man", "Non-binary", "Another identity", "Prefer not to say"];
const HO_RACE_OPTIONS = [
  { code: "black_african_descent", label: "Black / African Descent" },
  { code: "east_asian", label: "East Asian" },
  { code: "south_asian", label: "South Asian" },
  { code: "southeast_asian", label: "Southeast Asian" },
  { code: "middle_eastern_north_african", label: "Middle Eastern / North African" },
  { code: "native_indigenous", label: "Native / Indigenous" },
  { code: "pacific_islander", label: "Pacific Islander" },
  { code: "white", label: "White" },
  { code: "another_race", label: "Another race / self-describe" },
  { code: "prefer_not_to_say", label: "Prefer not to say" },
];
const HO_ETHNICITY_BUCKETS = [
  { code: "african_african_diaspora", label: "African / African diaspora" },
  { code: "arab_middle_eastern", label: "Arab / Middle Eastern" },
  { code: "caribbean", label: "Caribbean" },
  { code: "central_asian", label: "Central Asian" },
  { code: "east_asian", label: "East Asian" },
  { code: "european", label: "European" },
  { code: "hispanic_latino", label: "Hispanic / Latino / Latina / Latine" },
  { code: "indigenous", label: "Indigenous" },
  { code: "jewish", label: "Jewish" },
  { code: "north_african", label: "North African" },
  { code: "pacific_islander", label: "Pacific Islander" },
  { code: "south_asian", label: "South Asian" },
  { code: "southeast_asian", label: "Southeast Asian" },
  { code: "mixed_multicultural", label: "Mixed / Multicultural" },
  { code: "other_self_describe", label: "Other / self-describe" },
  { code: "prefer_not_to_say", label: "Prefer not to say" },
];
const HO_ETHNICITY_LABELS = [
  "African-American / African diaspora", "Afro-Caribbean", "Arab", "Ashkenazi Jewish", "Chinese", "English",
  "Ethiopian / Eritrean", "Filipino", "French", "German", "Greek", "Haitian", "Indian",
  "Indigenous American / First Nations", "Indigenous Australian", "Irish", "Italian", "Jamaican", "Japanese",
  "Korean", "Mexican", "Mixed European", "Mixed European-American", "Nigerian", "Pakistani",
  "Persian / Iranian", "Polish", "Puerto Rican", "Scottish", "Slavic / Eastern European", "Somali",
  "Syrian / Lebanese", "Vietnamese", "West African", "Other / self-describe",
];
const HO_REQUIRED_SLOTS = [
  { slot_key: "headshot_front", label: "Headshot front", notes: "Neutral lighting. Unobstructed face. Plain or low-distraction background." },
  { slot_key: "full_body_front", label: "Full body front", notes: "Entire body visible. Straight posture. Front-facing." },
  { slot_key: "three_quarter_body", label: "Three-quarter body", notes: "Frame from roughly upper thigh or knees to head." },
  { slot_key: "angle_left_45", label: "45-degree left", notes: "Natural pose. Do not turn into a full profile." },
  { slot_key: "angle_right_45", label: "45-degree right", notes: "Natural pose. Do not turn into a full profile." },
];
const HO_OPTIONAL_SLOTS = [
  { slot_key: "left_profile", label: "Left profile" },
  { slot_key: "right_profile", label: "Right profile" },
  { slot_key: "smiling_headshot", label: "Smiling headshot" },
  { slot_key: "neutral_headshot", label: "Neutral-expression headshot" },
  { slot_key: "extra_angle", label: "Extra angle" },
];
const HO_LATER_SECTION_CONFIG: Array<{ key: string; label: string; kind: "text" | "list" | "career" | "education"; example: string }> = [
  { key: "education", label: "Education", kind: "education", example: "Example: Bachelor of Science in Marketing; University of South Carolina; 2020; consumer behavior, market research." },
  { key: "career", label: "Career", kind: "career", example: "Example: Vice President of Brand Strategy; responsibilities, achievements, and current role details." },
  { key: "likes", label: "Likes", kind: "list", example: "Example: International travel; luxury fashion; coastal living; wellness and fitness." },
  { key: "dislikes", label: "Dislikes", kind: "list", example: "Example: Dishonesty; disorganization; poor communication; broken promises." },
  { key: "hobbies", label: "Hobbies", kind: "list", example: "Example: Pilates; yoga; sailing; photography; interior design." },
  { key: "lifestyle", label: "Lifestyle", kind: "text", example: "Example: Describe routine, wellness, schedule, social cadence, and community causes." },
  { key: "background_story", label: "Background Story", kind: "text", example: "Example: Tell the longer-form story of upbringing, education, career path, and milestones." },
  { key: "core_values", label: "Core Values", kind: "list", example: "Example: Excellence; integrity; discipline; loyalty; professionalism." },
  { key: "personal_motto", label: "Personal Motto", kind: "text", example: "Example: Excellence with intention." },
];

const HO_CARD: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.12)",
  borderRadius: 18,
  background: "#fff",
  boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
};
const HO_INPUT: React.CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,0.16)",
  padding: "12px 14px",
  fontSize: 14,
  outline: "none",
  background: "#fff",
};
const HO_TEXTAREA: React.CSSProperties = {
  ...HO_INPUT,
  minHeight: 132,
  resize: "vertical",
  fontFamily: "inherit",
};
const HO_BTN_PRIMARY: React.CSSProperties = {
  borderRadius: 12,
  padding: "12px 18px",
  fontSize: 14,
  fontWeight: 700,
  border: "1px solid #111",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};
const HO_BTN_SECONDARY: React.CSSProperties = {
  borderRadius: 12,
  padding: "12px 18px",
  fontSize: 14,
  fontWeight: 700,
  border: "1px solid rgba(0,0,0,0.18)",
  background: "#fff",
  color: "#111",
  cursor: "pointer",
};
const HO_BADGE = (bg: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 700,
  background: bg,
});

function hoReadQueryIdentity() {
  if (typeof window === "undefined") {
    return { memberId: "", brand: "", avatar: "", displayName: "", loggedIn: false };
  }
  try {
    const u = new URL(window.location.href);
    const memberId = String(u.searchParams.get("memberId") || u.searchParams.get("member_id") || "").trim();
    const brand = String(u.searchParams.get("brand") || u.searchParams.get("rebranding") || "").trim() || "Elaralo";
    const avatar = String(u.searchParams.get("avatar") || u.searchParams.get("companion") || "").trim();
    const displayName = String(u.searchParams.get("displayName") || u.searchParams.get("display_name") || u.searchParams.get("user_name") || "").trim();
    const loggedInRaw = String(u.searchParams.get("loggedIn") || u.searchParams.get("logged_in") || "").trim().toLowerCase();
    const loggedIn = loggedInRaw === "1" || loggedInRaw === "true" || Boolean(memberId);
    return { memberId, brand, avatar, displayName, loggedIn };
  } catch {
    return { memberId: "", brand: "", avatar: "", displayName: "", loggedIn: false };
  }
}

function hoShouldRenderOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const u = new URL(window.location.href);
    const q = String(u.searchParams.get("app") || u.searchParams.get("surface") || u.searchParams.get("view") || "").trim().toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    return q === "host-onboarding" || q === "host_profile_studio" || path.includes("host-onboarding") || path.includes("host-profile-studio");
  } catch {
    return false;
  }
}

function hoLooksNonEnglish(value: string): boolean {
  const txt = String(value || "");
  if (!txt.trim()) return false;
  let nonAscii = 0;
  for (const ch of txt) if (ch.charCodeAt(0) > 127) nonAscii += 1;
  return nonAscii >= Math.max(2, Math.floor(txt.length * 0.15));
}

function hoCountryCodeFromName(name: string): string {
  const s = String(name || "").trim();
  const m: Record<string, string> = {
    "United States": "US",
    "United Kingdom": "GB",
    "England": "GB",
    "Scotland": "GB",
    "Wales": "GB",
    "Ireland": "IE",
    "Canada": "CA",
    "Australia": "AU",
    "New Zealand": "NZ",
    "Jamaica": "JM",
    "Haiti": "HT",
    "Mexico": "MX",
    "France": "FR",
    "Germany": "DE",
    "Italy": "IT",
    "Spain": "ES",
    "India": "IN",
    "Pakistan": "PK",
    "Nigeria": "NG",
    "Japan": "JP",
    "South Korea": "KR",
    "China": "CN",
    "Philippines": "PH",
    "Vietnam": "VN",
    "Puerto Rico": "PR",
  };
  return m[s] || (s ? s.toUpperCase().slice(0, 2) : "");
}

function hoStepFromSession(session: HOSessionEnvelope | null): HOStep {
  const current = String(session?.current_step || session?.latest_saved_step || "welcome").trim().toLowerCase();
  if (current === "basics") return "basics";
  if (current === "photos") return "photos";
  if (current === "processing") return "processing";
  if (current === "review") return "review";
  if (current === "completion") return "completion";
  if (current === "final_approval") return "final_approval";
  if (String(session?.status || "") === "approved") return "final_approval";
  return "welcome";
}

function hoNormalizedPreviewUrl(raw: string, identity: { memberId: string; brand: string; avatar: string }): string {
  const url = String(raw || "").trim();
  if (!url) return "";
  if (!url.startsWith("/host-onboarding/assets/")) return url;
  try {
    const u = new URL(url, window.location.origin);
    if (identity.memberId) u.searchParams.set("member_id", identity.memberId);
    if (identity.brand) u.searchParams.set("brand", identity.brand);
    if (identity.avatar) u.searchParams.set("avatar", identity.avatar);
    return u.toString();
  } catch {
    return url;
  }
}

function HostOnboardingApp() {
  const identitySeed = useMemo(() => hoReadQueryIdentity(), []);
  const [identity, setIdentity] = useState(identitySeed);
  const [handoffReady, setHandoffReady] = useState(Boolean(identitySeed.memberId));
  const [session, setSession] = useState<HOSessionEnvelope | null>(null);
  const [step, setStep] = useState<HOStep>("welcome");
  const [loading, setLoading] = useState<boolean>(false);
  const [screenError, setScreenError] = useState<string>("");
  const [saveNotice, setSaveNotice] = useState<string>("");
  const [basicWarnings, setBasicWarnings] = useState<string[]>([]);
  const [basicErrors, setBasicErrors] = useState<Record<string, string>>({});
  const [reviewData, setReviewData] = useState<HOSectionRow[]>([]);
  const [nationalityDraft, setNationalityDraft] = useState<string[]>([]);
  const [previewModel, setPreviewModel] = useState<any>(null);
  const [approvalResult, setApprovalResult] = useState<any>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string>("");
  const [deriveRequested, setDeriveRequested] = useState<boolean>(false);
  const [laterSections, setLaterSections] = useState<Record<string, any>>({});
  const [completionStatus, setCompletionStatus] = useState<Record<string, string>>({});
  const [basicForm, setBasicForm] = useState<HOBasicForm>({
    legal_name: "",
    stage_name: "",
    gender_model: { mode: "picklist", picklist_value: "Woman", custom_text: "", display_value: "Woman" },
    birthdate: "",
    birth_city: "",
    birth_state_region: "",
    birth_country_name: "",
    birth_country_code: "",
    race_codes: [],
    race_self_describe: "",
    ethnicity_primary_bucket: "",
    ethnicity_labels: [],
    ethnicity_other_text: "",
  });

  const assetsBySlot = useMemo(() => {
    const out: Record<string, HOAssetRow> = {};
    for (const a of session?.assets || []) {
      const slotKey = String(a?.slot_key || "").trim();
      if (slotKey) out[slotKey] = a;
    }
    return out;
  }, [session?.assets]);

  const sessionId = String(session?.session_id || "").trim();
  const lastSaved = String(session?.updated_at || "").trim();
  const photo3dOptIn = Boolean(session?.photo_3d_opt_in === true);
  const requiredAcceptedCount = useMemo(() => HO_REQUIRED_SLOTS.filter((slot) => String(assetsBySlot[slot.slot_key]?.validation_status || "") === "accepted").length, [assetsBySlot]);
  const canContinuePhotos = requiredAcceptedCount === HO_REQUIRED_SLOTS.length;

  const postRequestMemberPlan = useCallback((reason: string) => {
    if (typeof window === "undefined") return;
    const msgObj = { type: "REQUEST_MEMBER_PLAN", _reason: reason, _sentAt: new Date().toISOString() };
    const payloads: any[] = [msgObj, JSON.stringify(msgObj)];
    const targets: Window[] = [];
    try {
      if (window.parent && window.parent !== window) targets.push(window.parent);
    } catch {}
    try {
      if (window.top && window.top !== window && !targets.includes(window.top)) targets.push(window.top);
    } catch {}
    for (const target of targets) {
      for (const p of payloads) {
        try { target.postMessage(p, "*"); } catch {}
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyPayload = (incoming: any) => {
      const data = typeof incoming === "string" ? (() => { try { return JSON.parse(incoming); } catch { return null; } })() : incoming;
      if (!data || typeof data !== "object") return;
      const type = String((data as any).type || "").trim();
      if (type !== "MEMBER_PLAN") return;
      const memberId = String((data as any).memberId || (data as any).member_id || "").trim();
      const brand = String((data as any).brand || (data as any).rebranding || "").trim();
      const avatar = String((data as any).avatar || (data as any).companion || (data as any).companionName || "").trim();
      const displayName = String((data as any).displayName || (data as any).display_name || (data as any).userName || (data as any).user_name || "").trim();
      const loggedIn = Boolean((data as any).loggedIn === true || (data as any).logged_in === true || memberId);
      setIdentity((prev) => ({
        memberId: memberId || prev.memberId,
        brand: brand || prev.brand,
        avatar: avatar || prev.avatar,
        displayName: displayName || prev.displayName,
        loggedIn: loggedIn || prev.loggedIn,
      }));
      if (memberId) setHandoffReady(true);
    };
    const onMessage = (ev: MessageEvent) => applyPayload(ev.data);
    window.addEventListener("message", onMessage);
    postRequestMemberPlan("host-onboarding-init");
    const onFocus = () => postRequestMemberPlan("host-onboarding-focus");
    const onVisibility = () => { if (document.visibilityState === "visible") postRequestMemberPlan("host-onboarding-visible"); };
    const onPageShow = () => postRequestMemberPlan("host-onboarding-pageshow");
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [postRequestMemberPlan]);

  const syncSession = useCallback((payload: HOSessionEnvelope | null | undefined) => {
    if (!payload || typeof payload !== "object") return;
    setSession(payload);
    setStep(hoStepFromSession(payload));
    const basics = (payload as any).basics || {};
    setBasicForm((prev) => ({
      ...prev,
      legal_name: String(basics.legal_name || prev.legal_name || "").trim(),
      stage_name: String(basics.stage_name || prev.stage_name || identity.displayName || "").trim(),
      gender_model: {
        mode: String((basics.gender_model || prev.gender_model || {}).mode || prev.gender_model.mode || "picklist") as any,
        picklist_value: String((basics.gender_model || prev.gender_model || {}).picklist_value || prev.gender_model.picklist_value || "Woman"),
        custom_text: String((basics.gender_model || prev.gender_model || {}).custom_text || prev.gender_model.custom_text || ""),
        display_value: String((basics.gender_model || prev.gender_model || {}).display_value || prev.gender_model.display_value || "Woman"),
      },
      birthdate: String(basics.birthdate || prev.birthdate || ""),
      birth_city: String(basics.birth_city || prev.birth_city || ""),
      birth_state_region: String(basics.birth_state_region || prev.birth_state_region || ""),
      birth_country_name: String(((basics.birth_country || {}).name) || prev.birth_country_name || ""),
      birth_country_code: String(((basics.birth_country || {}).code) || prev.birth_country_code || ""),
      race_codes: Array.isArray(basics.race_codes) ? basics.race_codes.map((x: any) => String(x || "").trim()).filter(Boolean) : prev.race_codes,
      race_self_describe: String(basics.race_self_describe || prev.race_self_describe || ""),
      ethnicity_primary_bucket: String(basics.ethnicity_primary_bucket || prev.ethnicity_primary_bucket || ""),
      ethnicity_labels: Array.isArray(basics.ethnicity_labels) ? basics.ethnicity_labels.map((x: any) => String(x || "").trim()).filter(Boolean) : prev.ethnicity_labels,
      ethnicity_other_text: String(basics.ethnicity_other_text || prev.ethnicity_other_text || ""),
    }));
    const sectionMap: Record<string, any> = {};
    const statusMap: Record<string, string> = {};
    for (const sec of (payload.sections || [])) {
      sectionMap[String(sec.section_key || "")] = sec.payload || {};
      statusMap[String(sec.section_key || "")] = String(sec.review_status || "draft");
    }
    setLaterSections((prev) => ({ ...prev, ...sectionMap }));
    setCompletionStatus((prev) => ({ ...prev, ...statusMap }));
  }, [identity.displayName]);

  const fetchSession = useCallback(async () => {
    if (!sessionId || !identity.memberId) return;
    try {
      const q = new URLSearchParams({ member_id: identity.memberId, brand: identity.brand || "", avatar: identity.avatar || "" }).toString();
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}?${q}`);
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      syncSession(data);
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to refresh onboarding session."));
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, syncSession]);

  const createOrResumeSession = useCallback(async () => {
    if (!API_BASE) {
      setScreenError("NEXT_PUBLIC_API_BASE_URL is not set.");
      return;
    }
    if (!identity.memberId) return;
    setLoading(true);
    setScreenError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          display_name: identity.displayName,
          logged_in: identity.loggedIn,
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      syncSession(data);
      setSaveNotice(data?.updated_at ? `Session loaded. Last saved ${data.updated_at}.` : "Onboarding session ready.");
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to start host onboarding."));
    } finally {
      setLoading(false);
    }
  }, [identity, syncSession]);

  useEffect(() => {
    if (identity.memberId && identity.loggedIn) createOrResumeSession();
  }, [identity.memberId, identity.loggedIn, identity.brand, identity.avatar, identity.displayName, createOrResumeSession]);

  useEffect(() => {
    if (step !== "processing" || !sessionId || !identity.memberId) return;
    if (session?.status === "awaiting_review") return;
    let cancelled = false;
    let timer: any = null;
    const ensureDerive = async () => {
      if (!deriveRequested) {
        setDeriveRequested(true);
        try {
          const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/derive`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ member_id: identity.memberId, brand: identity.brand, avatar: identity.avatar }),
          });
          const data = await res.json().catch(() => ({} as any));
          if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
        } catch (e: any) {
          if (!cancelled) setScreenError(String(e?.message || e || "Failed to start derivation."));
        }
      }
      const poll = async () => {
        if (cancelled) return;
        await fetchSession();
        const currentStatus = String(session?.status || "").trim();
        if (currentStatus === "awaiting_review") {
          if (!cancelled) setStep("review");
          return;
        }
        timer = setTimeout(poll, 1500);
      };
      timer = setTimeout(poll, 400);
    };
    ensureDerive();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, sessionId, identity.memberId, identity.brand, identity.avatar, deriveRequested, fetchSession, session?.status]);

  useEffect(() => {
    if (step !== "review" || !sessionId || !identity.memberId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const q = new URLSearchParams({ member_id: identity.memberId, brand: identity.brand || "", avatar: identity.avatar || "" }).toString();
        const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/review?${q}`);
        const data = await res.json().catch(() => ({} as any));
        if (res.status === 409) {
          setStep("processing");
          return;
        }
        if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
        if (cancelled) return;
        const sections = Array.isArray(data?.sections) ? data.sections : [];
        setReviewData(sections);
        const nat = data?.nationalities || {};
        const confirmed = Array.isArray(nat.host_confirmed) ? nat.host_confirmed : [];
        const suggested = Array.isArray(nat.suggested) ? nat.suggested : [];
        setNationalityDraft((confirmed.length ? confirmed : suggested).map((x: any) => String(x || "").trim()).filter(Boolean));
      } catch (e: any) {
        if (!cancelled) setScreenError(String(e?.message || e || "Failed to load review payload."));
      }
    };
    load();
    return () => { cancelled = true; };
  }, [step, sessionId, identity.memberId, identity.brand, identity.avatar]);

  const validateBasicsClient = useCallback(() => {
    const errs: Record<string, string> = {};
    const warns: string[] = [];
    const must = (key: keyof HOBasicForm, label: string) => {
      const value = String((basicForm as any)[key] || "").trim();
      if (!value) errs[String(key)] = `${label} is required.`;
      else if (hoLooksNonEnglish(value)) warns.push(`${label} should be entered in English for v1.`);
    };
    must("legal_name", "Legal / full name");
    must("stage_name", "Stage / public name");
    must("birthdate", "Birthdate");
    must("birth_city", "Birth city");
    must("birth_state_region", "Birth state / region");
    must("birth_country_name", "Birth country");
    if (!basicForm.race_codes.length) errs["race_codes"] = "At least one race option is required.";
    if (basicForm.race_codes.filter((x) => x !== "prefer_not_to_say").length > 3) errs["race_codes"] = "Select up to 3 race options.";
    if (basicForm.race_codes.includes("another_race") && !String(basicForm.race_self_describe || "").trim()) errs["race_self_describe"] = "Please enter a race self-description.";
    if (!basicForm.ethnicity_primary_bucket) errs["ethnicity_primary_bucket"] = "Please choose an ethnicity bucket.";
    if (basicForm.ethnicity_primary_bucket !== "prefer_not_to_say" && !basicForm.ethnicity_labels.length) errs["ethnicity_labels"] = "Select at least one heritage label.";
    if (basicForm.ethnicity_labels.includes("Other / self-describe") && !String(basicForm.ethnicity_other_text || "").trim()) errs["ethnicity_other_text"] = "Please enter an ethnicity self-description.";
    if (basicForm.gender_model.mode === "picklist" && !basicForm.gender_model.picklist_value) errs["gender_model"] = "Please choose a gender option.";
    if (basicForm.gender_model.mode === "self_describe" && !String(basicForm.gender_model.custom_text || "").trim()) errs["gender_model.custom_text"] = "Please enter a gender self-description.";
    return { errs, warns };
  }, [basicForm]);

  const saveBasics = useCallback(async (nextStep?: HOStep) => {
    if (!sessionId || !identity.memberId) return false;
    const { errs, warns } = validateBasicsClient();
    setBasicErrors(errs);
    setBasicWarnings(warns);
    if (Object.keys(errs).length) return false;
    setLoading(true);
    setScreenError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/basics`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          legal_name: basicForm.legal_name,
          stage_name: basicForm.stage_name,
          gender_model: {
            ...basicForm.gender_model,
            display_value: basicForm.gender_model.mode === "self_describe" ? basicForm.gender_model.custom_text : basicForm.gender_model.picklist_value,
          },
          birthdate: basicForm.birthdate,
          birth_city: basicForm.birth_city,
          birth_state_region: basicForm.birth_state_region,
          birth_country: { code: basicForm.birth_country_code || hoCountryCodeFromName(basicForm.birth_country_name), name: basicForm.birth_country_name },
          race_codes: basicForm.race_codes,
          race_self_describe: basicForm.race_self_describe,
          ethnicity_primary_bucket: basicForm.ethnicity_primary_bucket,
          ethnicity_labels: basicForm.ethnicity_labels,
          ethnicity_other_text: basicForm.ethnicity_other_text,
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        const errsOut: Record<string, string> = {};
        for (const err of Array.isArray(data?.errors) ? data.errors : []) errsOut[String(err?.field || "form")] = String(err?.message || "Invalid input.");
        if (Object.keys(errsOut).length) setBasicErrors(errsOut);
        setBasicWarnings(Array.isArray(data?.warnings) ? data.warnings.map((x: any) => String(x || "")) : warns);
        throw new Error(String((data && (data.detail || data.message)) || "Please correct the highlighted fields."));
      }
      setBasicWarnings(Array.isArray(data?.warnings) ? data.warnings.map((x: any) => String(x || "")) : warns);
      setBasicErrors({});
      syncSession(data);
      setSaveNotice("Basics saved.");
      if (nextStep) setStep(nextStep);
      return true;
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to save basics."));
      return false;
    } finally {
      setLoading(false);
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, basicForm, syncSession, validateBasicsClient]);

  const uploadPhotoForSlot = useCallback(async (slotKey: string, file: File) => {
    if (!sessionId || !identity.memberId) return;
    setUploadingSlot(slotKey);
    setScreenError("");
    try {
      const presignRes = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/photos/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          slot_key: slotKey,
          filename: file.name,
          mime_type: file.type || "application/octet-stream",
          file_size: file.size,
        }),
      });
      const presignData = await presignRes.json().catch(() => ({} as any));
      if (!presignRes.ok) throw new Error(String((presignData && (presignData.detail || presignData.message)) || `HTTP ${presignRes.status}`));
      const uploadRes = await fetch(`${API_BASE}${presignData.upload_url}`, {
        method: String(presignData.upload_method || "PUT").toUpperCase(),
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const uploadData = await uploadRes.json().catch(() => ({} as any));
      if (!uploadRes.ok) throw new Error(String((uploadData && (uploadData.detail || uploadData.message)) || `HTTP ${uploadRes.status}`));
      const commitRes = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/photos/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          asset_id: presignData.asset_id,
          slot_key: slotKey,
          photo_3d_opt_in: photo3dOptIn,
        }),
      });
      const commitData = await commitRes.json().catch(() => ({} as any));
      if (!commitRes.ok) throw new Error(String((commitData && (commitData.detail || commitData.message)) || `HTTP ${commitRes.status}`));
      syncSession(commitData);
      setSaveNotice(`${(HO_REQUIRED_SLOTS.find((s) => s.slot_key === slotKey) || HO_OPTIONAL_SLOTS.find((s) => s.slot_key === slotKey) || { label: slotKey }).label} uploaded.`);
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to upload photo."));
    } finally {
      setUploadingSlot("");
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, photo3dOptIn, syncSession]);

  const saveSection = useCallback(async (sectionKey: string, payload: any, saveMode: string, opts?: { refreshReview?: boolean; nextStep?: HOStep }) => {
    if (!sessionId || !identity.memberId) return false;
    setLoading(true);
    setScreenError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/sections/${encodeURIComponent(sectionKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          section_payload: payload,
          save_mode: saveMode,
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      setLaterSections((prev) => ({ ...prev, [sectionKey]: payload }));
      setCompletionStatus((prev) => ({ ...prev, [sectionKey]: String(data?.section?.review_status || saveMode) }));
      setPreviewModel(data);
      await fetchSession();
      if (opts?.refreshReview) {
        const q = new URLSearchParams({ member_id: identity.memberId, brand: identity.brand || "", avatar: identity.avatar || "" }).toString();
        const reviewRes = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/review?${q}`);
        const reviewData = await reviewRes.json().catch(() => ({} as any));
        if (reviewRes.ok && Array.isArray(reviewData?.sections)) setReviewData(reviewData.sections);
      }
      if (opts?.nextStep) setStep(opts.nextStep);
      setSaveNotice(`${sectionKey.replace(/_/g, " ")} saved.`);
      return true;
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to save section."));
      return false;
    } finally {
      setLoading(false);
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, fetchSession]);

  const approveFoundation = useCallback(async () => {
    if (!sessionId || !identity.memberId) return;
    setLoading(true);
    setScreenError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/approve-foundation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: identity.memberId, brand: identity.brand, avatar: identity.avatar }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(Array.isArray(data?.blockers) ? data.blockers.join(" ") : String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      syncSession(data);
      setStep("completion");
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to approve the foundation sections."));
    } finally {
      setLoading(false);
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, syncSession]);

  const fetchPreview = useCallback(async (goToFinal = true) => {
    if (!sessionId || !identity.memberId) return;
    setLoading(true);
    setScreenError("");
    try {
      const q = new URLSearchParams({ member_id: identity.memberId, brand: identity.brand || "", avatar: identity.avatar || "" }).toString();
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/preview?${q}`);
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      setPreviewModel(data);
      if (goToFinal) setStep("final_approval");
      await fetchSession();
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to compile the preview."));
    } finally {
      setLoading(false);
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, fetchSession]);

  const approveVersion = useCallback(async (scope: "limited" | "full") => {
    if (!sessionId || !identity.memberId) return;
    setLoading(true);
    setScreenError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/approve-version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: identity.memberId,
          brand: identity.brand,
          avatar: identity.avatar,
          publish_scope: scope,
          approval_note: "Ready for AI grounding and profile use.",
          expected_latest_input_hash: String(session?.input_hash || ""),
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(Array.isArray(data?.blockers) ? data.blockers.join(" ") : String((data && (data.detail || data.message)) || `HTTP ${res.status}`));
      setApprovalResult(data);
      setPreviewModel(data);
      await fetchSession();
      setSaveNotice(`Version ${data?.version_number || ""} approved for ${scope} publish.`);
    } catch (e: any) {
      setScreenError(String(e?.message || e || "Failed to approve the profile version."));
    } finally {
      setLoading(false);
    }
  }, [sessionId, identity.memberId, identity.brand, identity.avatar, session?.input_hash, fetchSession]);

  const reviewSectionMap = useMemo(() => {
    const out: Record<string, HOSectionRow> = {};
    for (const sec of reviewData) out[String(sec.section_key || "")] = sec;
    return out;
  }, [reviewData]);

  const renderStepPill = (label: string, value: string, active: boolean) => (
    <div key={value} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: active ? "#111" : "rgba(0,0,0,0.56)" }}>
      <div style={{ width: 26, height: 26, borderRadius: 999, border: "1px solid rgba(0,0,0,0.18)", background: active ? "#111" : "#fff", color: active ? "#fff" : "#111", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{label[0]}</div>
      <span>{label}</span>
    </div>
  );

  const ProgressNav = () => (
    <div style={{ ...HO_CARD, padding: 18, minWidth: 220 }}>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 14 }}>Progress</div>
      <div style={{ display: "grid", gap: 12 }}>
        {[
          { label: "Welcome", value: "welcome" },
          { label: "Basics", value: "basics" },
          { label: "Photos", value: "photos" },
          { label: "Review", value: "review" },
          { label: "Complete profile", value: "completion" },
          { label: "Final approval", value: "final_approval" },
        ].map((item) => renderStepPill(item.label, item.value, step === (item.value as HOStep)))}
      </div>
    </div>
  );

  const WelcomeScreen = () => (
    <div style={{ ...HO_CARD, padding: 26 }}>
      <div style={{ fontSize: 30, fontWeight: 900, marginBottom: 10 }}>Complete Your Host Profile</div>
      <div style={{ fontSize: 15, lineHeight: 1.65, color: "rgba(0,0,0,0.76)", marginBottom: 16 }}>
        This onboarding is staged. You can save and return later. For this release, all entries must be in English.
      </div>
      <div style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, padding: 18, marginBottom: 18 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>What happens next</div>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.75 }}>
          <li>Enter identity basics</li>
          <li>Upload required photos</li>
          <li>Review system-derived sections</li>
          <li>Complete remaining profile sections</li>
          <li>Approve a version for publishing</li>
        </ol>
      </div>
      <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)", marginBottom: 18 }}>
        Estimated first-pass completion time: 12–20 minutes. Save/resume is enabled through your host onboarding session.
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button style={HO_BTN_PRIMARY} onClick={() => setStep("basics")} disabled={!sessionId || loading}>Start onboarding</button>
        <button style={HO_BTN_SECONDARY} onClick={() => setSaveNotice("You can close this page and resume later from your member area.")}>Save and exit</button>
        <button style={HO_BTN_SECONDARY} onClick={() => setSaveNotice("Need help? Use your internal support workflow or admin/support tools for recovery.")}>Help</button>
      </div>
    </div>
  );

  const BasicsScreen = () => (
    <div style={{ ...HO_CARD, padding: 26 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 900 }}>Basic identity intake</div>
          <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)" }}>Required seed data only: fast completion with inline examples.</div>
        </div>
        <div style={HO_BADGE("rgba(0,0,0,0.06)")}>Step 2 of 6</div>
      </div>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Legal / full name *</label>
          <input style={HO_INPUT} value={basicForm.legal_name} placeholder="Example: Alicia Johnson" onChange={(e) => setBasicForm((prev) => ({ ...prev, legal_name: e.target.value }))} />
          <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 6 }}>Private identity field.</div>
          {basicErrors.legal_name ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.legal_name}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Birth city *</label>
          <input style={HO_INPUT} value={basicForm.birth_city} placeholder="Example: London" onChange={(e) => setBasicForm((prev) => ({ ...prev, birth_city: e.target.value }))} />
          {basicErrors.birth_city ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.birth_city}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Stage / public name *</label>
          <input style={HO_INPUT} value={basicForm.stage_name} placeholder="Example: Dulce Moon" onChange={(e) => setBasicForm((prev) => ({ ...prev, stage_name: e.target.value }))} />
          <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 6 }}>Default public identity.</div>
          {basicErrors.stage_name ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.stage_name}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Birth state / region *</label>
          <input style={HO_INPUT} value={basicForm.birth_state_region} placeholder="Example: England" onChange={(e) => setBasicForm((prev) => ({ ...prev, birth_state_region: e.target.value }))} />
          {basicErrors.birth_state_region ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.birth_state_region}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Gender *</label>
          <select style={HO_INPUT} value={basicForm.gender_model.mode === "self_describe" ? "Another identity" : basicForm.gender_model.picklist_value} onChange={(e) => {
            const v = e.target.value;
            if (v === "Another identity") setBasicForm((prev) => ({ ...prev, gender_model: { ...prev.gender_model, mode: "self_describe", picklist_value: v, custom_text: prev.gender_model.custom_text } }));
            else if (v === "Prefer not to say") setBasicForm((prev) => ({ ...prev, gender_model: { ...prev.gender_model, mode: "prefer_not_to_say", picklist_value: v, custom_text: "" } }));
            else setBasicForm((prev) => ({ ...prev, gender_model: { ...prev.gender_model, mode: "picklist", picklist_value: v, custom_text: "" } }));
          }}>
            {HO_GENDER_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 6 }}>Hybrid model: picklist plus optional self-description.</div>
          {basicForm.gender_model.mode === "self_describe" ? (
            <input style={{ ...HO_INPUT, marginTop: 8 }} value={basicForm.gender_model.custom_text} placeholder="Self-describe your gender" onChange={(e) => setBasicForm((prev) => ({ ...prev, gender_model: { ...prev.gender_model, mode: "self_describe", custom_text: e.target.value } }))} />
          ) : null}
          {basicErrors["gender_model"] || basicErrors["gender_model.custom_text"] ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors["gender_model"] || basicErrors["gender_model.custom_text"]}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Birth country *</label>
          <input style={HO_INPUT} value={basicForm.birth_country_name} placeholder="Example: United Kingdom" onChange={(e) => setBasicForm((prev) => ({ ...prev, birth_country_name: e.target.value, birth_country_code: hoCountryCodeFromName(e.target.value) }))} />
          {basicErrors.birth_country_name ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.birth_country_name}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Birthdate *</label>
          <input type="date" style={HO_INPUT} value={basicForm.birthdate} onChange={(e) => setBasicForm((prev) => ({ ...prev, birthdate: e.target.value }))} />
          {basicErrors.birthdate ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.birthdate}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Race *</label>
          <div style={{ ...HO_CARD, padding: 12, boxShadow: "none" }}>
            <div style={{ display: "grid", gap: 8 }}>
              {HO_RACE_OPTIONS.map((opt) => {
                const checked = basicForm.race_codes.includes(opt.code);
                return (
                  <label key={opt.code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <input type="checkbox" checked={checked} onChange={(e) => {
                      setBasicForm((prev) => {
                        let next = prev.race_codes.slice();
                        if (e.target.checked) {
                          if (!next.includes(opt.code)) next.push(opt.code);
                        } else {
                          next = next.filter((x) => x !== opt.code);
                        }
                        return { ...prev, race_codes: next };
                      });
                    }} />
                    <span>{opt.label}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 8 }}>Prescriptive multi-select for consistency. Inline examples are intentionally standardized.</div>
            {basicForm.race_codes.includes("another_race") ? <input style={{ ...HO_INPUT, marginTop: 10 }} value={basicForm.race_self_describe} placeholder="Self-describe race" onChange={(e) => setBasicForm((prev) => ({ ...prev, race_self_describe: e.target.value }))} /> : null}
          </div>
          {basicErrors.race_codes || basicErrors.race_self_describe ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.race_codes || basicErrors.race_self_describe}</div> : null}
        </div>
        <div>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Ethnicity *</label>
          <select style={HO_INPUT} value={basicForm.ethnicity_primary_bucket} onChange={(e) => setBasicForm((prev) => ({ ...prev, ethnicity_primary_bucket: e.target.value }))}>
            <option value="">Choose ethnicity bucket</option>
            {HO_ETHNICITY_BUCKETS.map((opt) => <option key={opt.code} value={opt.code}>{opt.label}</option>)}
          </select>
          <div style={{ ...HO_CARD, padding: 12, boxShadow: "none", marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Choose one or more heritage labels (up to 5)</div>
            <select multiple value={basicForm.ethnicity_labels} onChange={(e) => {
              const next = Array.from(e.target.selectedOptions).map((opt) => opt.value).slice(0, 5);
              setBasicForm((prev) => ({ ...prev, ethnicity_labels: next }));
            }} style={{ ...HO_INPUT, minHeight: 140 }}>
              {HO_ETHNICITY_LABELS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 8 }}>Examples: Afro-Caribbean, Mixed European-American, Jamaican, Nigerian, Persian / Iranian.</div>
            {basicForm.ethnicity_labels.includes("Other / self-describe") ? <input style={{ ...HO_INPUT, marginTop: 10 }} value={basicForm.ethnicity_other_text} placeholder="Self-describe ethnicity / heritage" onChange={(e) => setBasicForm((prev) => ({ ...prev, ethnicity_other_text: e.target.value }))} /> : null}
          </div>
          {basicErrors.ethnicity_primary_bucket || basicErrors.ethnicity_labels || basicErrors.ethnicity_other_text ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 6 }}>{basicErrors.ethnicity_primary_bucket || basicErrors.ethnicity_labels || basicErrors.ethnicity_other_text}</div> : null}
        </div>
      </div>
      {basicWarnings.length ? <div style={{ marginTop: 14, color: "#8a5b00", fontSize: 13 }}>Warnings: {basicWarnings.join(" ")}</div> : null}
      <div style={{ display: "flex", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
        <button style={HO_BTN_SECONDARY} onClick={() => saveBasics(undefined)} disabled={loading}>Save draft</button>
        <button style={HO_BTN_PRIMARY} onClick={() => saveBasics("photos")} disabled={loading}>Continue</button>
      </div>
    </div>
  );

  const SlotCard = ({ slot, optional = false }: { slot: { slot_key: string; label: string; notes?: string }; optional?: boolean }) => {
    const asset = assetsBySlot[slot.slot_key];
    const preview = hoNormalizedPreviewUrl(String(asset?.preview_url || ""), identity);
    const status = String(asset?.validation_status || "");
    const statusStyle = status === "accepted" ? HO_BADGE("rgba(22,163,74,0.12)") : status === "rejected" ? HO_BADGE("rgba(220,38,38,0.12)") : HO_BADGE("rgba(0,0,0,0.06)");
    return (
      <div style={{ ...HO_CARD, padding: 16, boxShadow: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div>
            <div style={{ fontWeight: 800 }}>{slot.label}{optional ? " (optional)" : " *"}</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,0.56)", marginTop: 4 }}>{slot.notes || "Optional additional reference photo."}</div>
          </div>
          <div style={statusStyle}>{status || "pending"}</div>
        </div>
        {preview ? <img src={preview} alt={slot.label} style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 14, marginTop: 12, border: "1px solid rgba(0,0,0,0.08)" }} /> : null}
        {asset?.original_file_name ? <div style={{ fontSize: 12, color: "rgba(0,0,0,0.64)", marginTop: 8 }}>{asset.original_file_name}</div> : null}
        {(asset?.validation_errors || []).length ? <div style={{ color: "#b00020", fontSize: 12, marginTop: 8 }}>{(asset.validation_errors || []).join(" ")}</div> : null}
        {(asset?.validation_warnings || []).length ? <div style={{ color: "#8a5b00", fontSize: 12, marginTop: 8 }}>{(asset.validation_warnings || []).join(" ")}</div> : null}
        <div style={{ marginTop: 12 }}>
          <input type="file" accept="image/jpeg,image/png,image/heic,image/heif" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadPhotoForSlot(slot.slot_key, file);
          }} />
        </div>
      </div>
    );
  };

  const PhotosScreen = () => (
    <div style={{ ...HO_CARD, padding: 26 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 900 }}>Photo upload and 3D opt-in</div>
          <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)" }}>Upload five required photos. Exactly one accepted image is required in each required slot before you continue.</div>
        </div>
        <div style={HO_BADGE("rgba(0,0,0,0.06)")}>{requiredAcceptedCount} / {HO_REQUIRED_SLOTS.length} required accepted</div>
      </div>
      <div style={{ padding: 14, borderRadius: 14, background: "rgba(0,0,0,0.03)", marginBottom: 18 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={photo3dOptIn}
            onChange={async (e) => {
              if (!sessionId || !identity.memberId) return;
              const next = Boolean(e.target.checked);
              try {
                const res = await fetch(`${API_BASE}/host-onboarding/sessions/${encodeURIComponent(sessionId)}/photo-opt-in`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ member_id: identity.memberId, brand: identity.brand, avatar: identity.avatar, photo_3d_opt_in: next }),
                });
                const data = await res.json().catch(() => ({} as any));
                if (res.ok) syncSession(data);
                else setSession((prev) => prev ? ({ ...prev, photo_3d_opt_in: next }) : prev);
              } catch {
                setSession((prev) => prev ? ({ ...prev, photo_3d_opt_in: next }) : prev);
              }
            }}
          />
          <span style={{ fontSize: 14, lineHeight: 1.55 }}><b>I opt in to future 3D character generation using these uploaded photos.</b><br />Host confirms these photos may be used later for 3D character generation only if host opts in to this service.</span>
        </label>
      </div>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {HO_REQUIRED_SLOTS.map((slot) => <SlotCard key={slot.slot_key} slot={slot} />)}
      </div>
      <div style={{ fontSize: 20, fontWeight: 900, marginTop: 22, marginBottom: 12 }}>Optional photos</div>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {HO_OPTIONAL_SLOTS.map((slot) => <SlotCard key={slot.slot_key} slot={slot} optional />)}
      </div>
      {uploadingSlot ? <div style={{ marginTop: 16, fontSize: 13 }}>Uploading {uploadingSlot.replace(/_/g, " ")}…</div> : null}
      <div style={{ display: "flex", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
        <button style={HO_BTN_SECONDARY} onClick={() => fetchSession()} disabled={loading}>Refresh photo status</button>
        <button style={HO_BTN_PRIMARY} onClick={() => setStep("processing")} disabled={loading || !canContinuePhotos}>Continue</button>
      </div>
    </div>
  );

  const ReviewSectionCard = ({ section }: { section: HOSectionRow }) => {
    const key = String(section.section_key || "");
    const payload = section.payload || {};
    const sourceType = String(section.source_type || "");
    const reviewStatus = String(section.review_status || "pending");
    const isRequired = ["personal_information", "astrological_profile", "nationalities", "family_heritage", "physical_description", "personality"].includes(key);
    const badgeColor = sourceType.includes("host") ? "rgba(37,99,235,0.12)" : sourceType.includes("derived") ? "rgba(124,58,237,0.12)" : "rgba(22,163,74,0.12)";
    return (
      <div style={{ ...HO_CARD, padding: 18, boxShadow: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={HO_BADGE(badgeColor)}>{sourceType || "source"}</div>
            <div style={HO_BADGE("rgba(0,0,0,0.06)")}>{reviewStatus || "pending"}</div>
          </div>
        </div>
        {key === "personal_information" ? (
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            <div><b>Legal / full name:</b> {payload.legal_name || "—"}</div>
            <div><b>Stage / public name:</b> {payload.stage_name || "—"}</div>
            <div><b>Birth location:</b> {[payload.birth_city, payload.birth_state_region, payload.birth_country?.name].filter(Boolean).join(", ") || "—"}</div>
            <div><b>Race:</b> {(payload.race_codes || []).join(", ") || "—"}</div>
            <div><b>Ethnicity:</b> {(payload.ethnicity_labels || []).join(", ") || "—"}</div>
          </div>
        ) : key === "astrological_profile" ? (
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            <div><b>Age:</b> {payload.age_years ?? "—"}</div>
            <div><b>Zodiac sign:</b> {payload.zodiac_sign || "—"}</div>
            <div><b>Birthplace display:</b> {payload.birth_location_display || "—"}</div>
          </div>
        ) : key === "nationalities" ? (
          <div>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,0.66)", marginBottom: 8 }}>Nationality is reviewable because some hosts may have multiple nationalities.</div>
            <div style={{ display: "grid", gap: 8 }}>
              {nationalityDraft.map((n, idx) => (
                <div key={`${n}-${idx}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input style={HO_INPUT} value={n} onChange={(e) => setNationalityDraft((prev) => prev.map((x, i) => i === idx ? e.target.value : x))} />
                  <button style={HO_BTN_SECONDARY} onClick={() => setNationalityDraft((prev) => prev.filter((_, i) => i !== idx))}>Remove</button>
                  <button style={HO_BTN_SECONDARY} onClick={() => setNationalityDraft((prev) => prev.map((x, i) => i === idx - 1 ? n : i === idx ? prev[idx - 1] : x))} disabled={idx === 0}>↑</button>
                  <button style={HO_BTN_SECONDARY} onClick={() => setNationalityDraft((prev) => prev.map((x, i) => i === idx + 1 ? n : i === idx ? prev[idx + 1] : x))} disabled={idx >= nationalityDraft.length - 1}>↓</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <button style={HO_BTN_SECONDARY} onClick={() => setNationalityDraft((prev) => [...prev, ""])}>Add another nationality</button>
              <button style={HO_BTN_SECONDARY} onClick={() => setNationalityDraft([])}>Prefer not to derive / enter manually later</button>
            </div>
          </div>
        ) : (
          <textarea style={HO_TEXTAREA} value={String(payload.draft_text || payload.text || "")} onChange={(e) => {
            const nextText = e.target.value;
            setReviewData((prev) => prev.map((x) => String(x.section_key || "") === key ? ({ ...x, payload: { ...(x.payload || {}), draft_text: nextText, text: nextText } }) : x));
          }} />
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          {key === "personal_information" || key === "astrological_profile" ? <button style={HO_BTN_SECONDARY} onClick={() => setStep("basics")}>Edit basics</button> : null}
          <button style={HO_BTN_PRIMARY} onClick={() => {
            const nextPayload = key === "nationalities"
              ? { suggested: payload.suggested || [], host_confirmed: nationalityDraft.filter((x) => String(x || "").trim()) }
              : (reviewData.find((x) => String(x.section_key || "") === key)?.payload || payload || {});
            saveSection(key, nextPayload, key === "personal_information" || key === "astrological_profile" ? "accepted" : "edited", { refreshReview: true });
          }}>Accept / save</button>
          {!(key === "personal_information" || key === "astrological_profile" || key === "nationalities") ? <button style={HO_BTN_SECONDARY} onClick={() => saveSection(key, reviewData.find((x) => String(x.section_key || "") === key)?.payload || payload || {}, "reject", { refreshReview: true })}>Reject draft</button> : null}
          {!isRequired ? <button style={HO_BTN_SECONDARY} onClick={() => saveSection(key, payload || {}, "defer", { refreshReview: true })}>Defer</button> : null}
        </div>
      </div>
    );
  };

  const ReviewScreen = () => {
    const readyForFoundation = ["personal_information", "astrological_profile", "nationalities", "family_heritage", "physical_description", "personality"].every((key) => {
      const sec: HOSectionRow | undefined = reviewSectionMap[key];
      return ["accepted", "edited"].includes(String(sec?.review_status || ""));
    });
    return (
      <div style={{ ...HO_CARD, padding: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>Derived review and correction</div>
            <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)" }}>Entered, derived, and AI-draft values are labeled explicitly. Required foundation sections must be accepted or edited before later sections open.</div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          {reviewData.map((section) => <ReviewSectionCard key={String(section.section_key || "")} section={section} />)}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
          <button style={HO_BTN_SECONDARY} onClick={() => setStep("processing")}>Back</button>
          <button style={HO_BTN_PRIMARY} onClick={approveFoundation} disabled={!readyForFoundation || loading}>Open later sections</button>
        </div>
      </div>
    );
  };

  const renderLaterSectionEditor = (cfg: typeof HO_LATER_SECTION_CONFIG[number]) => {
    const key = cfg.key;
    const payload = laterSections[key] || {};
    const status = completionStatus[key] || "draft";
    const setPayload = (next: any) => setLaterSections((prev) => ({ ...prev, [key]: next }));
    return (
      <div key={key} style={{ ...HO_CARD, padding: 18, boxShadow: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{cfg.label}</div>
          <div style={HO_BADGE(status === "accepted" || status === "edited" ? "rgba(22,163,74,0.12)" : status === "deferred" ? "rgba(0,0,0,0.06)" : "rgba(37,99,235,0.12)")}>{status}</div>
        </div>
        <div style={{ fontSize: 12, color: "rgba(0,0,0,0.58)", marginBottom: 10 }}>{cfg.example}</div>
        {cfg.kind === "career" ? (
          <div style={{ display: "grid", gap: 10 }}>
            <input style={HO_INPUT} value={String(payload.job_title || "")} placeholder="Current job title / current position" onChange={(e) => setPayload({ ...payload, job_title: e.target.value })} />
            <input style={HO_INPUT} value={String(payload.employer || "")} placeholder="Employer / company" onChange={(e) => setPayload({ ...payload, employer: e.target.value })} />
            <textarea style={HO_TEXTAREA} value={String(payload.responsibilities_text || "")} placeholder="Responsibilities and achievements" onChange={(e) => setPayload({ ...payload, responsibilities_text: e.target.value })} />
            {payload.estimated_income?.value_range ? <div style={{ fontSize: 13, background: "rgba(0,0,0,0.04)", padding: 12, borderRadius: 12 }}><b>Private estimated income suggestion:</b> {String(payload.estimated_income.value_range || "")}</div> : null}
          </div>
        ) : cfg.kind === "education" ? (
          <textarea style={HO_TEXTAREA} value={String(payload.text || "")} placeholder="Degrees, institutions, years, and study focus" onChange={(e) => setPayload({ ...payload, text: e.target.value })} />
        ) : cfg.kind === "list" ? (
          <textarea style={HO_TEXTAREA} value={String(payload.text || "")} placeholder="Enter one item per line or comma-separated" onChange={(e) => setPayload({ ...payload, text: e.target.value })} />
        ) : (
          <textarea style={HO_TEXTAREA} value={String(payload.text || "")} placeholder={cfg.example} onChange={(e) => setPayload({ ...payload, text: e.target.value })} />
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <button style={HO_BTN_SECONDARY} onClick={() => saveSection(key, payload, "draft")}>Save draft</button>
          <button style={HO_BTN_PRIMARY} onClick={() => saveSection(key, payload, payload.text || payload.job_title || payload.employer ? "edited" : "accepted")}>Save section</button>
          <button style={HO_BTN_SECONDARY} onClick={() => saveSection(key, payload, "defer")}>Skip for later</button>
        </div>
      </div>
    );
  };

  const CompletionScreen = () => (
    <div style={{ ...HO_CARD, padding: 26 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 900 }}>Complete remaining profile sections</div>
          <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)" }}>Save as draft, skip for later, and return later are supported. Limited-publish readiness is shown independently of full completion.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={HO_BADGE(Boolean(session?.limited_ready) ? "rgba(22,163,74,0.12)" : "rgba(0,0,0,0.06)")}>Limited publish: {session?.limited_ready ? "ready" : "not ready"}</div>
          <div style={HO_BADGE(Boolean(session?.full_ready) ? "rgba(22,163,74,0.12)" : "rgba(0,0,0,0.06)")}>Full publish: {session?.full_ready ? "ready" : "not ready"}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 14 }}>
        {HO_LATER_SECTION_CONFIG.map(renderLaterSectionEditor)}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
        <button style={HO_BTN_SECONDARY} onClick={() => setStep("review")}>Back to review</button>
        <button style={HO_BTN_PRIMARY} onClick={() => fetchPreview(true)}>Go to preview & approval</button>
      </div>
    </div>
  );

  const FinalScreen = () => {
    const preview = previewModel || {};
    const readiness = preview.publish_readiness || {};
    const privatePreview = preview.private_preview || {};
    const publicPreview = preview.public_preview || {};
    return (
      <div style={{ ...HO_CARD, padding: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>Preview and approval</div>
            <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)" }}>Private/internal data is separated from public/persona profile data. You may jump back to any section before approval.</div>
          </div>
          {approvalResult?.version_id ? <div style={HO_BADGE("rgba(22,163,74,0.12)")}>Approved version: {String(approvalResult.version_id || "")}</div> : null}
        </div>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div style={{ ...HO_CARD, padding: 16, boxShadow: "none" }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Private / internal</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.55 }}>{JSON.stringify(privatePreview, null, 2)}</pre>
          </div>
          <div style={{ ...HO_CARD, padding: 16, boxShadow: "none" }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Public / persona</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.55 }}>{JSON.stringify(publicPreview, null, 2)}</pre>
          </div>
        </div>
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          <div style={{ ...HO_CARD, padding: 16, boxShadow: "none" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Limited publish blockers</div>
            {(readiness.limited_blockers || []).length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{(readiness.limited_blockers || []).map((x: any, i: number) => <li key={i}>{String(x || "")}</li>)}</ul> : <div style={{ color: "rgba(0,0,0,0.66)" }}>No blockers.</div>}
          </div>
          <div style={{ ...HO_CARD, padding: 16, boxShadow: "none" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Full publish blockers</div>
            {(readiness.full_blockers || []).length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{(readiness.full_blockers || []).map((x: any, i: number) => <li key={i}>{String(x || "")}</li>)}</ul> : <div style={{ color: "rgba(0,0,0,0.66)" }}>No blockers.</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
          <button style={HO_BTN_SECONDARY} onClick={() => setStep("basics")}>Edit basics</button>
          <button style={HO_BTN_SECONDARY} onClick={() => setStep("photos")}>Edit photos</button>
          <button style={HO_BTN_SECONDARY} onClick={() => setStep("review")}>Edit review</button>
          <button style={HO_BTN_SECONDARY} onClick={() => setStep("completion")}>Edit later sections</button>
          <button style={HO_BTN_PRIMARY} onClick={() => approveVersion("limited")} disabled={loading || Boolean((readiness.limited_blockers || []).length)}>Approve limited profile</button>
          <button style={HO_BTN_PRIMARY} onClick={() => approveVersion("full")} disabled={loading || Boolean((readiness.full_blockers || []).length)}>Approve full profile</button>
        </div>
      </div>
    );
  };

  const notReadyMessage = !identity.memberId
    ? "Waiting for host member context from Wix or master-site launch. This page expects a logged-in host member handoff."
    : (!identity.loggedIn ? "Please log in through the Wix member area to use Host Onboarding." : "");

  return (
    <div style={{ minHeight: "100vh", background: "#f6f7fb", padding: "24px clamp(16px, 4vw, 40px) 40px" }}>
      <div style={{ maxWidth: 1360, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(0,0,0,0.45)", fontWeight: 800 }}>Host Onboarding / Host Profile Studio</div>
            <div style={{ fontSize: 32, fontWeight: 900, color: "#111", marginTop: 4 }}>Build your Host Human Companion Profile</div>
            <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)", marginTop: 6 }}>
              Host: {identity.displayName || basicForm.stage_name || identity.memberId || "Unknown"}{identity.brand ? ` · Brand: ${identity.brand}` : ""}{identity.avatar ? ` · Avatar: ${identity.avatar}` : ""}
            </div>
          </div>
          {lastSaved ? <div style={HO_BADGE("rgba(0,0,0,0.06)")}>Last saved: {lastSaved}</div> : null}
        </div>
        {screenError ? <div style={{ ...HO_CARD, padding: 14, marginBottom: 16, borderColor: "rgba(176,0,32,0.18)", color: "#b00020" }}>{screenError}</div> : null}
        {saveNotice ? <div style={{ ...HO_CARD, padding: 14, marginBottom: 16, borderColor: "rgba(22,163,74,0.18)", color: "#166534" }}>{saveNotice}</div> : null}
        {!handoffReady && !identity.memberId ? <div style={{ ...HO_CARD, padding: 16, marginBottom: 16 }}>{notReadyMessage}</div> : null}
        {identity.memberId && !identity.loggedIn ? <div style={{ ...HO_CARD, padding: 16, marginBottom: 16 }}>{notReadyMessage}</div> : null}
        <div style={{ display: "grid", gap: 18, gridTemplateColumns: "minmax(220px, 260px) minmax(0, 1fr)" }}>
          <ProgressNav />
          <div>
            {step === "welcome" ? <WelcomeScreen /> : null}
            {step === "basics" ? <BasicsScreen /> : null}
            {step === "photos" ? <PhotosScreen /> : null}
            {step === "processing" ? (
              <div style={{ ...HO_CARD, padding: 26 }}>
                <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 8 }}>Building your first-pass profile draft</div>
                <div style={{ fontSize: 14, color: "rgba(0,0,0,0.64)", marginBottom: 18 }}>This step validates inputs, computes deterministic fields, and prepares review-only text. No raw AI system prompts or internal scoring are shown to the host.</div>
                <div style={{ display: "grid", gap: 12 }}>
                  {[
                    { key: "validate_basics", label: "Validate required basics" },
                    { key: "validate_photos", label: "Validate required photos" },
                    { key: "derive_age_and_zodiac", label: "Derive age and zodiac sign" },
                    { key: "create_nationality_suggestion", label: "Create nationality suggestion" },
                    { key: "draft_review_sections", label: "Draft review-only narrative sections" },
                  ].map((item) => {
                    const status = String(session?.latest_job?.progress?.[item.key]?.status || (item.key === "validate_basics" && session?.basics?.legal_name ? "completed" : "pending"));
                    const fill = status === "completed" ? "100%" : status === "running" ? "65%" : status === "queued" ? "20%" : "8%";
                    return (
                      <div key={item.key}>
                        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{item.label}</div>
                        <div style={{ height: 12, borderRadius: 999, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
                          <div style={{ width: fill, height: "100%", background: "#111", transition: "width 220ms ease" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
                  <button style={HO_BTN_SECONDARY} onClick={() => { setDeriveRequested(false); fetchSession(); }} disabled={loading}>Refresh progress</button>
                  <button style={HO_BTN_PRIMARY} onClick={() => setStep("review")} disabled={String(session?.status || "") !== "awaiting_review"}>Continue to review</button>
                </div>
              </div>
            ) : null}
            {step === "review" ? <ReviewScreen /> : null}
            {step === "completion" ? <CompletionScreen /> : null}
            {step === "final_approval" ? <FinalScreen /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostOnboardingRouteSwitch() {
  const [mode, setMode] = useState<"connect" | "host-onboarding">(() => (hoShouldRenderOnboarding() ? "host-onboarding" : "connect"));
  useEffect(() => {
    setMode(hoShouldRenderOnboarding() ? "host-onboarding" : "connect");
  }, []);
  if (mode === "host-onboarding") return <HostOnboardingApp />;
  return <ConnectPage />;
}



declare global {
  interface Window {
    Stripe?: any;
    __ELARALO_STRIPE_PUBLISHABLE_KEY__?: string;
    __STRIPE_PUBLISHABLE_KEY__?: string;
  }
}

let __stripeJsPromise: Promise<any> | null = null;

function loadStripeJs(publishableKey: string): Promise<any> {
  const key = String(publishableKey || "").trim();
  if (!key) return Promise.reject(new Error("Stripe publishable key is not configured"));
  if (typeof window === "undefined") return Promise.reject(new Error("Stripe can only load in the browser"));
  if (window.Stripe) return Promise.resolve(window.Stripe(key));
  if (!__stripeJsPromise) {
    __stripeJsPromise = new Promise((resolve, reject) => {
      try {
        const existing = document.querySelector('script[src="https://js.stripe.com/v3/"]') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener("load", () => {
            try { resolve(window.Stripe ? window.Stripe(key) : null); } catch (e) { reject(e); }
          });
          existing.addEventListener("error", () => reject(new Error("Stripe.js failed to load")));
          return;
        }
        const script = document.createElement("script");
        script.src = "https://js.stripe.com/v3/";
        script.async = true;
        script.onload = () => {
          try {
            if (!window.Stripe) reject(new Error("Stripe.js loaded without Stripe global"));
            else resolve(window.Stripe(key));
          } catch (e) {
            reject(e);
          }
        };
        script.onerror = () => reject(new Error("Stripe.js failed to load"));
        document.head.appendChild(script);
      } catch (e) {
        reject(e);
      }
    });
  }
  return __stripeJsPromise;
}

function formatCents(amountCents: any, currency: any): string {
  const cents = Number(amountCents || 0) || 0;
  const cur = String(currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function readRuntimeStripePublishableKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return String(
      window.__ELARALO_STRIPE_PUBLISHABLE_KEY__ ||
        window.__STRIPE_PUBLISHABLE_KEY__ ||
        ""
    ).trim();
  } catch {
    return "";
  }
}

async function fetchStripePaygoRuntimeConfig(apiBase: string, brand: string): Promise<any> {
  const base = String(apiBase || "").replace(/\/+$/, "");
  if (!base) return null;
  const b = encodeURIComponent(String(brand || "Elaralo").trim() || "Elaralo");
  try {
    const res = await fetch(`${base}/stripe/paygo/config?brand=${b}`, {
      method: "GET",
      cache: "no-store",
    });
    const raw = await res.text().catch(() => "");
    let json: any = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    if (!res.ok) return null;
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}
function paygoSafeReturnUrl(brandRaw: any): string {
  if (typeof window === "undefined") return "";
  const brand = String(brandRaw || "").trim().toLowerCase();
  try {
    const ref = String(document.referrer || "").trim();
    // When Connect is embedded from a Wix brand page, return hosted/redirect
    // checkouts to that Wix page rather than the bare Static App root. This
    // prevents a completed fallback Checkout from landing on the default
    // Elaralo Connect screen.
    if (/^https:\/\//i.test(ref)) {
      const u = new URL(ref);
      const host = u.hostname.toLowerCase();
      if ((brand.includes("dulcemoon") && host.endsWith("dulcemoon.net")) || host.endsWith("elaralo.com")) {
        return u.toString();
      }
    }
  } catch {}
  try {
    return window.location.href;
  } catch {
    return "";
  }
}


export default function Page() {
  return <HostOnboardingRouteSwitch />;
}

function ConnectPage() {

  // iOS detection (includes iPadOS 13+ which reports itself as "Macintosh")
  const isIOS = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const iOS = /iPad|iPhone|iPod/i.test(ua);
    const iPadOS13 = /Macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
    return iOS || iPadOS13;
  }, []);

  const isIphone = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /iPhone|iPod/i.test(navigator.userAgent || "");
  }, []);

  const isEmbedded = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.self !== window.top;
    } catch (e) {
      // Cross-origin access to window.top can throw; assume embedded.
      return true;
    }
  }, []);


  // v9.1.27 latency optimization: shared visibility flag for adaptive polling.
  // Polling now slows/stops when the tab is backgrounded, which is especially
  // helpful inside Wix iframes on iOS/iPadOS.
  const pageVisibleRef = useRef<boolean>(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => {
      pageVisibleRef.current = !document.hidden;
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const adaptiveRelayPollDelayMs = useCallback(() => {
    if (!pageVisibleRef.current) return 15000;
    const overrideActive = Boolean((sessionStateRef.current as any)?.host_override_active);
    const hasMessages = (messagesRef.current?.length || 0) > 0;
    if (overrideActive) return 1000;
    if (hasMessages) return 4000;
    return 8000;
  }, []);

  const adaptiveHostListPollDelayMs = useCallback((activeCount: number) => {
    if (!pageVisibleRef.current) return 15000;
    return activeCount > 0 ? 2500 : 6000;
  }, []);

  const adaptiveHostTranscriptPollDelayMs = useCallback((hasSelection: boolean) => {
    if (!pageVisibleRef.current) return 15000;
    return hasSelection ? 1000 : 4000;
  }, []);

  // Elaralo launches Connect from the My Elaralo selector by navigating the same
  // Wix-hosted iframe and passing a direct query-string payload. DulceMoon's
  // Connect payload is still supplied by Wix postMessage and must remain on the
  // existing path. Keep this flag narrow so microphone handling changes only
  // apply to the Elaralo app-sourced handoff.
  const directCompanionHandoff = useMemo(() => readDirectCompanionHandoffFromUrl(), []);
  const companionListReturnContext = useMemo(() => readCompanionListReturnContextFromUrl(), []);
  const canReturnToCompanionList = companionListReturnContext.enabled && companionListReturnContext.count > 1;

  const isDirectElaraloConnectLaunch = useMemo(() => {
    const handoff = directCompanionHandoff || {};
    if (!Boolean((handoff as any).directQueryOverride)) return false;
    if (!isElaraloBrandName((handoff as any).brand || (handoff as any).companyName || (handoff as any).company)) return false;

    const src = String((handoff as any).source || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");

    return ["myelaralo", "elaraloapp", "elaralocatalog", "elaralo"].includes(src);
  }, [directCompanionHandoff]);


  const getEmbedContext = useCallback(() => {
    let referrer = "";
    let ancestorOrigins: string[] = [];
    try {
      referrer = typeof document !== "undefined" ? String(document.referrer || "").trim() : "";
    } catch (e) {
      referrer = "";
    }
    try {
      const raw = (typeof window !== "undefined" ? (window.location as any)?.ancestorOrigins : null) as
        | { length: number; [idx: number]: string }
        | null;
      if (raw && typeof raw.length === "number") {
        for (let i = 0; i < raw.length; i++) {
          const v = String(raw[i] || "").trim();
          if (v) ancestorOrigins.push(v);
        }
      }
    } catch (e) {
      ancestorOrigins = [];
    }
    const parentOrigin = String(ancestorOrigins[0] || "").trim();
    return { referrer, parentOrigin, ancestorOrigins };
  }, []);

  const getMemberPlanCacheKey = useCallback(() => {
    if (typeof window === "undefined") return "";
    const embedCtx = getEmbedContext();
    const basis = String(
      embedCtx.referrer ||
      embedCtx.parentOrigin ||
      (embedCtx.ancestorOrigins[0] || "") ||
      window.location.pathname ||
      "core"
    ).trim();
    return `ELARALO_MEMBER_PLAN_CACHE::${safeBrandKey(basis)}`;
  }, [getEmbedContext]);

  // -----------------------
  // Responsive layout mode: mobile / tablet / desktop
  // Primary optimization target = mobile.
  // -----------------------
  type ViewportMode = "mobile" | "tablet" | "desktop";

  const getViewportMode = useCallback((): ViewportMode => {
    if (typeof window === "undefined") return "desktop";
    const w = window.innerWidth || 1024;
    if (w <= 640) return "mobile";
    if (w <= 1024) return "tablet";
    return "desktop";
  }, []);

  const [viewportMode, setViewportMode] = useState<ViewportMode>(() => {
    if (typeof window === "undefined") return "desktop";
    const w = window.innerWidth || 1024;
    if (w <= 640) return "mobile";
    if (w <= 1024) return "tablet";
    return "desktop";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportMode(getViewportMode());
    onResize();
    window.addEventListener("resize", onResize as any, { passive: true } as any);
    window.addEventListener("orientationchange", onResize as any);
    return () => {
      window.removeEventListener("resize", onResize as any);
      window.removeEventListener("orientationchange", onResize as any);
    };
  }, [getViewportMode]);

  const isMobileUI = viewportMode === "mobile";
  const isTabletUI = viewportMode === "tablet";

  // Icon sizing: on mobile, force all icons to the same pixel size (13.5px).
  const ICON_18 = isMobileUI ? 13.5 : 18;
  const ICON_20 = isMobileUI ? 13.5 : 20;

  // Keep icon buttons compact on mobile so the chat input and controls fit without scrolling.
  // (Action buttons like Set Mode / Upgrade are shorter than the square icon buttons by default.)
  const ICON_BTN_SIZE = isMobileUI ? 40 : 44;

  const ui = useMemo(
    () => {
      if (viewportMode === "mobile") {
        return {
          avatar: 48,
          title: 20,
          meta: 12,
          usageBarHeight: 10,
          mainMaxWidth: "100%",
          mainMargin: "12px auto",
          mainPadding: "0 10px",
        };
      }
      if (viewportMode === "tablet") {
        return {
          avatar: 56,
          title: 22,
          meta: 12,
          usageBarHeight: 10,
          mainMaxWidth: 980,
          mainMargin: "18px auto",
          mainPadding: "0 14px",
        };
      }
      return {
        avatar: 56,
        title: 24,
        meta: 13,
        usageBarHeight: 8,
        mainMaxWidth: 1120,
        mainMargin: "24px auto",
        mainPadding: "0 16px",
      };
    },
    [viewportMode]
  );

  const mainContainerStyle = useMemo(
    () =>
      ({
        maxWidth: ui.mainMaxWidth as any,
        margin: ui.mainMargin,
        padding: ui.mainPadding,
        fontFamily: "system-ui",
      } as React.CSSProperties),
    [ui]
  );

  // Normalize LiveKit server URL into ws/wss (client expects a websocket scheme)
  const normalizeLivekitWsUrl = useCallback((input: string): string => {
    const raw = String(input || "").trim();
    if (!raw) return "";
    if (raw.startsWith("wss://") || raw.startsWith("ws://")) return raw;
    if (raw.startsWith("https://")) return "wss://" + raw.slice("https://".length);
    if (raw.startsWith("http://")) return "ws://" + raw.slice("http://".length);
    return raw;
  }, []);


  const sessionIdRef = useRef<string | null>(null);

const [startupIdentityResolved, setStartupIdentityResolved] = useState<boolean>(() => !isEmbedded);
const startupIdentityResolvedRef = useRef<boolean>(!isEmbedded);

// Brief startup overlay (covers the iframe on initial refresh).
// Requirement: do not display the "...waiting on <companionName>" message (or start the 800ms timer)
// until the companionName has been received from the Wix MEMBER_PLAN payload.
const STARTUP_OVERLAY_MS = 800;
// Hard cap: do not block the UI for more than ~2s if the Wix payload / companion name arrives late.
const STARTUP_OVERLAY_MAX_WAIT_MS = 1200;

// Brief startup overlay (covers the iframe on initial refresh).
// Requirement: do not display the "...waiting on <companionName>" message (or start the 800ms timer)
// until the companionName has been received from the Wix MEMBER_PLAN payload.
const [startupOverlayOpen, setStartupOverlayOpen] = useState<boolean>(true);
const [startupOverlayName, setStartupOverlayName] = useState<string>("");
const startupOverlayTimerRef = useRef<number | null>(null);
const startupOverlayHardCapTimerRef = useRef<number | null>(null);
const startupOverlayStartedRef = useRef<boolean>(false);

const startStartupOverlayCountdown = useCallback(() => {
  if (startupOverlayStartedRef.current) return;
  startupOverlayStartedRef.current = true;

  if (startupOverlayTimerRef.current) {
    window.clearTimeout(startupOverlayTimerRef.current);
    startupOverlayTimerRef.current = null;
  }

  startupOverlayTimerRef.current = window.setTimeout(() => {
    setStartupOverlayOpen(false);
    startupOverlayTimerRef.current = null;
  }, STARTUP_OVERLAY_MS);
}, []);

const armStartupOverlay = useCallback(
  (name: string) => {
    const nm = String(name || "").trim();

    // Set the display name (used by the overlay message). If name is still missing, we keep the message hidden.
    if (nm) setStartupOverlayName(nm);

    // Once we receive the companion payload, we can stop the hard-cap timer.
    if (startupOverlayHardCapTimerRef.current) {
      window.clearTimeout(startupOverlayHardCapTimerRef.current);
      startupOverlayHardCapTimerRef.current = null;
    }

    // Start the 800ms countdown once (first time we learn the companion name from Wix).
    // If the name is not yet available, we keep the overlay (message hidden) until the hard-cap triggers.
    if (!nm) return;

    startStartupOverlayCountdown();
  },
  [startStartupOverlayCountdown],
);


const markStartupIdentityResolved = useCallback(
  (name: string = "") => {
    startupIdentityResolvedRef.current = true;
    setStartupIdentityResolved(true);
    const nm = String(name || "").trim();
    if (nm) armStartupOverlay(nm);
  },
  [armStartupOverlay],
);

useEffect(() => {
  return () => {
    if (startupOverlayTimerRef.current) {
      window.clearTimeout(startupOverlayTimerRef.current);
      startupOverlayTimerRef.current = null;
    }
    if (startupOverlayHardCapTimerRef.current) {
      window.clearTimeout(startupOverlayHardCapTimerRef.current);
      startupOverlayHardCapTimerRef.current = null;
    }
  };
}, []);

useEffect(() => {
  // In embedded contexts, keep the overlay in place until we either process MEMBER_PLAN
  // or complete the fallback identity bootstrap. This prevents the core Elaralo/Elara shell from flashing.
  if (startupOverlayHardCapTimerRef.current) {
    window.clearTimeout(startupOverlayHardCapTimerRef.current);
    startupOverlayHardCapTimerRef.current = null;
  }

  if (isEmbedded && !startupIdentityResolved) {
    return;
  }

  startupOverlayHardCapTimerRef.current = window.setTimeout(() => {
    if (!startupOverlayOpen) return;
    startStartupOverlayCountdown();
  }, STARTUP_OVERLAY_MAX_WAIT_MS);

  return () => {
    if (startupOverlayHardCapTimerRef.current) {
      window.clearTimeout(startupOverlayHardCapTimerRef.current);
      startupOverlayHardCapTimerRef.current = null;
    }
  };
}, [isEmbedded, startupIdentityResolved, startupOverlayOpen, startStartupOverlayCountdown]);


  // Keep the latest Wix memberId available for callbacks defined earlier in this file.
  // This avoids TypeScript/TDZ issues where a callback dependency array would otherwise
  // reference `memberId` before its declaration.
  const memberIdRef = useRef<string>("");
	  // Keep the latest host memberId available for early callbacks (prevents TDZ issues).
	  const hostMemberIdRef = useRef<string>("");

  // Wix member id (empty for visitors). Declared early so it can be referenced
  // safely in dependency arrays above (prevents TS "used before its declaration").
  const [memberId, setMemberId] = useState<string>("");

  const autoJoinStreamRef = useRef<boolean>(false);
	// Prevent re-entrant Stop calls from overlapping (Stop must always fully reset state).
	const stopInProgressRef = useRef<boolean>(false);
	const sessionActiveRef = useRef<boolean>(false);
  const streamOptOutRef = useRef<boolean>(false);
  const conferenceOptOutRef = useRef<boolean>(false);

  // -----------------------
  // Debug overlay (mobile-friendly)
  // Enable with ?debug=1 OR tap the avatar image 5 times quickly.
  // -----------------------
  const DEBUG_KEY = "ELARALO_DEBUG_OVERLAY";
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const debugEnabledRef = useRef(false);
  const debugTapCountRef = useRef(0);
  const debugTapTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("debug") === "1";
      const fromStorage = window.localStorage.getItem(DEBUG_KEY) === "1";

      // Never auto-open the overlay (it can cover important UI). Allow it to open only
      // if explicitly requested via ?debugOpen=1, otherwise require the 5-tap gesture.
      if (fromQuery || fromStorage) {
        setDebugEnabled(true);
        setDebugOpen(qs.get("debugOpen") === "1");
      }
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
    if (typeof window === "undefined") return;
    try {
      if (debugEnabled) window.localStorage.setItem(DEBUG_KEY, "1");
      else window.localStorage.removeItem(DEBUG_KEY);
    } catch (e) {
      // ignore
    }
  }, [debugEnabled]);

  const pushDebug = useCallback((level: "log" | "warn" | "error", ...args: any[]) => {
    if (!debugEnabledRef.current) return;
    try {
      const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch (e) {
            return String(a);
          }
        })
        .join(" ");
      const line = `[${ts}] ${level.toUpperCase()}: ${text}`;
      setDebugLogs((prev) => {
        const next = [...prev, line];
        return next.length > 250 ? next.slice(next.length - 250) : next;
      });
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!debugEnabled) return;

    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: any[]) => {
      origLog(...args);
      pushDebug("log", ...args);
    };
    console.warn = (...args: any[]) => {
      origWarn(...args);
      pushDebug("warn", ...args);
    };
    console.error = (...args: any[]) => {
      origError(...args);
      pushDebug("error", ...args);
    };

    const onError = (e: any) => {
      pushDebug("error", "window.error", e?.message ?? e);
    };
    const onRejection = (e: any) => {
      pushDebug("error", "unhandledrejection", e?.reason ?? e);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      pushDebug("log", "Debug enabled", {
        href: window.location.href,
        embedded: isEmbedded,
        ua: navigator.userAgent,
        apiBase: API_BASE,
      });
      console.log("[ELARALO] API_BASE =", API_BASE);
    } catch (e) {
      // ignore
    }

    return () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [debugEnabled, isEmbedded, pushDebug]);

  const secretDebugTap = useCallback(() => {
    if (typeof window === "undefined") return;

    debugTapCountRef.current += 1;

    if (debugTapTimerRef.current) window.clearTimeout(debugTapTimerRef.current);
    debugTapTimerRef.current = window.setTimeout(() => {
      debugTapCountRef.current = 0;
      debugTapTimerRef.current = null;
    }, 1400);

    if (debugTapCountRef.current >= 5) {
      debugTapCountRef.current = 0;

      if (!debugEnabledRef.current) {
        debugEnabledRef.current = true;
        setDebugEnabled(true);
      }
      setDebugOpen((v) => !v);
    }
  }, []);



  // Local audio-only TTS element (used when Live Avatar is not active/available)
  const localTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const localTtsVideoRef = useRef<HTMLVideoElement | null>(null);
  const localTtsUnlockedRef = useRef(false);
  const localTtsStopFnRef = useRef<(() => void) | null>(null);
  // Guards to cancel/ignore in-flight local TTS work when user stops communications mid-stream.
  const localTtsEpochRef = useRef(0);
  const localTtsAbortRef = useRef<AbortController | null>(null);

  // Live Avatar element ref is declared early so it can be used by the global TTS volume booster.
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);

  // ----------------------------
  // Global TTS volume boost
  // ----------------------------
  // HTMLMediaElement.volume tops out at 1.0. To reliably boost perceived loudness—especially
  // on iOS after an audio-capture session—we route TTS playback through WebAudio GainNodes.
  // This applies to:
  // - Local TTS <audio>/<video> playback (hands-free STT mode)
  // - Live Avatar <video> element playback (non-iPhone)
  // iPhone Live Avatar already routes MediaStream audio through WebAudio (see applyIphoneLiveAvatarAudioBoost).
  // Volume boost for audio-only TTS and non-iPhone Live Avatar.
  // Note: We intentionally use WebAudio gain to exceed HTMLMediaElement.volume (max 1.0).
  const TTS_GAIN = 12.0;
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const ttsAudioMediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const ttsAudioGainRef = useRef<GainNode | null>(null);
  const ttsAudioBoundElRef = useRef<HTMLMediaElement | null>(null);
  const ttsVideoMediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const ttsVideoGainRef = useRef<GainNode | null>(null);
  const ttsVideoBoundElRef = useRef<HTMLMediaElement | null>(null);
  const avatarVideoMediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const avatarVideoGainRef = useRef<GainNode | null>(null);
  const avatarVideoBoundElRef = useRef<HTMLMediaElement | null>(null);

  const ensureTtsAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    try {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;
      if (!ttsAudioCtxRef.current) ttsAudioCtxRef.current = new AudioCtx();
      const ctx = ttsAudioCtxRef.current;
      if (ctx?.state === "suspended" && ctx.resume) {
        ctx.resume().catch(() => {});
      }
      return ctx;
    } catch (e) {
      return null;
    }
  }, []);

  // "Audio session nudge" (runs on a user gesture):
  // iOS Safari can remain in a low/communications-volume route after mic capture or modal dialogs.
  // A short, low-frequency, low-amplitude burst through WebAudio helps re-establish the normal
  // playback route so subsequent audio-only TTS (hidden VIDEO path) is not silent/feeble.
  //
  // NOTE: This is intentionally slightly stronger than "inaudible" because the user's report
  // indicates iOS can otherwise remain stuck after the Clear Messages modal.
  const nudgeAudioSession = useCallback(async () => {
    const ctx = ensureTtsAudioContext();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.04;
      osc.frequency.value = 40;
      osc.connect(g);
      g.connect(ctx.destination);
      const stopAt = ctx.currentTime + 0.16;
      osc.start();
      osc.stop(stopAt);

      window.setTimeout(() => {
        try { osc.disconnect(); } catch (e) {}
        try { g.disconnect(); } catch (e) {}
      }, 220);
    } catch (e) {
      // ignore
    }
  }, [ensureTtsAudioContext]);

  // Track whether we have already connected each gain routing chain.
  const ttsAudioChainConnectedRef = useRef<boolean>(false);
  const ttsVideoChainConnectedRef = useRef<boolean>(false);
  const avatarVideoChainConnectedRef = useRef<boolean>(false);


  const applyTtsGainRouting = useCallback(
    (media: HTMLMediaElement | null, kind: "audio" | "video" | "avatar") => {
      if (!media) return;
      const ctx = ensureTtsAudioContext();
      if (!ctx) return;

      // iPhone Live Avatar uses MediaStream routing; do not double-route the <video> element.
      if (kind === "avatar" && isIphone) return;

      // IMPORTANT: Audio-only TTS must remain on the hidden <video> path, but routing
      // cross-origin media through WebAudio can result in silence on some browsers (notably iOS Safari)
      // if the media response is not CORS-enabled. To guarantee audibility, we do NOT route
      // local (audio-only) TTS through WebAudio GainNodes. (We still keep the hidden VIDEO element.)
      if (kind === "audio" || kind === "video") {
        try { media.muted = false; media.volume = 1; } catch (e) {}
        return;
      }

      try {
        // From here on, we only handle the non-iPhone Live Avatar <video> element.
        // (Audio-only TTS elements return early above to avoid WebAudio routing issues.)

        // If the underlying media element instance changed (common when Live Avatar is stopped/started),
        // we must recreate the MediaElementSourceNode. Source nodes are permanently bound to a single element.
        if (avatarVideoBoundElRef.current !== media) {
          try { avatarVideoMediaSrcRef.current?.disconnect(); } catch (e) {}
          avatarVideoMediaSrcRef.current = null;
          avatarVideoBoundElRef.current = media;
          avatarVideoChainConnectedRef.current = false;
        }

        // If we already created a MediaElementSourceNode for this media element, reuse it.
        // (Browsers throw if you call createMediaElementSource() more than once per element.)
        let src: MediaElementAudioSourceNode | null = null;
        let gain: GainNode | null = null;

        // Avatar routing
        {
          src = avatarVideoMediaSrcRef.current;
          gain = avatarVideoGainRef.current;
          if (!src) {
            src = ctx.createMediaElementSource(media);
            avatarVideoMediaSrcRef.current = src;
          }
          if (!gain) {
            gain = ctx.createGain();
            avatarVideoGainRef.current = gain;
          }
        }

        // Connect once and then only update gain. Repeated disconnect/reconnect can leave
        // iOS Safari in a bad route after modal dialogs.
        const connectOnce = (connectedRef: React.MutableRefObject<boolean>) => {
          if (connectedRef.current) return;
          try {
            src!.connect(gain!);
          } catch (e) {}
          try {
            gain!.connect(ctx.destination);
          } catch (e) {}
          connectedRef.current = true;
        };
        // kind is narrowed to "avatar" here (audio/video returned early above).
        connectOnce(avatarVideoChainConnectedRef);

        gain.gain.value = TTS_GAIN;

        // Keep element volume at max so the gain node is the only limiter.
        try {
          media.muted = false;
          media.volume = 1;
        } catch (e) {}
      } catch (e) {
        // If this fails (e.g., cross-origin media restrictions), we still keep media.volume at 1.
        try {
          media.muted = false;
          media.volume = 1;
        } catch (e) {}
      }
    },
    [ensureTtsAudioContext, isIphone]
  );

  const boostAllTtsVolumes = useCallback(() => {
    try {
      // Local (audio-only) TTS elements intentionally NOT routed through WebAudio.
      // Live avatar video element (non-iPhone)
      applyTtsGainRouting(avatarVideoRef.current, "avatar");
    } catch (e) {
      // ignore
    }
  }, [applyTtsGainRouting]);


  // Companion identity (drives persona + companion mapping)
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);
  // Optional white-label rebranding (RebrandingKey from Wix or ?rebrandingKey=...).
  // IMPORTANT: This must never alter STT/TTS start/stop code paths.
  const [rebrandingKey, setRebrandingKey] = useState<string>("");
  const [payloadBrandName, setPayloadBrandName] = useState<string>("");

  // Derive legacy single-field rebranding string from the pipe-delimited RebrandingKey.
  // Default: "" (treated as core / non-rebranded).
  const rebranding = useMemo(() => {
    const p = parseRebrandingKey(rebrandingKey || "");
    return String(p?.rebranding || "").trim();
  }, [rebrandingKey]);
  const rebrandingInfo = useMemo(() => parseRebrandingKey(rebrandingKey), [rebrandingKey]);

  const renderMsgContent = useCallback(
  (m: Msg): React.ReactNode => {
    const meta: any = (m as any)?.meta || {};
    const att: any = meta?.attachment || null;

    const attUrl = att?.url ? String(att.url) : "";
    const attName = att?.name ? String(att.name) : "attachment";
    const attType = att?.contentType ? String(att.contentType) : "";

    const isImage =
      Boolean(attUrl) &&
      ((attType && attType.toLowerCase().startsWith("image/")) ||
        /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(attUrl));

    const isVideo =
      Boolean(attUrl) &&
      ((attType && attType.toLowerCase().startsWith("video/")) ||
        /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(attUrl));

    const stripScheme = (u: string) => (u || "").replace(/^https?:/i, "");

    const paygKey = rebrandingInfo?.payGoLink ? stripScheme(rebrandingInfo.payGoLink).toLowerCase() : "";
    const upgradeKey = rebrandingInfo?.upgradeLink ? stripScheme(rebrandingInfo.upgradeLink).toLowerCase() : "";

    const renderTextWithLinks = (text: string, isAssistant: boolean): React.ReactNode => {
      const urlGlobal = /(https?:\/\/[^\s]+|\/\/[^\s]+)/g;
      const parts = (text || "").split(urlGlobal);

      return parts.map((part, idx) => {
        if (!part) return null;

        const isUrl = /^https?:\/\//i.test(part) || part.startsWith("//");
        if (!isUrl) return <span key={idx}>{part}</span>;

        // Peel trailing punctuation so it doesn't get included in the href.
        const match = part.match(/^(.*?)([\)\]\.,;:!?]+)?$/);
        const urlRaw = match?.[1] ?? part;
        const punct = match?.[2] ?? "";

        const comparable = stripScheme(urlRaw).toLowerCase();

        let label = urlRaw;
        if (isAssistant) {
          if (paygKey && comparable === paygKey) label = "Pay as you Go";
          else if (upgradeKey && comparable === upgradeKey) label = "Upgrade";
        }

        const href = urlRaw.startsWith("//") ? `https:${urlRaw}` : urlRaw;

        const isPaygoLink = Boolean(isAssistant && paygKey && comparable === paygKey);
        const midNow = String(memberIdRef.current || "").trim();
        const isNonMemberNow = !Boolean(midNow);
        const isAnonNow = isAnonMemberId(midNow);

        const onPaygoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (!isPaygoLink) return;

          // Visitors/non-members: capture email first so we can correlate the payment.
          if (isNonMemberNow || isAnonNow) {
            e.preventDefault();
            beginPaygoTopupForVisitor(href);
            return;
          }

          // Members: no email capture. Start watching for credit and let the checkout open normally.
          beginPaygoTopupForMember();
        };

        return (
          <React.Fragment key={idx}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
              onClick={isPaygoLink ? onPaygoClick : undefined}
            >
              {label}
            </a>
            {punct}
          </React.Fragment>
        );
      });
    };

    const textNode = renderTextWithLinks(m.content || "", m.role === "assistant");

    const textHasAttachmentName = Boolean(attName && String(m.content || "").toLowerCase().includes(String(attName).toLowerCase()));

    const attachmentNode = attUrl ? (
      <div style={{ marginTop: 6 }}>
        {isImage ? (
          <>
            <a href={attUrl} target="_blank" rel="noopener noreferrer">
              <img
                src={attUrl}
                alt={attName}
                style={{
                  maxWidth: 320,
                  maxHeight: 320,
                  borderRadius: 12,
                  border: "1px solid #e5e5e5",
                  display: "block",
                }}
              />
            </a>
            {!textHasAttachmentName ? (
              <div style={{ marginTop: 4 }}>
                <a href={attUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                  {attName || "Open image"}
                </a>
              </div>
            ) : null}
          </>
        ) : isVideo ? (
          <>
            <video
              src={attUrl}
              controls
              playsInline
              preload="metadata"
              style={{
                maxWidth: 320,
                maxHeight: 320,
                borderRadius: 12,
                border: "1px solid #e5e5e5",
                display: "block",
              }}
            />
            <div style={{ marginTop: 4 }}>
              <a href={attUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                {attName || "Open video"}
              </a>
            </div>
          </>
        ) : (
          <a href={attUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
            {attName || "Open attachment"}
          </a>
        )}
      </div>
    ) : null;

    return (
      <>
        {textNode}
        {attachmentNode}
      </>
    );
  },
  [rebrandingInfo]
);

const rebrandingName = useMemo(() => (rebrandingInfo?.rebranding || "").trim(), [rebrandingInfo]);
  const rebrandingSlug = useMemo(() => normalizeRebrandingSlug(rebrandingName), [rebrandingName]);

  // For rebrands, show the rebranding site's plan label when Wix provides it (e.g., "Supreme").
  const [planLabelOverride, setPlanLabelOverride] = useState<string>("");

  // Wix postMessage can arrive multiple times (init + periodic refreshes). We only want the Wix-provided
  // modePill to choose the *initial* mode (or a *changed* mode) — it must not continuously override
  // user-initiated mode switches inside the chat.
  const wixLastRequestedModeRef = useRef<Mode | null>(null);
  const wixLastFingerprintRef = useRef<string>("");
  const wixAppliedModeOnceRef = useRef<boolean>(false);

  // Upgrade URL (defaults to env; overridden by RebrandingKey when present)
  const upgradeUrl = useMemo(() => {
    const u = String(rebrandingInfo?.upgradeLink || "").trim();
    return u || UPGRADE_URL;
  }, [rebrandingInfo]);

  // Open Upgrade URL in a new tab (preferred) so the chat session stays loaded.
  // IMPORTANT: Do NOT navigate the current tab/frame. If popups are blocked, keep the chat page intact.
  const openUpgradeUrl = useCallback(() => {
    const url = String(upgradeUrl || "").trim();
    if (!url) return;

    // Best-effort new-tab open inside a user gesture.
    // We intentionally avoid window.location / window.top.location navigation to preserve the chat session.
    try {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    } catch (e) {
      // ignore
    }

    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      // ignore
    }
  }, [upgradeUrl]);

  const [companyLogoSrc, setCompanyLogoSrc] = useState<string>(DEFAULT_AVATAR);
  const companyName = useMemo(() => {
    const derived = String(
      rebrandingName ||
      payloadBrandName ||
      (parseRebrandingKey(rebrandingKey || "")?.rebranding || "") ||
      DEFAULT_COMPANY_NAME
    ).trim();
    return derived || DEFAULT_COMPANY_NAME;
  }, [rebrandingName, payloadBrandName, rebrandingKey]);
  const [companionKey, setCompanionKey] = useState<string>("");
  const [companionKeyRaw, setCompanionKeyRaw] = useState<string>("");
  const [selectedMappingAvatar, setSelectedMappingAvatar] = useState<string>("");
  const [selectedCompanionType, setSelectedCompanionType] = useState<"AI" | "Human" | "">("");

  // Viewer-only: display name used in the shared in-stream chat.
  // - Stored locally so we only prompt once per (brand, companion).
  const liveChatUsernameStorageKey = useMemo(() => {
    const b = safeBrandKey(String(companyName || "").trim() || "core") || "core";
    const a = safeBrandKey(String(companionName || "").trim() || "companion") || "companion";
    return `livekit_livechat_username:${b}:${a}`;
  }, [companyName, companionName]);

  const [viewerLiveChatName, setViewerLiveChatName] = useState<string>("");
  const [payloadUserDisplayName, setPayloadUserDisplayName] = useState<string>("");

  const preferredViewerDisplayName = useMemo(() => {
    const explicit = String(viewerLiveChatName || "").trim();
    if (explicit) return explicit;
    const payloadLabel = String(payloadUserDisplayName || "").trim();
    if (payloadLabel) return payloadLabel;
    return "";
  }, [viewerLiveChatName, payloadUserDisplayName]);

  const transcriptViewerLabel = useMemo(() => {
    return preferredViewerDisplayName || "You";
  }, [preferredViewerDisplayName]);

  const buildHostReadableViewerName = useCallback((identityValue?: string) => {
    if (preferredViewerDisplayName) return preferredViewerDisplayName;
    const raw = String(identityValue || "").trim();
    const cleaned = raw.replace(/^Anon:\s*/i, "").trim();
    const base = cleaned || raw;
    const shortId = base ? base.slice(0, 4) : "";
    return `Viewer - ${shortId || "Anon"}`;
  }, [preferredViewerDisplayName]);

  useEffect(() => {
    // Keep state in sync with persistent storage as the user switches companions/brands.
    // NOTE: In embedded/iframe contexts, localStorage may be partitioned or blocked; we keep fallbacks.
    try {
      if (typeof window === "undefined") return;

      const GLOBAL_LIVECHAT_KEY = "dm_livechat_username";

      const tryGet = (k: string): string => {
        try {
          const v = window.localStorage.getItem(k);
          if (v && String(v).trim()) return String(v).trim();
        } catch {}
        try {
          const v2 = window.sessionStorage.getItem(k);
          if (v2 && String(v2).trim()) return String(v2).trim();
        } catch {}
        return "";
      };

      let stored = tryGet(liveChatUsernameStorageKey) || tryGet(GLOBAL_LIVECHAT_KEY);

      if (!stored) {
        try {
          const nm = String((window as any).name || "");
          if (nm.startsWith("lcname:")) stored = nm.slice("lcname:".length).trim();
        } catch {}
      }

      setViewerLiveChatName(String(stored || "").trim());
    } catch {
      setViewerLiveChatName("");
    }
  }, [liveChatUsernameStorageKey]);


  // LiveKit identity conventions used by the backend:
  //   - user:<memberId> when memberId is available
  //   - anon:<random> otherwise
  // We also use this as the fallback display name when the viewer does not enter a name.
  const getLivekitSystemIdentity = useCallback((): string => {
    try {
      const mid = String(memberId || "").trim();
      if (mid) return `user:${mid}`;

      const k = "dm_livekit_anon_id_v1";
      const existing = String(window?.localStorage?.getItem(k) || "").trim();
      if (existing) return existing;

      const rnd = Math.random().toString(36).slice(2, 10);
      const anon = `anon:${Date.now().toString(36)}_${rnd}`;
      window?.localStorage?.setItem(k, anon);
      return anon;
    } catch {
      const rnd = Math.random().toString(36).slice(2, 10);
      return `anon:${Date.now().toString(36)}_${rnd}`;
    }
  }, [memberId]);

  const ensureViewerLiveChatName = useCallback((opts?: { promptText?: string }): string => {
    if (typeof window === "undefined") return "";

    const current = String(viewerLiveChatName || "").trim();
    if (current) return current;

    const payloadPreferred = String(payloadUserDisplayName || "").trim();
    if (payloadPreferred) return payloadPreferred;

    // NOTE: In restrictive iframe environments (e.g., some mobile browsers), localStorage can be
    // unavailable or non-persistent. We therefore try: localStorage -> sessionStorage -> window.name.
    const WINDOW_NAME_PREFIX = "__DM_KV__=";

    const readWindowNameKV = (): Record<string, string> => {
      try {
        const raw = String(window.name || "");
        const idx = raw.indexOf(WINDOW_NAME_PREFIX);
        if (idx === -1) return {};
        const encoded = raw.substring(idx + WINDOW_NAME_PREFIX.length);
        if (!encoded) return {};
        const json = decodeURIComponent(encoded);
        const obj = JSON.parse(json);
        return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
      } catch {
        return {};
      }
    };

    const writeWindowNameKV = (kv: Record<string, string>) => {
      try {
        const raw = String(window.name || "");
        const base = raw.split(WINDOW_NAME_PREFIX)[0]; // preserve any pre-existing prefix
        window.name = `${base}${WINDOW_NAME_PREFIX}${encodeURIComponent(JSON.stringify(kv))}`;
      } catch {
        // ignore
      }
    };

    // Per-device, we want to prompt *once*, even if brand/companion identifiers change
    // (common during rebrand flows or when companionName loads asynchronously).
    const GLOBAL_LIVECHAT_KEY = "dm_livechat_username";

    const keysToTry = (() => {
      const keys: string[] = [];
      if (liveChatUsernameStorageKey) keys.push(liveChatUsernameStorageKey);

      // Global fallback (per-device) so we don't keep re-prompting in restrictive iframe contexts.
      keys.push(GLOBAL_LIVECHAT_KEY);

      // Legacy (older builds may have used a key without companionKey)
      const legacyBase = `${safeBrandKey(companyName)}_${safeBrandKey(companionName)}_livechat_username`;
      if (legacyBase) keys.push(legacyBase);

      // Very old fallback (in case safeBrandKey or naming changed)
      const veryOld = `dulcemoon_${safeBrandKey(companionName || "companion")}_livechat_username`;
      if (veryOld) keys.push(veryOld);

      // De-dup + remove empties
      return Array.from(new Set(keys.filter(Boolean)));
    })();

    const tryGet = (fn: (k: string) => string | null): string => {
      for (const k of keysToTry) {
        try {
          const v = fn(k);
          const s = String(v || "").trim();
          if (s) return s;
        } catch {
          // ignore and keep trying
        }
      }
      return "";
    };

    const storeEverywhere = (value: string) => {
      const v = String(value || "").trim().slice(0, 50);
      if (!v) return;

      // Always write back to the primary key (current build)
      try {
        if (liveChatUsernameStorageKey) {
          window.localStorage.setItem(liveChatUsernameStorageKey, v);
        }
        window.localStorage.setItem(GLOBAL_LIVECHAT_KEY, v);
      } catch {
        // ignore
      }
      try {
        if (liveChatUsernameStorageKey) {
          window.sessionStorage.setItem(liveChatUsernameStorageKey, v);
        }
        window.sessionStorage.setItem(GLOBAL_LIVECHAT_KEY, v);
      } catch {
        // ignore
      }
      try {
        const kv = readWindowNameKV();
        if (liveChatUsernameStorageKey) {
          kv[liveChatUsernameStorageKey] = v;
        }
        kv[GLOBAL_LIVECHAT_KEY] = v;
        writeWindowNameKV(kv);
      } catch {
        // ignore
      }
    };

    // 1) localStorage
    let stored = "";
    try {
      stored = tryGet((k) => window.localStorage.getItem(k));
    } catch {
      // ignore
    }

    // 2) sessionStorage
    if (!stored) {
      try {
        stored = tryGet((k) => window.sessionStorage.getItem(k));
      } catch {
        // ignore
      }
    }

    // 3) window.name (fallback)
    if (!stored) {
      try {
        const kv = readWindowNameKV();
        for (const k of keysToTry) {
          const s = String(kv[k] || "").trim();
          if (s) {
            stored = s;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (stored) {
      const cleaned = stored.trim().slice(0, 50);
      setViewerLiveChatName(cleaned);
      storeEverywhere(cleaned);
      return cleaned;
    }

    const systemId = getLivekitSystemIdentity();

    const memberIdRaw = String(memberId || "").trim();
    const memberIdClean = memberIdRaw.replace(/^Anon:\s*/i, "").trim();
    const idForFallback = String(memberIdClean || memberIdRaw || systemId)
      .replace(/^(user:|anon:)/i, "")
      .replace(/^Anon:\s*/i, "")
      .trim();
    const shortId = idForFallback.slice(0, 4);
    const fallbackName = `Viewer - ${shortId || "Anon"}`;

    const suggested = "";
    const promptText =
      opts?.promptText || "Choose a name to display during the live session:";
    const name = window.prompt(promptText, suggested);

    // Requirement: if the viewer does not enter a name (blank or cancel), use a stable fallback like "Viewer - 1234".

    const cleaned =
      String(name ?? "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50) || fallbackName;

    setViewerLiveChatName(cleaned);
    storeEverywhere(cleaned);
    return cleaned;
  }, [viewerLiveChatName, payloadUserDisplayName, liveChatUsernameStorageKey, companyName, companionName, companionKey, memberId, getLivekitSystemIdentity]);


  const changeViewerLiveChatName = useCallback(() => {
    try {
      if (typeof window === "undefined") return;
      const existing =
        String(viewerLiveChatName || "").trim() ||
        String((() => {
          try {
            const v = window.localStorage.getItem(liveChatUsernameStorageKey);
            if (v && String(v).trim()) return v;
          } catch (e) {}
          try {
            const v2 = window.sessionStorage.getItem(liveChatUsernameStorageKey);
            if (v2 && String(v2).trim()) return v2;
          } catch (e) {}
          return "";
        })() || "").trim();

      const raw =
        window.prompt("Change your username for the live session:", existing) || "";

      const cleaned = raw
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);

      if (!cleaned) return;

      try {
        window.localStorage.setItem(liveChatUsernameStorageKey, cleaned);
      } catch (e) {
        try {
          window.sessionStorage.setItem(liveChatUsernameStorageKey, cleaned);
        } catch (e) {}
      }
      setViewerLiveChatName(cleaned);
    } catch (e) {
      // ignore
    }
  }, [viewerLiveChatName, liveChatUsernameStorageKey]);


  // DB-driven companion mapping (brand+avatar), loaded from the API (sqlite preloaded at startup).
  const [companionMapping, setCompanionMapping] = useState<CompanionMappingRow | null>(null);
  const [companionMappingResolved, setCompanionMappingResolved] = useState<boolean>(false);

  
  const [companionMappingError, setCompanionMappingError] = useState<string>("");
useEffect(() => {
    let cancelled = false;

    async function load() {
      setCompanionMappingResolved(false);

      const brand = String(companyName || "").trim();
      const displayAvatar = String(companionName || "").trim();
      const mappingAvatar = String(selectedMappingAvatar || "").trim();
      const fullKey = String(companionKey || "").trim();
      const requestedType = normalizeCompanionTypeHint(selectedCompanionType);
      const explicitAiSelection = requestedType === "AI";
      const explicitHumanSelection = requestedType === "Human";
      const filenameKeyLooksLikeAi = isAiCompanionFilenameKey(fullKey || mappingAvatar || displayAvatar);
      const isAiFilenameSelection =
        explicitAiSelection ||
        (!explicitHumanSelection && filenameKeyLooksLikeAi);
      const primaryAvatar = mappingAvatar || displayAvatar || fullKey;

      if (!brand || !primaryAvatar) {
        setCompanionMapping(null);
        setCompanionMappingError("Missing brand or avatar for companion mapping lookup.");
        setCompanionMappingResolved(true);
        return;
      }

      if (!API_BASE) {
        setCompanionMapping(null);
        setCompanionMappingError("API_BASE is not configured; cannot load companion mapping.");
        setCompanionMappingResolved(true);
        return;
      }

      const candidates = isAiFilenameSelection
        ? [
            mappingAvatar,
            primaryAvatar,
            fullKey,
            displayAvatar,
            aiFirstNameFromKey(fullKey || primaryAvatar || displayAvatar),
            aiFirstNameFromKey(mappingAvatar),
            aiFirstNameFromKey(displayAvatar),
          ]
        : [primaryAvatar];
      const lookupAvatars = Array.from(new Set(candidates.map((x) => String(x || "").trim()).filter(Boolean)));
      const errors: string[] = [];

      for (const lookupAvatar of lookupAvatars) {
        try {
          const params = new URLSearchParams();
          params.set("brand", brand);
          params.set("avatar", lookupAvatar);
          if (requestedType) params.set("companionType", requestedType);
          const url = `${API_BASE}/mappings/companion?${params.toString()}`;
          const res = await fetch(url, { method: "GET" });
          const json: any = await res.json().catch(() => ({}));
          if (cancelled) return;

          if (!res.ok) {
            const detail = readableError(json?.detail || json?.message || json?.error).trim();
            errors.push(detail || `Companion mapping request failed (${res.status} ${res.statusText}).`);
            continue;
          }

          if (!(json as any)?.found) {
            errors.push(`Companion mapping not found for brand='${brand}' avatar='${lookupAvatar}'.`);
            continue;
          }

          const resolvedSqlAvatar = String(
            (json as any)?.mappingAvatar ||
            (json as any)?.mapping_avatar ||
            (json as any)?.avatar ||
            ""
          ).trim();
          if (resolvedSqlAvatar && resolvedSqlAvatar !== mappingAvatar) {
            setSelectedMappingAvatar(resolvedSqlAvatar);
            setSessionState((prev) => ({
              ...prev,
              avatar: resolvedSqlAvatar,
              mappingAvatar: resolvedSqlAvatar,
              mapping_avatar: resolvedSqlAvatar,
            }));
          }

          setCompanionMapping(json as CompanionMappingRow);
          setCompanionMappingError("");
          setCompanionMappingResolved(true);
          return;
        } catch (e: any) {
          if (cancelled) return;
          const msg = readableError(e?.message || e || "Failed to load companion mapping.");
          errors.push(msg || "Failed to load companion mapping.");
        }
      }

      setCompanionMapping(null);
      setCompanionMappingError(errors.find(Boolean) || `Companion mapping not found for brand='${brand}' avatar='${primaryAvatar}'.`);
      setCompanionMappingResolved(true);
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [API_BASE, companyName, companionKey, companionName, selectedCompanionType, selectedMappingAvatar]);

  const preferredMappingHeadshot = useMemo(() => {
    return String((companionMapping as any)?.headshot_url || (companionMapping as any)?.headshotUrl || "").trim();
  }, [companionMapping]);

  useEffect(() => {
    const mappedHeadshot = String(preferredMappingHeadshot || "").trim();
    if (!mappedHeadshot) return;
    setAvatarSrc((prev) => {
      const p = String(prev || "").trim();
      if (p === mappedHeadshot) return prev;
      return mappedHeadshot;
    });
  }, [preferredMappingHeadshot]);

  // Auto-join active LiveKit stream as a viewer (subscribe-only)
  // Read `?rebrandingKey=...` for direct testing (outside Wix).
  // Back-compat: also accept `?rebranding=BrandName`.
  // In production, Wix should pass { rebrandingKey: "..." } via postMessage.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const hasQKey = u.searchParams.has(REBRANDING_KEY_QUERY_PARAM);
      const qKey = hasQKey ? normalizeRebrandingKeyValue(u.searchParams.get(REBRANDING_KEY_QUERY_PARAM)) : "";
      const qLegacy = normalizeRebrandingKeyValue(u.searchParams.get(LEGACY_REBRANDING_QUERY_PARAM));
      const q = hasQKey ? qKey : qLegacy;
      if (hasQKey) {
        setRebrandingKey(q);
      } else if (q) {
        setRebrandingKey(q);
      }
    } catch (e) {
      // ignore
    }
  }, []);

  // Resolve the default company logo when rebranding is active.
  // This only affects the header circle image when no companion image is available.
  useEffect(() => {
    const rawBrand = (rebrandingName || "").trim();
    const slug = (rebrandingSlug || "").trim();

    // No rebranding: revert to the default Elaralo logo.
    if (!rawBrand) {
      setCompanyLogoSrc(DEFAULT_AVATAR);

      // Keep the header image in sync if we are currently showing a company logo.
      // Do NOT override a companion headshot.
      setAvatarSrc((prev) => {
        const p = String(prev || "").trim();
        const mappedHeadshot = String(preferredMappingHeadshot || "").trim();
        if (mappedHeadshot && p === mappedHeadshot) return prev;
        if (!p) return mappedHeadshot || DEFAULT_AVATAR;

        // Covers both:
        // - "/companion/headshot/..."
        // - "/rebranding/<brand>/companion/headshot/..."
        if (isCompanionImageUrl(p)) return prev;

        if (p === DEFAULT_AVATAR) return DEFAULT_AVATAR;

        // If we were previously showing a rebrand logo, revert to default.
        if (p.includes("-logo.")) return DEFAULT_AVATAR;

        return prev;
      });

      return;
    }

    const base = slug || normalizeRebrandingSlug(rawBrand);

    const candidates: string[] = [];
    if (base) {
      // IMPORTANT:
      // - Logo assets live under frontend/public.
      // - For rebrands, the logo is now located under:
      //     /rebranding/<brand>/<brand>-logo.(png|jpg|jpeg|webp)
      // - We keep a legacy fallback for older deployments where the logo lived at site root.
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `${REBRANDING_PUBLIC_DIR}/${base}/${base}-logo.png`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `${REBRANDING_PUBLIC_DIR}/${base}/${base}-logo.jpg`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `${REBRANDING_PUBLIC_DIR}/${base}/${base}-logo.jpeg`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `${REBRANDING_PUBLIC_DIR}/${base}/${base}-logo.webp`));

      // Legacy fallback: root-level logo
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `/${base}-logo.png`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `/${base}-logo.jpg`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `/${base}-logo.jpeg`));
      candidates.push(joinUrlPrefix(APP_BASE_PATH, `/${base}-logo.webp`));
    }

    // Fallback: default Elaralo logo (imported asset)
    candidates.push(DEFAULT_AVATAR);

    let cancelled = false;

    pickFirstLoadableImage(candidates).then((picked) => {
      if (cancelled) return;

      setCompanyLogoSrc(picked);

      // If the current image is a company logo (default or previous rebrand), update it.
      // Do NOT override a companion headshot.
      setAvatarSrc((prev) => {
        const p = String(prev || "").trim();
        const mappedHeadshot = String(preferredMappingHeadshot || "").trim();
        if (mappedHeadshot && p === mappedHeadshot) return prev;
        if (!p) return mappedHeadshot || picked;

        // Covers both default + rebrand headshots.
        if (isCompanionImageUrl(p)) return prev;

        if (p === DEFAULT_AVATAR) return picked;

        // If we were showing some other "-logo.*" asset, treat it as a company logo and swap it.
        if (p.includes("-logo.")) return picked;

        return prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [rebrandingName, rebrandingSlug, preferredMappingHeadshot]);



// ----------------------------
// Live Avatar (D-ID) + TTS (ElevenLabs -> Azure Blob)
// ----------------------------
const didSrcObjectRef = useRef<any | null>(null);
const didAgentMgrRef = useRef<any | null>(null);
const didReconnectInFlightRef = useRef<boolean>(false);

// iPhone-only: boost Live Avatar audio by routing the streamed MediaStream audio through WebAudio.
// This avoids iPhone's low/receiver-like WebRTC audio output and makes the avatar clearly audible.
const didIphoneAudioCtxRef = useRef<AudioContext | null>(null);
const didIphoneAudioSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
const didIphoneAudioGainRef = useRef<GainNode | null>(null);
const didIphoneBoostActiveRef = useRef<boolean>(false);


  const [avatarStatus, setAvatarStatus] = useState<
    "idle" | "connecting" | "connected" | "reconnecting" | "waiting" | "error"
  >(
  "idle"
);
const [avatarError, setAvatarError] = useState<string | null>(null);
  // Live stream embed URL (deprecated; LiveKit uses room tokens)
  // LiveKit provider
  const LIVEKIT_URL = useMemo(() => normalizeLivekitWsUrl(String((process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "")).trim()), [normalizeLivekitWsUrl]);
  const [livekitToken, setLivekitToken] = useState<string>("");
  const [livekitHlsUrl, setLivekitHlsUrl] = useState<string>("");
  const [livekitRoomName, setLivekitRoomName] = useState<string>("");
  const [livekitRole, setLivekitRole] = useState<"unknown" | "host" | "attendee" | "viewer">("unknown");
  
  const [livekitJoinStatus, setLivekitJoinStatus] = useState<"idle" | "pending" | "joined" | "error">("idle");
  const [livekitMicEnabled, setLivekitMicEnabled] = useState<boolean>(true);
  const [livekitCameraEnabled, setLivekitCameraEnabled] = useState<boolean>(true);

  // Private conference view mode:
  //  - split: show both participants side-by-side
  //  - focus: show only the *other* participant full-frame
  const [conferenceViewMode, setConferenceViewMode] = useState<"split" | "focus">("split");

  const [livekitServerUrl, setLivekitServerUrl] = useState<string>(String(LIVEKIT_URL || "").trim());
  // LiveKit session state
  const [sessionActive, setSessionActive] = useState<boolean>(false);
  const [sessionKind, setSessionKind] = useState<SessionKind>("");

  useEffect(() => {
    // Always reset when leaving private conference.
    if (sessionKind !== "conference") setConferenceViewMode("split");
  }, [sessionKind]);

  const [sessionRoom, setSessionRoom] = useState<string>("");
  useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);
	  const [payloadHostMemberId, setPayloadHostMemberId] = useState<string>("");
	  const [payloadIsHostUser, setPayloadIsHostUser] = useState<boolean>(false);

	  const mappedHostMemberId = useMemo(() => {
	    const v = (companionMapping as any)?.hostMemberId ?? (companionMapping as any)?.host_member_id ?? "";
	    return String(v || "");
	  }, [companionMapping]);

	  const effectiveHostMemberIdForConsole = useMemo(() => {
	    const mapped = String(mappedHostMemberId || "").trim();
	    const hinted = String(payloadHostMemberId || "").trim();
	    return mapped || hinted;
	  }, [mappedHostMemberId, payloadHostMemberId]);

	  // Keep the existing mapping-based host flag unchanged for non-console behavior.
	  // Host Console uses the Wix MEMBER_PLAN host hint so it can appear before
	  // the async companion_mappings lookup completes.
	  const isHost = Boolean(memberId && mappedHostMemberId && memberId === mappedHostMemberId);
	  const isViewer = Boolean(memberId && mappedHostMemberId && memberId !== mappedHostMemberId);
	  const isHostConsoleUser = Boolean(
	    memberId &&
	      (
	        Boolean(mappedHostMemberId && memberId === mappedHostMemberId) ||
	        Boolean(payloadIsHostUser && payloadHostMemberId && memberId === payloadHostMemberId)
	      )
	  );

	  const hostConsolePublicFirstName = useMemo(() => {
	    const m: any = companionMapping || {};
	    const candidates = [
	      m.public_first_name,
	      m.publicFirstName,
	      m.public_name,
	      m.publicName,
	      m.public_display_name,
	      m.publicDisplayName,
	      m.stage_name,
	      m.stageName,
	      m.display_name,
	      m.displayName,
	      m.avatar,
	      selectedMappingAvatar,
	      companionName,
	      companionKey,
	    ];
	    for (const raw of candidates) {
	      const value = String(raw || "").trim();
	      if (!value) continue;
	      const base = splitCompanionKey(value).baseKey || value;
	      const cleaned = stripExt(base).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
	      if (!cleaned) continue;
	      const first = isAiCompanionFilenameKey(cleaned)
	        ? aiFirstNameFromKey(cleaned)
	        : (cleaned.split(/[\s-]+/, 1)[0] || "").trim();
	      if (first) return first;
	    }
	    return "Companion";
	  }, [companionMapping, selectedMappingAvatar, companionName, companionKey]);

	  useEffect(() => {
	    hostMemberIdRef.current = String(effectiveHostMemberIdForConsole || "");
	  }, [effectiveHostMemberIdForConsole]);


// ----------------------------
// Host override console (AI chat takeover)
// ----------------------------
const [hostConsoleOpen, setHostConsoleOpen] = useState<boolean>(false);
const [hostActiveChats, setHostActiveChats] = useState<HostActiveChat[]>([]);
const [hostActiveLoading, setHostActiveLoading] = useState<boolean>(false);
const [hostActiveError, setHostActiveError] = useState<string>("");
const [hostSelectedSessionId, setHostSelectedSessionId] = useState<string>("");
const [hostSelectedEvents, setHostSelectedEvents] = useState<RelayEvent[]>([]);
const [hostPendingContent, setHostPendingContent] = useState<PendingContentItem[]>([]);
const [hostPendingModalOpen, setHostPendingModalOpen] = useState<boolean>(false);
const [hostPendingActionErr, setHostPendingActionErr] = useState<string | null>(null);
const [hostPollSinceSeq, setHostPollSinceSeq] = useState<number>(0);
const hostPollSinceSeqRef = useRef<number>(0);
useEffect(() => {
  hostPollSinceSeqRef.current = hostPollSinceSeq;
}, [hostPollSinceSeq]);
const [hostSendText, setHostSendText] = useState<string>("");
const [hostNotice, setHostNotice] = useState<string>("");

// Host Console STT (speech-to-text) for host messages during override
const [hostSttRecording, setHostSttRecording] = useState<boolean>(false);
const [hostSttError, setHostSttError] = useState<string>("");
const hostSttRecorderRef = useRef<MediaRecorder | null>(null);
const hostSttStreamRef = useRef<MediaStream | null>(null);
const hostSttChunksRef = useRef<BlobPart[]>([]);

// Host Session Insights speech input for the Session Insights question box.
const [hostInsightsSttEnabled, setHostInsightsSttEnabled] = useState<boolean>(false);
const [hostInsightsSttRecording, setHostInsightsSttRecording] = useState<boolean>(false);
const [hostInsightsSttError, setHostInsightsSttError] = useState<string>("");
const hostInsightsSttEnabledRef = useRef<boolean>(false);
useEffect(() => {
  hostInsightsSttEnabledRef.current = hostInsightsSttEnabled;
}, [hostInsightsSttEnabled]);
const hostInsightsSttBusyRef = useRef<boolean>(false);
const hostInsightsSttAbortRequestedRef = useRef<boolean>(false);
const hostInsightsSttRecorderRef = useRef<MediaRecorder | null>(null);
const hostInsightsSttStreamRef = useRef<MediaStream | null>(null);
const hostInsightsSttChunksRef = useRef<BlobPart[]>([]);
const hostInsightsSttAudioCtxRef = useRef<AudioContext | null>(null);
const hostInsightsSttRafRef = useRef<number | null>(null);
const hostInsightsSttHardStopTimerRef = useRef<number | null>(null);
const hostInsightsSttLastVoiceAtRef = useRef<number>(0);
const hostInsightsSttHasSpokenRef = useRef<boolean>(false);

// Host: companion-level interaction guideline overrides (persisted; highest priority)
const [hostGuidelinesOpen, setHostGuidelinesOpen] = useState<boolean>(false);
const [hostGuidelinesText, setHostGuidelinesText] = useState<string>("");
const [hostGuidelinesSaved, setHostGuidelinesSaved] = useState<string>("");
const [hostGuidelinesLoading, setHostGuidelinesLoading] = useState<boolean>(false);
const [hostGuidelinesError, setHostGuidelinesError] = useState<string>("");
const [hostGuidelinesStatus, setHostGuidelinesStatus] = useState<string>("");

// Host: Session Insights (history across all visitors/members)
const [hostInsightsOpen, setHostInsightsOpen] = useState<boolean>(false);
const [hostInsightsUsers, setHostInsightsUsers] = useState<Array<{ memberId: string; userName?: string; lastSeen?: string; lastSeenEpoch?: number; summaryLastSeen?: string; summaryCount?: number; lastSummary?: string; minutesUsed?: number; minutesAllowed?: number; minutesRemaining?: number; minutesTotal?: number }>>([]);
const [hostInsightsSelectedMemberId, setHostInsightsSelectedMemberId] = useState<string>("");
const [hostInsightsSummaries, setHostInsightsSummaries] = useState<HostInsightsSummaryItem[]>([]);
const [hostInsightsQuestion, setHostInsightsQuestion] = useState<string>("");
const [hostInsightsAnswer, setHostInsightsAnswer] = useState<string>("");
const [hostInsightsLoading, setHostInsightsLoading] = useState<boolean>(false);
const [hostInsightsError, setHostInsightsError] = useState<string>("");
const hostInsightsUsersScrollRef = useRef<HTMLDivElement | null>(null);
const hostInsightsAnswerScrollRef = useRef<HTMLDivElement | null>(null);

useEffect(() => {
  const el = hostInsightsAnswerScrollRef.current;
  if (el) el.scrollTop = 0;
}, [hostInsightsAnswer]);

useEffect(() => {
  const el = hostInsightsUsersScrollRef.current;
  if (el && hostInsightsOpen) el.scrollTop = 0;
}, [hostInsightsOpen]);


const loadHostGuidelines = useCallback(async () => {
  try {
    if (!isHostConsoleUser) return;
    if (!API_BASE) return;

    const brand = String(companyName || "").trim();
    const avatar = String(companionName || "").trim();
    const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();
    if (!brand || !avatar || !memberId) return;

    setHostGuidelinesLoading(true);
    setHostGuidelinesError("");
    setHostGuidelinesStatus("Loading…");

    const res = await fetch(`${API_BASE}/host/companion-guidelines/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, avatar, memberId }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }

    const data: any = await res.json().catch(() => ({}));
    const text = String(data?.guidelines || "").trim();

    setHostGuidelinesSaved(text);
    setHostGuidelinesText(text);
    setHostGuidelinesStatus("Loaded");
    setHostGuidelinesLoading(false);
  } catch (e: any) {
    setHostGuidelinesLoading(false);
    setHostGuidelinesStatus("");
    setHostGuidelinesError(String(e?.message || e || "Failed to load guidelines"));
  }
}, [API_BASE, isHostConsoleUser, companyName, companionName]);

const saveHostGuidelines = useCallback(async () => {
  try {
    if (!isHostConsoleUser) return;
    if (!API_BASE) return;

    const brand = String(companyName || "").trim();
    const avatar = String(companionName || "").trim();
    const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();
    if (!brand || !avatar || !memberId) return;

    setHostGuidelinesLoading(true);
    setHostGuidelinesError("");
    setHostGuidelinesStatus("Saving…");

    const res = await fetch(`${API_BASE}/host/companion-guidelines/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, avatar, memberId, guidelines: String(hostGuidelinesText || "") }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }

    const data: any = await res.json().catch(() => ({}));
    const text = String(data?.guidelines || String(hostGuidelinesText || "")).trim();

    setHostGuidelinesSaved(text);
    setHostGuidelinesText(text);
    setHostGuidelinesStatus("Saved");
    setHostGuidelinesLoading(false);
  } catch (e: any) {
    setHostGuidelinesLoading(false);
    setHostGuidelinesStatus("");
    setHostGuidelinesError(String(e?.message || e || "Failed to save guidelines"));
  }
}, [API_BASE, isHostConsoleUser, companyName, companionName, hostGuidelinesText]);


const loadHostInsightsUsers = useCallback(async () => {
  if (!API_BASE || !isHostConsoleUser || !companyName || !companionName || !memberId) return;
  setHostInsightsLoading(true);
  setHostInsightsError("");
  try {
    const res = await fetch(`${API_BASE}/host/session-insights/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand: companyName, avatar: companionName, memberId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    setHostInsightsUsers(Array.isArray(json?.users) ? json.users : []);
  } catch (e: any) {
    setHostInsightsError(e?.message || String(e));
  } finally {
    setHostInsightsLoading(false);
  }
}, [API_BASE, isHostConsoleUser, companyName, companionName, memberId]);

const loadHostInsightsSummaries = useCallback(
  async (targetMemberId: string) => {
    if (!API_BASE || !isHostConsoleUser || !companyName || !companionName || !memberId) return;
    setHostInsightsLoading(true);
    setHostInsightsError("");
    try {
      const res = await fetch(`${API_BASE}/host/session-insights/summaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: companyName, avatar: companionName, memberId, targetMemberId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setHostInsightsSummaries(dedupeHostInsightsSummaries(Array.isArray(json?.summaries) ? json.summaries : []));
    } catch (e: any) {
      setHostInsightsError(e?.message || String(e));
    } finally {
      setHostInsightsLoading(false);
    }
  },
  [API_BASE, isHostConsoleUser, companyName, companionName, memberId]
);

const submitHostInsightsQuestion = useCallback(async (rawQuestion: string) => {
  if (!API_BASE || !isHostConsoleUser || !companyName || !companionName || !memberId) return false;
  const q = String(rawQuestion || "").trim();
  if (!q) return false;
  setHostInsightsLoading(true);
  setHostInsightsError("");
  try {
    const res = await fetch(`${API_BASE}/host/session-insights/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand: companyName,
        avatar: companionName,
        memberId,
        question: q,
        targetMemberId: hostInsightsSelectedMemberId || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    setHostInsightsAnswer(sanitizePublicModeLabelsText(json?.answer || ""));
    return true;
  } catch (e: any) {
    setHostInsightsError(e?.message || String(e));
    return false;
  } finally {
    setHostInsightsLoading(false);
  }
}, [API_BASE, isHostConsoleUser, companyName, companionName, memberId, hostInsightsSelectedMemberId]);

const askHostInsights = useCallback(async () => {
  const q = (hostInsightsQuestion || "").trim();
  if (!q) return;
  await submitHostInsightsQuestion(q);
}, [hostInsightsQuestion, submitHostInsightsQuestion]);


  const livekitRoleKnown = livekitRole !== "unknown";
  const [livekitJoinRequestId, setLivekitJoinRequestId] = useState<string>("");

  const [livekitPending, setLivekitPending] = useState<Array<any>>([]);
	const livekitPendingUnique = useMemo(() => {
		const byKey = new Map<string, any>();
		for (const r of livekitPending || []) {
			const key = String(r?.memberId || r?.requestId || "");
			if (!key) continue;
			if (!byKey.has(key)) byKey.set(key, r);
		}
		return Array.from(byKey.values());
	}, [livekitPending]);
  // Viewers must press Play to join live streams.
  // We only reset the auto-join guard when a live stream ends.
  useEffect(() => {
    if (!(sessionActive && sessionKind === "stream")) {
      autoJoinStreamRef.current = false;
    }
  }, [sessionActive, sessionKind]);

  // Host: poll join requests while a LiveKit session is active.
  useEffect(() => {
    if (!isHost) return;
    if (!API_BASE || !companyName || !companionName) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const resp = await fetch(
          `${API_BASE}/livekit/join_requests?brand=${encodeURIComponent(companyName)}&avatar=${encodeURIComponent(companionName)}`
        );
        const data: any = await resp.json().catch(() => ({}));
        const requests = Array.isArray(data?.requests) ? data.requests : [];
        const annotated = requests.map((r: any) => {
          const viewerLabel = String((r as any)?.viewer_name || r?.name || r?.viewerName || r?.username || r?.memberId || "Viewer")
            .trim()
            .slice(0, 32);
          const identity = String(r?.memberId || r?.identity || r?.requestId || "").trim();
          return { ...r, viewerLabel: viewerLabel || "Viewer", identity };
        });
        if (cancelled) return;

        const now = Date.now();
        setLivekitPending((prev) => {
          const prior = Array.isArray(prev) ? prev : [];
          const byKey = new Map<string, any>();

          for (const r of prior) {
            const key = String((r as any)?.requestId || (r as any)?.identity || (r as any)?.memberId || "").trim();
            if (!key) continue;
            byKey.set(key, r);
          }

          for (const r of annotated) {
            const key = String((r as any)?.requestId || (r as any)?.identity || (r as any)?.memberId || "").trim();
            if (!key) continue;
            byKey.set(key, { ...(r as any), _seenAt: now });
          }

          const GRACE_MS = 10000;
          const out = Array.from(byKey.values()).filter((r) => now - Number((r as any)?._seenAt || now) < GRACE_MS);

          out.sort((a, b) => Number((b as any)?.ts || 0) - Number((a as any)?.ts || 0));
          return out;
        });
      } catch {
        // Do NOT clear pending requests on transient errors; keep last known list.
      }
    };

    const id = window.setInterval(tick, 1200);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [API_BASE, companyName, companionName, isHost, sessionActive]);

  // Viewer: poll join-request status until admitted/denied.
  useEffect(() => {
    if (isHost) return;
    if (!livekitJoinRequestId) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;

      try {
        const resp = await fetch(
          `${API_BASE}/livekit/join_request_status?requestId=${encodeURIComponent(livekitJoinRequestId)}`
        );
        const data = await resp.json().catch(() => ({} as any));

        if (!resp.ok || !data?.ok) return;

        const status = String((data as any)?.status || "").toLowerCase();
        if (status === "admitted") {
          const token = String((data as any)?.token || "").trim();
          const roomName = String((data as any)?.roomName || (data as any)?.room || "").trim();
          const serverUrl = String((data as any)?.serverUrl || "").trim();
          if (!token) return;

          if (serverUrl) setLivekitServerUrl(serverUrl);
          if (roomName) {
            setLivekitRoomName(roomName);
            setSessionRoom(roomName);
            // Keep streamEventRef aligned with the active room so Live Sharing can mirror correctly.
            setStreamEventRef(roomName);
          }

          setLivekitToken(token);
          setLivekitRole("viewer");
          setSessionKind("conference");
          setSessionActive(true);
          setConferenceJoined(true);
          setLivekitJoinStatus("joined");
          setLivekitMicEnabled(true);
          setLivekitCameraEnabled(true);
          setAvatarStatus("connected");
          setStreamNotice(null);
          setLivekitJoinRequestId("");
        } else if (status === "denied" || status === "expired") {
          setStreamNotice(status === "denied" ? "Join request denied." : "Join request expired.");
          setLivekitJoinRequestId("");
          setAvatarStatus("waiting");
        }
      } catch (_err) {
        // Ignore transient errors; we will retry.
      }
    };

    const timer = window.setInterval(poll, 1000);
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [API_BASE, LIVEKIT_URL, isHost, livekitJoinRequestId]);



  const admitLivekit = useCallback(async (requestId: string) => {
    const rid = String(requestId || "").trim();
    if (!rid) return;
    await fetch(`${API_BASE}/livekit/admit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: rid, brand: companyName, avatar: companionName, memberId: memberIdRef.current || "" }),
    }).catch(() => {});
  }, [API_BASE, companyName, companionName]);

  const denyLivekit = useCallback(async (requestId: string) => {
    const rid = String(requestId || "").trim();
    if (!rid) return;
    await fetch(`${API_BASE}/livekit/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: rid, brand: companyName, avatar: companionName, memberId: memberIdRef.current || "" }),
    }).catch(() => {});
  }, [API_BASE, companyName, companionName]);

  const [streamEventRef, setStreamEventRef] = useState<string>("");
  const [streamCanStart, setStreamCanStart] = useState<boolean>(false);

  useEffect(() => {
    if (!memberId) return;
    if (!mappedHostMemberId) return;

    if (memberId === mappedHostMemberId) {
      setStreamCanStart(true);
      setLivekitRole("host");
    } else {
      setStreamCanStart(false);
      setLivekitRole((prev) => (prev === "unknown" ? "viewer" : prev));
    }
  }, [memberId, mappedHostMemberId]);

  // Priority #2 (default companion view): if there is no active live session, clear any stale
  // LiveKit + live-session UI artifacts so a fresh page load (F5) reliably lands on the default UI.
  useEffect(() => {
    if (sessionActive) return;
    if (avatarStatus !== "idle") return;

    // Stream artifacts
    joinedStreamRef.current = false;
    setStreamEventRef("");
    setLivekitToken("");
    setLivekitRoomName("");
    setLivekitHlsUrl("");
    setLivekitJoinRequestId("");

    // Conference artifacts (legacy)
    setConferenceJoined(false);

    // Host broadcast overlay artifacts
    setShowBroadcasterOverlay(false);
    setBroadcastPreparing(false);
    setBroadcastError("");
  }, [sessionActive, avatarStatus]);

  const [streamNotice, setStreamNotice] = useState<string>("");


  // Notice for Live Sharing (websocket chat)
  const [liveSharingNotice, setLiveSharingNotice] = useState<string | null>(null);

const didAvatarMedia = useMemo(() => getDidAvatarMediaFromMapping(companionMapping, companionKey || companionName), [companionMapping, companionKey, companionName]);

const channelCap: ChannelCap = useMemo(() => {
  const capRaw = String((companionMapping as any)?.channel_cap ?? (companionMapping as any)?.channelCap ?? "")
    .trim()
    .toLowerCase();

  if (capRaw === "video") return "video";
  if (capRaw === "audio") return "audio";
  return "";
}, [companionMapping]);

const liveProvider: LiveProvider = useMemo(() => {
  // SQL contract: channel_cap decides whether video/live controls exist.
  // For Audio companions, ignore stale/non-null live values so the mic remains
  // a normal audio-only STT control instead of entering Stream/D-ID guard logic.
  if (channelCap !== "video") return "";

  const liveRaw = String(companionMapping?.live || "").trim().toLowerCase();

  if (liveRaw === "stream") return "stream";
  if (liveRaw === "d-id") return "d-id";
  return "";
}, [channelCap, companionMapping]);

// SQL contract:
// - channel_cap=Video controls whether the Play button exists.
// - live=Stream or D-ID selects the provider only after Play is available/clicked.
// - D-ID credentials are used only when starting a D-ID avatar.
useEffect(() => {
  if (channelCap === "video") {
    const liveRaw = String(companionMapping?.live || "").trim();
    if (!liveRaw) {
      setCompanionMappingError(
        `Invalid companion mapping: channel_cap=Video but live is NULL/empty for brand='${String(companyName || "").trim()}' avatar='${String(companionName || "").trim()}'.`
      );
    }
  }
}, [channelCap, companionMapping, companyName, companionName]);

const streamUrl = useMemo(() => {
  const raw = String(companionKeyRaw || "").trim();
  const { flags } = splitCompanionKey(raw);
  return String(flags["streamurl"] || "").trim() || STREAM_URL;
}, [companionKeyRaw]);

const providerControlRowEnabled = useMemo(() => {
  const liveRaw = String(companionMapping?.live || "").trim().toLowerCase();
  const liveOk = liveRaw === "stream" || liveRaw === "d-id";
  return channelCap === "video" && liveOk;
}, [channelCap, companionMapping]);

const showPlayButton = useMemo(() => {
  // The SQL mapping contract controls Play visibility through channel_cap only.
  // Provider fields such as live / did are used when Play is clicked, not to decide
  // whether the Play control is displayed.
  return channelCap === "video";
}, [channelCap]);

const showConnectControls = useMemo(() => {
  // Preserve the existing DulceMoon/Wix control-row behavior, then add the Elaralo
  // app-sourced handoff case where Audio companions still need the standard Connect
  // controls but must not show Play.
  if (providerControlRowEnabled) return true;
  return isElaraloBrandName(companyName) && companionMappingResolved && Boolean(companionMapping) && !companionMappingError;
}, [providerControlRowEnabled, companyName, companionMappingResolved, companionMapping, companionMappingError]);


  // Wix templates (and some site themes) may apply a gray page background.
  // The Companion UI should always render on a white canvas.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    const prevBodyBg = document.body.style.backgroundColor;
    document.documentElement.style.backgroundColor = "#fff";
    document.body.style.backgroundColor = "#fff";
    return () => {
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
    };
  }, []);



  // UI layout
  const conversationHeight = 520;
  // UI: show the video frame whenever the user is in a Live Video session.
// For Stream (LegacyStream): show the frame immediately on Play (connecting/waiting), even before embedUrl exists,
// so the click is never perceived as a no-op and the viewer can always press Stop to exit waiting.
// LiveKit sessions (Stream + Private): keep the session frame visible whenever a session is active,
// so refreshes don't hide the live session UI.
const livekitUiActive =
  liveProvider === "stream" &&
  ((sessionActive && isHost) ||
    Boolean(livekitToken) ||
    livekitJoinStatus === "pending" ||
    avatarStatus === "connecting" ||
    avatarStatus === "waiting" ||
    avatarStatus === "connected" ||
    avatarStatus === "reconnecting" ||
    Boolean(streamEventRef) );

const showAvatarFrame =
  (liveProvider === "stream" && livekitUiActive) ||
  (Boolean(didAvatarMedia) && liveProvider === "d-id" && avatarStatus !== "idle");

  // Viewer-only: treat any active LegacyStream embed as "Live Streaming".
  // Used to hide controls that must not be available to viewers during the stream.

const cleanupIphoneLiveAvatarAudio = useCallback(() => {
  if (!didIphoneBoostActiveRef.current && !didIphoneAudioCtxRef.current) return;

  didIphoneBoostActiveRef.current = false;

  try {
    didIphoneAudioSrcRef.current?.disconnect();
  } catch (e) {}
  try {
    didIphoneAudioGainRef.current?.disconnect();
  } catch (e) {}

  didIphoneAudioSrcRef.current = null;
  didIphoneAudioGainRef.current = null;

  try {
    // Closing releases resources; we recreate on demand.
    didIphoneAudioCtxRef.current?.close?.();
  } catch (e) {}
  didIphoneAudioCtxRef.current = null;

  // Restore video element audio defaults (in case we muted it for iPhone boost)
  const vid = avatarVideoRef.current;
  if (vid) {
    try {
      vid.muted = false;
      vid.volume = 1;
    } catch (e) {}
  }
}, []);

const ensureIphoneAudioContextUnlocked = useCallback(() => {
  if (!isIphone) return;
  if (typeof window === "undefined") return;

  try {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    if (!didIphoneAudioCtxRef.current) {
      didIphoneAudioCtxRef.current = new AudioCtx();
    }

    const ctx = didIphoneAudioCtxRef.current;
    // Resume inside user gesture when possible
    if (ctx?.state === "suspended" && ctx.resume) {
      ctx.resume().catch(() => {});
    }
  } catch (e) {
    // ignore
  }
}, [isIphone]);


const requestLivekitAvPermissions = useCallback(
  async (opts: { audio?: boolean; video?: boolean; reason: string }) => {
    const wantAudio = opts.audio !== false;
    const wantVideo = opts.video !== false;

    try {
      if (typeof navigator === "undefined") return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;

      // On iOS/Safari, permission prompts are far more reliable when triggered directly
      // from the same user gesture as the "Play" click.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: wantAudio,
        video: wantVideo,
      });

      // Immediately stop; we only need permissions primed for LiveKit's own track creation.
      for (const track of stream.getTracks()) track.stop();

      return true;
    } catch (err) {
      console.warn(`[LiveKit] getUserMedia failed (${opts.reason})`, err);
      return false;
    }
  },
  [],
);

const applyIphoneLiveAvatarAudioBoost = useCallback(
  (stream: any) => {
    if (!isIphone) return;
    if (typeof window === "undefined") return;

    if (!stream || typeof stream.getAudioTracks !== "function") return;
    const tracks = stream.getAudioTracks();
    if (!tracks || tracks.length === 0) return;

    try {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      let ctx = didIphoneAudioCtxRef.current;
      if (!ctx) {
        ctx = new AudioCtx();
        didIphoneAudioCtxRef.current = ctx;
      }

      if (ctx?.state === "suspended" && ctx.resume) {
        ctx.resume().catch(() => {});
      }

      // Clear any previous routing
      try {
        didIphoneAudioSrcRef.current?.disconnect();
      } catch (e) {}
      try {
        didIphoneAudioGainRef.current?.disconnect();
      } catch (e) {}

      // Route MediaStream audio -> Gain -> destination
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();

      // Boost amount tuned for iPhone; iPad/Desktop already fine.
      // Use a higher gain because iPhone often routes WebRTC audio at a receiver-like level.
      gain.gain.value = 10.0;

      source.connect(gain);
      gain.connect(ctx.destination);

      didIphoneAudioSrcRef.current = source;
      didIphoneAudioGainRef.current = gain;
      didIphoneBoostActiveRef.current = true;

      // Mute the <video>'s audio so we don't get double audio (and avoid iPhone low WebRTC path)
      const vid = avatarVideoRef.current;
      if (vid) {
        try {
          vid.muted = true;
          vid.volume = 0;
        } catch (e) {}
      }
    } catch (e) {
      console.warn("iPhone Live Avatar audio boost failed:", e);
    }
  },
  [isIphone]
);




const stopLiveAvatar = useCallback(async () => {
  if (stopInProgressRef.current) return;
  stopInProgressRef.current = true;
  setStreamNotice(null);

  try {
    // Always tear down local media + UI state so the user can recover from a stuck session.
    cleanupIphoneLiveAvatarAudio();

    setLivekitToken("");
    setLivekitRoomName("");
    setLivekitHlsUrl("");

      // Always clear any broadcast overlay/UI state to avoid stale sessions when switching modes.
      setShowBroadcasterOverlay(false);
      setBroadcasterOverlayUrl("");
      setBroadcastPreparing(false);
      setBroadcastError(null);
    // Note: we no longer track a dedicated `streamJoined` flag.
    // The UI derives join state from `livekitUiActive`, `livekitToken`, and `avatarStatus`.
    setConferenceJoined(false);
    setAvatarStatus("idle");
    setStreamEventRef("");
    setLivekitJoinRequestId("");
    setLivekitJoinStatus("idle");
    setLivekitPending([]);
    // Do NOT wipe AI chat transcripts here. We want queued AI messages/responses to remain visible
    // after leaving a LiveKit session; only live-sharing chat should be suppressed outside a session.
    setMessages((prev: any[]) =>
      (prev || []).filter((m: any) => !Boolean(m?.meta?.liveChat))
    );
    setLiveSharingNotice(null);

    // Viewers leaving should NOT stop the live session for everyone.
    if (!isHost) {
      return;
    }

    // Host: stop *any* active session (stream OR private) to prevent stale/stuck state.
    const payload = {
      brand: companyName,
      avatar: companionName,
      memberId: memberIdRef.current || "",
    };

    // Stop both kinds defensively (backend is idempotent).
    await fetch(`${API_BASE}/stream/livekit/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);

    await fetch(`${API_BASE}/conference/livekit/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);

    // Local session reset for host (poller will reconcile too).
    setSessionActive(false);
    setSessionKind("");
    sessionActiveRef.current = false;
    streamOptOutRef.current = false;
    conferenceOptOutRef.current = false;
    setStreamCanStart(false);

    setStreamNotice("Stopped.");
  } catch (err) {
    console.error("stopLiveAvatar failed", err);
    setStreamNotice("Stop failed. Please refresh and try again.");
  } finally {
    stopInProgressRef.current = false;
  }
}, [API_BASE, companyName, companionName, cleanupIphoneLiveAvatarAudio, isHost]);

const reconnectLiveAvatar = useCallback(async () => {
  const mgr = didAgentMgrRef.current;
  if (!mgr) return;
  if (didReconnectInFlightRef.current) return;

  didReconnectInFlightRef.current = true;
  setAvatarError(null);
  setAvatarStatus("reconnecting");

  try {
    if (typeof (mgr as any).reconnect === "function") {
      await (mgr as any).reconnect();
    } else {
      // Fallback for SDK versions without reconnect()
      await mgr.disconnect();
      await mgr.connect();
    }
  } catch (err: any) {
    console.error("D-ID reconnect failed", err);
    setAvatarStatus("idle");
    setAvatarError(`Live Avatar reconnect failed: ${formatDidError(err)}`);
  } finally {
    didReconnectInFlightRef.current = false;
  }
}, []);


const startLiveAvatar = useCallback(async () => {
  setAvatarError(null);
  ensureIphoneAudioContextUnlocked();

if (liveProvider === "stream") {
  // LiveKit (Human companion) — conference + broadcast, with Pattern A lobby.
  setAvatarError(null);
  setAvatarStatus("connecting");

  // Clear any prior messages so the live session starts with a blank transcript.
  // (This keeps the live-chat pane focused on the current session.)
  setMessages([]);
  setLiveSharingNotice(null);
  setLivekitMicEnabled(true);
  setLivekitCameraEnabled(true);
  liveChatSeenIdsRef.current = new Set();
  liveChatSeenOrderRef.current = [];

  // For Hosts (and conference attendees), prime camera/microphone permissions inside this click
  // gesture so Safari/iOS doesn't silently block getUserMedia later.
  if (isHost) {
    const ok = await requestLivekitAvPermissions({ audio: true, video: true, reason: "starting a Live Stream" });
    if (!ok) {
      setAvatarStatus("error");
      setAvatarError("Microphone and camera permissions are required to start a live stream.");
      return;
    }
  }

  try {
    const embedDomain = typeof window !== "undefined" ? window.location.hostname : "";

	    // Ask server to resolve room + determine host vs viewer.
	    // NOTE: Never prompt the Host for a username.
	    const displayNameForToken = isViewer
	      ? String(ensureViewerLiveChatName() || preferredViewerDisplayName || "Viewer").trim()
	      : String(companionName || "Host").trim();

const res = await fetch(`${API_BASE}/stream/livekit/start_embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand: companyName,
        avatar: companionName,
        embedDomain,
        memberId: memberIdRef.current || "",
        displayName: displayNameForToken,
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
    }

    const canStart = !!data?.canStart;
    const roomName = String(data?.roomName || data?.sessionRoom || "").trim();
    const token = String(data?.token || "").trim();
    const role = String(data?.role || (canStart ? "host" : "viewer")).trim().toLowerCase();
    const hlsUrl = String(data?.hlsUrl || "").trim();
    const serverUrl = String((data as any)?.serverUrl || (data as any)?.server_url || "").trim();
    const hostId = String((data as any)?.hostMemberId || (data as any)?.host_member_id || "").trim();

    setLivekitRoomName(roomName);
    setLivekitHlsUrl(hlsUrl);
    setLivekitRole(role === "host" ? "host" : role === "attendee" ? "attendee" : "viewer");
    if (serverUrl) {
      setLivekitServerUrl(serverUrl);
    }
    if (hostId) {
      setLivekitHostMemberId(hostId);
    }


    if (canStart) {
      // Clear any prior live-chat messages from previous sessions in the UI.
      setMessages((prev) => prev.filter((m) => !(m as any)?.meta?.liveChat));
      // Host: connect immediately.
      setLivekitToken(token);
      setSessionActive(true);
      setSessionKind("stream");
      setSessionRoom(roomName);
      setStreamEventRef(roomName);
      setStreamNotice("");
      setAvatarStatus("connected");
      joinedStreamRef.current = true;
      return;
    }

    // Viewer: auto-join when the stream is active (subscribe-only token).
    if (token) {
      setLivekitRole("viewer");
      setLivekitRoomName(roomName);
      setLivekitToken(String(token));
      setSessionActive(true);
      setSessionKind("stream");
      setSessionRoom(roomName);
      setStreamEventRef(roomName);
      setStreamNotice("");
      setAvatarStatus("connected");
      joinedStreamRef.current = true;
      return;
    }

    // Viewer attempted to join, but no token was issued.
    // If the host is not actively streaming, treat this as "no stream" (do not enter a waiting state),
    // and optionally allow the viewer to request a private session instead.
    if (!canStart && !sessionActive) {
      setStreamNotice("No live stream is active right now.");
      setAvatarStatus("idle");
      const wantsPrivate = window.confirm(
        "No live stream is active right now.\n\nWould you like to request a private session instead?"
      );
      if (wantsPrivate) {
        await startConferenceSession();
      }
      return;
    }

    setStreamNotice("Live stream is active. Connecting…");
    setAvatarStatus("waiting");
    return;
  } catch (err: any) {
    console.error("LiveKit start failed:", err);
    setAvatarStatus("error");
    setAvatarError(`Live session failed to start. ${err?.message ? String(err.message) : String(err)}`);
    return;
  }
}

if (!didAvatarMedia) {
  setAvatarStatus("error");
  setAvatarError("Live Avatar is not configured for this companion.");
  return;
}

  if (
    avatarStatus === "connecting" ||
    avatarStatus === "connected" ||
    avatarStatus === "reconnecting"
  )
    return;

  setAvatarStatus("connecting");

  try {
    // Defensive: if something is lingering from a prior attempt, disconnect & clear.
    try {
      if (didAgentMgrRef.current) {
        await didAgentMgrRef.current.disconnect();
      }
    } catch (e) {}
    didAgentMgrRef.current = null;

    try {
      const existingStream = didSrcObjectRef.current;
      if (existingStream && typeof existingStream.getTracks === "function") {
        existingStream.getTracks().forEach((t: any) => t?.stop?.());
      }
    } catch (e) {}
    didSrcObjectRef.current = null;
    if (avatarVideoRef.current) {
      try {
        const vid = avatarVideoRef.current;
        vid.srcObject = null;
        vid.pause();
        vid.removeAttribute("src");
        (vid as any).src = "";
        vid.load?.();
      } catch (e) {
        // ignore
      }
    }

    const { createAgentManager } = await import("@d-id/client-sdk");
    // NOTE: Some versions of @d-id/client-sdk ship stricter TS types (e.g., requiring
    // additional top-level fields like `mode`) that are not present in the public
    // quickstart snippets. We keep runtime behavior aligned with D-ID docs and
    // cast the options object to `any` to avoid CI type-check failures.
    const mgr = await createAgentManager(
      didAvatarMedia.didAgentId,
      {
      auth: { type: "key", clientKey: didAvatarMedia.didClientKey },
      callbacks: {
        onConnectionStateChange: (state: any) => {
          if (state === "connected") {
            setAvatarStatus("connected");
            setAvatarError(null);
          }
          if (state === "disconnected" || state === "closed") setAvatarStatus("idle");
        },

        // Mandatory per D-ID docs: bind the streamed MediaStream to the <video>.
        onSrcObjectReady: (value: any) => {
          didSrcObjectRef.current = value;
          const vid = avatarVideoRef.current;
          if (vid) {
            // If we were showing the presenter's idle_video, clear it before attaching the MediaStream
            try {
              vid.removeAttribute("src");
              (vid as any).src = "";
              vid.load?.();
            } catch (e) {
              // ignore
            }
            vid.loop = false;
            vid.srcObject = value;
            vid.play().catch(() => {});
            // iPhone: route WebRTC audio through WebAudio gain so volume is audible
            applyIphoneLiveAvatarAudioBoost(value);

            // Non-iPhone: also route the <video> element through a gain node to ensure robust volume.
            try {
              applyTtsGainRouting(vid, "avatar");
            } catch (e) {}
          }
          return value;
        },

        onVideoStateChange: (state: any) => {
          const vid = avatarVideoRef.current;
          if (!vid) return;

          const s = typeof state === "string" ? state : String(state ?? "");
          const mgr = didAgentMgrRef.current;
          const stream = didSrcObjectRef.current;

          // When the live stream stops, switch to the presenter's idle_video so the avatar isn't frozen.
          if (s === "STOP") {
            const idleUrl = mgr?.agent?.presenter?.idle_video;
            if (idleUrl) {
              try {
                // Detach the MediaStream (do NOT stop tracks; we may resume).
                vid.srcObject = null;
                if (vid.src !== idleUrl) vid.src = idleUrl;
                vid.loop = true;
                vid.play().catch(() => {});
              } catch (e) {
                // ignore
              }
            }
            return;
          }

          // Any non-STOP state: ensure we are showing the live MediaStream.
          if (stream) {
            try {
              // Clear idle video if it was set
              if (vid.src) {
                vid.pause();
                vid.removeAttribute("src");
                (vid as any).src = "";
                vid.load?.();
              }
              vid.loop = false;
              vid.srcObject = stream;
              vid.play().catch(() => {});
            } catch (e) {
              // ignore
            }
          }
        },

        onError: (err: any) => {
          if (isDidSessionError(err)) {
            console.warn("D-ID SessionError; attempting reconnect", err);
            void reconnectLiveAvatar();
            return;
          }
          setAvatarStatus("error");
          setAvatarError(formatDidError(err));
        },
      },
      streamOptions: { compatibilityMode: "auto", streamWarmup: true },
      } as any
    );

    didAgentMgrRef.current = mgr;
    await mgr.connect();
  } catch (e) {
    setAvatarStatus("error");
    setAvatarError(e?.message ? String(e.message) : "Failed to start Live Avatar");
    didAgentMgrRef.current = null;
  }
}, [didAvatarMedia, avatarStatus, liveProvider, streamUrl, companyName, companionName, reconnectLiveAvatar, ensureIphoneAudioContextUnlocked, applyIphoneLiveAvatarAudioBoost, requestLivekitAvPermissions]);

useEffect(() => {
  // Stop when switching companions
  void stopLiveAvatar();
}, [companionKey]); // eslint-disable-line react-hooks/exhaustive-deps

const companionPhonetic = useMemo(() => {
  const m: any = companionMapping || {};
  return String(
    m.phonetic ??
    m.mapping_phonetic ??
    m.mappingPhonetic ??
    m.companion_phonetic ??
    m.companionPhonetic ??
    ""
  ).trim();
}, [companionMapping]);

const getTtsAudioUrl = useCallback(async (text: string, voiceId: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const currentBrand = String(companyName || "").trim();
    const currentCompanionName = String(companionName || "").trim();
    const currentMappingAvatar = String(selectedMappingAvatar || currentCompanionName || "").trim();
    const currentCompanionKey = String(companionKey || "").trim();
    const currentCompanionType = String(selectedCompanionType || "").trim();
    const currentPhonetic = String(companionPhonetic || "").trim();

    const res = await fetch(`${API_BASE}/tts/audio-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        session_id: sessionIdRef.current || "anon",
        voice_id: voiceId,
        brand: currentBrand,
        // Use the SQL mapping avatar for phonetic lookup. For DulceMoon this is
        // "Dulce", while companionKey can remain "Dulce-Female-Black-Millennials".
        avatar: currentMappingAvatar || currentCompanionName,
        mappingAvatar: currentMappingAvatar,
        mapping_avatar: currentMappingAvatar,
        companionName: currentCompanionName,
        companion_name: currentCompanionName,
        companionKey: currentCompanionKey,
        companion_key: currentCompanionKey,
        companionType: currentCompanionType,
        companion_type: currentCompanionType,
        phonetic: currentPhonetic,
        mapping_phonetic: currentPhonetic,
        mappingPhonetic: currentPhonetic,
        companion_phonetic: currentPhonetic,
        companionPhonetic: currentPhonetic,
        text,
      }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.warn("TTS/audio-url failed:", res.status, msg);
      return null;
    }

    const data = (await res.json()) as { audio_url?: string };
    return data.audio_url || null;
  } catch (e) {
    console.warn("TTS/audio-url error:", e);
    return null;
  }
}, [
  API_BASE,
  companyName,
  companionName,
  companionKey,
  selectedMappingAvatar,
  selectedCompanionType,
  companionPhonetic,
]);

  type SpeakAssistantHooks = {
    // Called right before we ask D-ID to speak.
    // Used to delay the assistant text until the avatar begins speaking.
    onWillSpeak?: () => void;
    // Called when we cannot / did not speak via D-ID.
    onDidNotSpeak?: () => void;
  };

  // ---------- Local (audio-only) TTS playback ----------
  // Used when Live Avatar is NOT active/available, but the user is in hands-free STT mode.
  // iOS Safari requires a user gesture to "unlock" programmatic audio playback, so we prime
  // this hidden <audio> element on the first mic click.
  const PRIME_SILENT_MP3 =
    "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAJAAAEXgBBQUFBQUFBQUFBQVlZWVlZWVlZWVlZcXFxcXFxcXFxcXGIiIiIiIiIiIiIiKCgoKCgoKCgoKCguLi4uLi4uLi4uLjQ0NDQ0NDQ0NDQ0Ojo6Ojo6Ojo6Ojo//////////////8AAAAATGF2YzU5LjM3AAAAAAAAAAAAAAAAJAPMAAAAAAAABF6gwS6ZAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxM+DwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

  const primeLocalTtsAudio = useCallback((force: boolean = false) => {
    // iOS/Safari autoplay rules: unlocking media MUST happen synchronously in a user gesture
    // (e.g., mic button tap). We "prime" a hidden media element with a tiny silent MP3.
    if (!force && localTtsUnlockedRef.current) return;
    if (force) localTtsUnlockedRef.current = false;

    let unlocked = false;
    const markUnlocked = () => {
      if (unlocked) return;
      unlocked = true;
      localTtsUnlockedRef.current = true;
      console.log("Local TTS unlocked");
    };

    const prime = (m: HTMLMediaElement | null, label: string) => {
      if (!m) return;
      try {
        // Load a tiny silent MP3 and attempt play/pause.
        m.src = PRIME_SILENT_MP3;
        m.muted = false;
        m.volume = 1;

        // playsinline helps on iOS; safe to set on audio too.
        try {
          (m as any).playsInline = true;
          (m as any).setAttribute?.("playsinline", "");
        } catch (e) {}

        const p = m.play();
        Promise.resolve(p)
          .then(() => {
            markUnlocked();
            try {
              m.pause();
            } catch (e) {}
            try {
              (m as any).currentTime = 0;
            } catch (e) {}
          })
          .catch((e) => {
            const nm = (e as any)?.name;
            // AbortError is common when the browser interrupts autoplay/prime attempts; it is not actionable.
            if (nm === "AbortError") return;
            console.warn("Failed to prime local TTS", {
              mediaTag: m.tagName,
              err: String(e),
              name: nm,
              message: (e as any)?.message,
            });
          });
      } catch (e) {
        console.warn("Failed to prime local TTS", {
            mediaTag: m.tagName,
          err: String(e),
          name: (e as any)?.name,
          message: (e as any)?.message,
        });
      }
    };

    // Prime BOTH. iOS prefers the hidden VIDEO element (routes like Live Avatar),
    // but we also prime the AUDIO element as fallback.
    prime(localTtsVideoRef.current, "video");
    prime(localTtsAudioRef.current, "audio");

    // Ensure boosted routing is in place after priming.
    try {
      boostAllTtsVolumes();
    } catch (e) {}

    // If neither succeeds, localTtsUnlockedRef remains false and we'll retry on the next user gesture.
  }, []);

const playLocalTtsUrl = useCallback(
    async (url: string, hooks?: SpeakAssistantHooks) => {
      const audioEl = localTtsAudioRef.current;
      const videoEl = localTtsVideoRef.current;

      // iOS Safari can route <audio> to the receiver (or mute it) after mic/STT.
      // Using a hidden <video> element often matches Live Avatar output routing (speaker).
      //
      // IMPORTANT (Elaralo stability rule): Always route audio-only TTS through the hidden VIDEO
      // element. Alternate <audio> playback paths have proven unstable across devices.
      const forceHiddenVideo = true;
      const preferVideo = !!videoEl && (isIOS || forceHiddenVideo);

      const stopWebSpeechIfNeeded = async () => {
        if (!(isIOS && sttRecRef.current)) return;

        const rec = sttRecRef.current;
        try {
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };

            const prevOnEnd = (rec as any).onend;
            (rec as any).onend = (...args: any[]) => {
              try {
                prevOnEnd?.(...args);
              } catch (e) {}
              finish();
            };

            try {
              rec.stop();
            } catch (e) {
              finish();
            }

            // Safety if onend never arrives
            setTimeout(finish, 220);
          });
        } catch (e) {
          // ignore
        }
      };

      const playOn = async (m: HTMLMediaElement, useVideo: boolean): Promise<boolean> => {
        await stopWebSpeechIfNeeded();

        // Give Safari a beat to swap audio-session away from capture.
        if (isIOS) await new Promise((r) => setTimeout(r, 180));

        // Cache-bust on iOS (some devices can aggressively cache the same URL path).
        const finalUrl = isIOS ? `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}` : url;

        // Prepare element
        try {
          m.pause();
          m.currentTime = 0;
        } catch (e) {}

        try {
        } catch (e) {}

        if (useVideo) {
          try {
            const v = m as HTMLVideoElement;
            v.playsInline = true;
            v.setAttribute("playsinline", "true");
            v.setAttribute("webkit-playsinline", "true");
          } catch (e) {}
        }

        try {
          m.muted = false;
          m.volume = 1;
        } catch (e) {}


        // Local (audio-only) TTS stays on the hidden VIDEO element, but we do not
        // route it through WebAudio (can cause silence with non-CORS media).
        try { m.muted = false; m.volume = 1; } catch (e) {}

        try {
          (m as any).preload = "auto";
        } catch (e) {}

        try {
          m.src = finalUrl;
          try {
            (m as any).load?.();
          } catch (e) {}
        } catch (e) {}

        try {
          hooks?.onWillSpeak?.();
        } catch (e) {}

        try {
          await m.play();
          localTtsUnlockedRef.current = true;
          // iOS Safari can sometimes resolve play() but keep media effectively paused/silent.
          // Confirm playback actually started before we proceed.
          const started = await new Promise<boolean>((resolve) => {
            let settled = false;

            function finish(ok: boolean) {
              if (settled) return;
              settled = true;
              try {
                m.removeEventListener("playing", onPlaying);
                m.removeEventListener("timeupdate", onTimeUpdate);
                m.removeEventListener("error", onErr);
              } catch (e) {}
              resolve(ok);
            }

            function onPlaying() {
              finish(true);
            }
            function onTimeUpdate() {
              if (m.currentTime > 0) finish(true);
            }
            function onErr() {
              finish(false);
            }

            try {
              m.addEventListener("playing", onPlaying, { once: true });
              m.addEventListener("timeupdate", onTimeUpdate);
              m.addEventListener("error", onErr, { once: true });
            } catch (e) {
              // If we can't attach events, just accept.
              finish(true);
              return;
            }

            setTimeout(() => {
              finish(m.currentTime > 0 || !m.paused);
            }, 600);
          });

          if (!started) {
            try {
              m.pause();
              m.currentTime = 0;
            } catch (e) {}
            return false;
          }
        } catch (e) {
          console.warn("Local TTS playback failed:", {
            mediaTag: m.tagName,
            err: String(e),
            name: (e as any)?.name,
            message: (e as any)?.message,
            readyState: m.readyState,
            networkState: m.networkState,
            src: (m as any).currentSrc || m.src,
            mediaError: m.error ? { code: m.error.code } : null,
          });
          localTtsUnlockedRef.current = false;
          return false;
        }

        await new Promise<void>((resolve) => {
          let done = false;

          const cleanup = () => {
            if (done) return;
            done = true;

            // If the Stop button was wired to this playback, clear it.
            if (localTtsStopFnRef.current === cleanup) {
              localTtsStopFnRef.current = null;
            }

            m.onended = null;
            m.onerror = null;
            m.onabort = null;
            m.onloadedmetadata = null;
            m.ondurationchange = null;
            if (hardTimer != null) {
              window.clearTimeout(hardTimer);
              hardTimer = null;
            }

            try {
              m.pause();
              m.currentTime = 0;
            } catch (e) {}

            // iOS Safari sometimes gets "stuck" if we leave the src attached.
            if (isIOS) {
              try {
                m.removeAttribute("src");
                (m as any).load?.();
              } catch (e) {}
            }

            resolve();
          };

          // Allow the Stop button to interrupt the currently playing local TTS.
          localTtsStopFnRef.current = cleanup;

          m.onended = cleanup;
          m.onerror = cleanup;
          m.onabort = cleanup;

          // Hard timeout if Safari never fires ended
          // Safari occasionally fails to fire `ended`. Use a duration-aware hard timeout
          // so we *don't* cut off longer audio, but we also don't hang forever.
          let hardTimer: number | null = null;

          const armHardTimeout = (ms: number) => {
            if (hardTimer != null) window.clearTimeout(hardTimer);
            hardTimer = window.setTimeout(() => cleanup(), ms);
          };

          // Start with a generous fallback; tighten once duration is known.
          armHardTimeout(90_000);

          const maybeTightenHardTimeout = () => {
            const d = Number.isFinite(m.duration) ? m.duration : NaN;
            if (!Number.isFinite(d) || d <= 0) return;
            // duration is seconds; add a small buffer
            const ms = Math.min(5 * 60_000, Math.max(15_000, Math.ceil(d * 1000) + 2_000));
            armHardTimeout(ms);
          };

          m.onloadedmetadata = maybeTightenHardTimeout;
          m.ondurationchange = maybeTightenHardTimeout;

        });

        return true;
      };

      // Elaralo policy: prefer the hidden VIDEO element for all audio-only TTS playback.
      // We intentionally do NOT fall back to <audio> because alternate paths have been unstable
      // across devices (and historically caused STT regressions after playback in some browsers).
      if (preferVideo && videoEl) {
        const ok = await playOn(videoEl, true);
        if (ok) return;

        try {
          hooks?.onDidNotSpeak?.();
        } catch (e) {}
        return;
      }

      // Only allow <audio> fallback if hidden-video TTS has been explicitly disabled.
      if (!forceHiddenVideo && audioEl) {
        const ok = await playOn(audioEl, false);
        if (ok) return;
      }

      try {
        hooks?.onDidNotSpeak?.();
      } catch (e) {}
    },
    [isIOS, applyTtsGainRouting],
  );

  // Stop any in-progress local (audio-only) TTS playback immediately.
  // This is required so the Stop button can reliably interrupt audio-only conversations.
  const stopLocalTtsPlayback = useCallback(() => {
    try {
      localTtsStopFnRef.current?.();
    } catch (e) {
      // ignore
    }
    localTtsStopFnRef.current = null;

    const a = localTtsAudioRef.current;
    if (a) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (e) {}
      try {
        a.removeAttribute("src");
        (a as any).load?.();
      } catch (e) {}
    }

    const v = localTtsVideoRef.current;
    if (v) {
      try {
        v.pause();
        v.currentTime = 0;
      } catch (e) {}
      try {
        v.removeAttribute("src");
        (v as any).load?.();
      } catch (e) {}
    }
  }, []);

  const speakLocalTtsReply = useCallback(
    async (replyText: string, voiceId: string, hooks?: SpeakAssistantHooks) => {
      const clean = (replyText || "").trim();
      if (!clean) {
        hooks?.onDidNotSpeak?.();
        return;
      }

      // Guard against mid-stream Stop/Save/Clear: cancel any in-flight request and ignore late results.
      const epoch = localTtsEpochRef.current;
      try {
        localTtsAbortRef.current?.abort();
      } catch (e) {}
      const controller = new AbortController();
      localTtsAbortRef.current = controller;

      const audioUrl = await getTtsAudioUrl(clean, voiceId, controller.signal);
      if (controller.signal.aborted || localTtsEpochRef.current != epoch) {
        // Stop/Save/Clear happened while we were generating the audio URL.
        hooks?.onDidNotSpeak?.();
        return;
      }
      if (!audioUrl) {
        hooks?.onDidNotSpeak?.();
        return;
      }

      // If a stop happens during playback start, playLocalTtsUrl will be interrupted by stopLocalTtsPlayback().
      if (localTtsEpochRef.current != epoch) {
        hooks?.onDidNotSpeak?.();
        return;
      }

      // Re-assert the loud playback route immediately before local TTS starts.
      try { boostAllTtsVolumes(); } catch (e) {}
      try { await nudgeAudioSession(); } catch (e) {}
      try { primeLocalTtsAudio(true); } catch (e) {}
      try { void ensureIphoneAudioContextUnlocked(); } catch (e) {}

      await playLocalTtsUrl(audioUrl, hooks);
    },
    [
      getTtsAudioUrl,
      playLocalTtsUrl,
      boostAllTtsVolumes,
      nudgeAudioSession,
      primeLocalTtsAudio,
      ensureIphoneAudioContextUnlocked,
    ]
  );


const speakAssistantReply = useCallback(
    async (replyText: string, hooks?: SpeakAssistantHooks) => {
    // NOTE: We intentionally keep STT paused while the avatar is speaking.
    // The D-ID SDK's speak() promise can resolve before audio playback finishes,
    // so we add a best-effort duration wait to prevent STT feedback (avatar "talking to itself").
    const clean = (replyText || "").trim();

    const callDidNotSpeak = () => {
      try {
        hooks?.onDidNotSpeak?.();
      } catch (e) {
        // ignore
      }
    };

    let willSpeakCalled = false;
    const callWillSpeakOnce = () => {
      if (willSpeakCalled) return;
      willSpeakCalled = true;
      try {
        hooks?.onWillSpeak?.();
      } catch (e) {
        // ignore
      }
    };

    if (!clean) {
      callDidNotSpeak();
      return;
    }
    if (clean.startsWith("Error:")) {
      callDidNotSpeak();
      return;
    }

    if (avatarStatus !== "connected") {
      callDidNotSpeak();
      return;
    }
    if (!didAvatarMedia) {
      callDidNotSpeak();
      return;
    }

    const audioUrl = await getTtsAudioUrl(clean, didAvatarMedia.elevenVoiceId);
    if (!audioUrl) {
      callDidNotSpeak();
      return;
    }

    // Estimate duration (fallback) based on text length.
    const estimateSpeechMs = (text: string) => {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      // Typical conversational pace ~160-175 WPM. Use a slightly slower rate to be safe.
      const wpm = 160;
      const baseMs = (words / wpm) * 60_000;
      const punctPausesMs = (text.match(/[.!?]/g) || []).length * 250;
      return Math.min(60_000, Math.max(1_200, Math.round(baseMs + punctPausesMs)));
    };

    const fallbackMs = estimateSpeechMs(clean);

    // Best-effort: read actual audio duration from the blob URL (if metadata is accessible).
    const probeAudioDurationMs = (url: string, fallback: number) =>
      new Promise<number>((resolve) => {
        if (typeof Audio === "undefined") return resolve(fallback);
        const a = new Audio();
        a.preload = "metadata";
        // Some CDNs require this for cross-origin metadata access (best-effort).
        try {
        } catch (e) {
          // ignore
        }

        let doneCalled = false;
        const done = (ms: number) => {
          if (doneCalled) return;
          doneCalled = true;
          try {
            a.onloadedmetadata = null as any;
            a.onerror = null as any;
          } catch (e) {
            // ignore
          }
          // release resource
          try {
            a.src = "";
          } catch (e) {
            // ignore
          }
          resolve(ms);
        };

        const t = window.setTimeout(() => done(fallback), 2500);

        a.onloadedmetadata = () => {
          window.clearTimeout(t);
          const d = a.duration;
          if (typeof d === "number" && isFinite(d) && d > 0) return done(Math.round(d * 1000));
          return done(fallback);
        };
        a.onerror = () => {
          window.clearTimeout(t);
          return done(fallback);
        };

        a.src = url;
      });

    const durationMsPromise = probeAudioDurationMs(audioUrl, fallbackMs);

    const speakPayload = {
      type: "audio",
      audio_url: audioUrl,
      audioType: "audio/mpeg",
    } as any;

    let spoke = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const mgr = didAgentMgrRef.current;
      if (!mgr) {
        callDidNotSpeak();
        return;
      }

      try {
        callWillSpeakOnce();
        await mgr.speak(speakPayload);
        spoke = true;
        break;
      } catch (e) {
        if (attempt === 0 && isDidSessionError(e)) {
          console.warn("D-ID session error during speak; reconnecting and retrying...", e);
          await reconnectLiveAvatar();
          continue;
        }
        console.warn("D-ID speak failed:", e);
        setAvatarError(formatDidError(e));
        callDidNotSpeak();
        return;
      }
    }

    if (!spoke) {
      callDidNotSpeak();
      return;
    }

    // Wait for audio playback to finish (plus buffer) before allowing STT to resume.
    const durationMs = await durationMsPromise;
    const waitMs = Math.min(90_000, Math.max(fallbackMs, durationMs) + 900);
    await new Promise((r) => window.setTimeout(r, waitMs));
  },
  [avatarStatus, didAvatarMedia, getTtsAudioUrl, reconnectLiveAvatar]
);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "ELARALO_SESSION_ID";
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = (crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(key, id);
    }
    sessionIdRef.current = id;
  }, []);

  const [input, setInput] = useState("");
  const inputElRef = useRef<HTMLInputElement | null>(null);
  // Attachments (image uploads to Azure Blob via backend)
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<UploadedAttachment | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string>("");

  const [messages, setMessages] = useState<Msg[]>([]);

  // Translation/language state must be declared before any hooks that list these
  // values in dependency arrays. Keeping them here avoids block-scoped TDZ
  // build failures during Next.js type checking.
  const initialLanguagePreferenceRef = useRef<DetectedLanguagePreference>(detectInitialLanguagePreference());
  const [userLanguageCode, setUserLanguageCode] = useState<string>(() => normalizeLanguageTag(initialLanguagePreferenceRef.current.code) || "en");
  const [userLanguagePreferenceKnown, setUserLanguagePreferenceKnown] = useState<boolean>(() => Boolean(initialLanguagePreferenceRef.current.known));
  const userLanguageName = useMemo(() => languageNameFromCode(userLanguageCode), [userLanguageCode]);
  const translatorEnabled = useMemo(
    () => Boolean(userLanguagePreferenceKnown) && !isEnglishLanguage(userLanguageCode),
    [userLanguagePreferenceKnown, userLanguageCode]
  );
  const sttLanguageHintCode = useMemo(
    () => normalizeLanguageTag(userLanguagePreferenceKnown ? userLanguageCode : initialLanguagePreferenceRef.current.code) || "en",
    [userLanguagePreferenceKnown, userLanguageCode]
  );
  const assistantConversationLanguageCode = translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en";
  const assistantConversationLanguageName = translatorEnabled
    ? (userLanguageName || languageNameFromCode(userLanguageCode || ""))
    : "English";
  const assistantSpeechLanguageCode = "en";
  const assistantSpeechLanguageName = "English";

  const applyUserTurnTranslationByClientId = useCallback((clientTurnId: string, rawTranslation: any, fallbackDisplayText: string = "") => {
    const id = String(clientTurnId || "").trim();
    if (!id) return;
    const translationMeta = buildTranslationMeta(rawTranslation, fallbackDisplayText);
    if (!translationMeta) return;

    setMessages((prev) => {
      if (!Array.isArray(prev) || !prev.length) return prev as any;
      const next = prev.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        const msg: any = next[i];
        if (!msg || String(msg.role || "") !== "user") continue;
        if (String(msg?.meta?.clientTurnId || "") !== id) continue;
        next[i] = {
          ...(msg as any),
          meta: {
            ...(msg?.meta || {}),
            translation: translationMeta,
            englishText: translationMeta.englishText || msg?.meta?.englishText || "",
            english_text: translationMeta.englishText || msg?.meta?.english_text || "",
          },
        };
        return next;
      }
      return prev;
    });
  }, []);

// Relay polling for host override (member side)
const [relaySinceSeq, setRelaySinceSeq] = useState<number>(0);
const relaySinceSeqRef = useRef<number>(0);
useEffect(() => {
  relaySinceSeqRef.current = relaySinceSeq;
}, [relaySinceSeq]);


// Member-side relay poll: receives host/system messages during a host override.
useEffect(() => {
  if (isHost) return;
  if (!API_BASE) return;

  const sid = sessionIdRef.current;
  if (!sid) return;

  let cancelled = false;
  let timer: any = null;

  const pollOnce = async () => {
    try {
      const shouldPoll =
        (messagesRef.current?.length || 0) > 0 ||
        Boolean((sessionStateRef.current as any)?.host_override_active);

      if (!shouldPoll) return;

      const rawBrand =
        (parseRebrandingKey(rebrandingKey || "")?.rebranding ||
          companyName ||
          DEFAULT_COMPANY_NAME ||
          "").trim();

      const brandKey = safeBrandKey(rawBrand);
      const memberIdForBackend =
        (String(memberIdRef.current || "").trim() ||
          getOrCreateAnonMemberId(brandKey) ||
          "").trim();

      const companionForBackend =
        ((companionKey || "").trim() ||
          (companionName || DEFAULT_COMPANION_NAME).trim() ||
          DEFAULT_COMPANION_NAME).trim();

      const pollSessionState: SessionState = {
        ...(sessionStateRef.current as any),

        memberId: memberIdForBackend,
        member_id: memberIdForBackend,

        companion: companionForBackend,
        companionName: companionForBackend,
        companion_name: companionForBackend,

        // Brand/avatar are used by the backend for host override scoping and (optionally) TTS.
        brand: (companyName || "").trim(),
        avatar: (selectedMappingAvatar || companionName || "").trim(),
        mappingAvatar: (selectedMappingAvatar || companionName || "").trim(),
        mapping_avatar: (selectedMappingAvatar || companionName || "").trim(),
        companionType: selectedCompanionType,
        companion_type: selectedCompanionType,
        phonetic: companionPhonetic,
        mapping_phonetic: companionPhonetic,
        mappingPhonetic: companionPhonetic,
        companion_phonetic: companionPhonetic,
        companionPhonetic: companionPhonetic,

        translator_enabled: translatorEnabled,
        translation_enabled: translatorEnabled,
        translationEnabled: translatorEnabled,
        user_language_code: normalizeLanguageTag(userLanguageCode) || "en",
        userLanguageCode: normalizeLanguageTag(userLanguageCode) || "en",
        user_language_name: userLanguageName,
        userLanguageName: userLanguageName,
        user_language_preference_known: userLanguagePreferenceKnown,
        userLanguagePreferenceKnown: userLanguagePreferenceKnown,
        language_preference_known: userLanguagePreferenceKnown,
        languagePreferenceKnown: userLanguagePreferenceKnown,
        user_language_hint_code: normalizeLanguageTag(sttLanguageHintCode) || "en",
        userLanguageHintCode: normalizeLanguageTag(sttLanguageHintCode) || "en",
        display_language_code: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
        displayLanguageCode: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
        assistant_language_code: assistantConversationLanguageCode,
        assistantLanguageCode: assistantConversationLanguageCode,
        assistant_language_name: assistantConversationLanguageName,
        assistantLanguageName: assistantConversationLanguageName,
        assistant_speech_language_code: assistantSpeechLanguageCode,
        assistantSpeechLanguageCode: assistantSpeechLanguageCode,
        assistant_speech_language_name: assistantSpeechLanguageName,
        assistantSpeechLanguageName: assistantSpeechLanguageName,
        assistant_source_language_code: assistantSpeechLanguageCode,
        assistantSourceLanguageCode: assistantSpeechLanguageCode,
        assistant_source_language_name: assistantSpeechLanguageName,
        assistantSourceLanguageName: assistantSpeechLanguageName,

        rebrandingKey: stripTrialControlsFromRebrandingKey(rebrandingKey),
        rebranding: rawBrand,
      };

      const res = await fetch(`${API_BASE}/chat/relay/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sid,
          since_seq: relaySinceSeqRef.current,
          session_state: pollSessionState,
        }),
      });

      if (!res.ok) return;
      const data = (await res.json()) as {
        events?: RelayEvent[];
        next_since_seq?: number;
        override_active?: boolean;
      };

      if (cancelled) return;

      const nextSince =
        typeof data.next_since_seq === "number"
          ? data.next_since_seq
          : relaySinceSeqRef.current;

      if (nextSince !== relaySinceSeqRef.current) {
        setRelaySinceSeq(nextSince);
      }

      if (typeof data.override_active === "boolean") {
        setSessionState((prev) => ({
          ...prev,
          host_override_active: data.override_active,
        }));
      }

      const evs = Array.isArray(data.events) ? data.events : [];
      if (evs.length) {
        setMessages((prev) => {
          const out = [...prev];
          for (const ev of evs) {
            const sender = String((ev as any).sender || "");
            const kind = String((ev as any).kind || "");
            const role = String((ev as any).role || "");
            const payload = (ev as any).payload;

            // Host/system-pushed scheduled content attachment(s)
            if (kind === "user_content" && payload) {
              const msgs = buildContentAssistantMsgs(payload as any);
              if (msgs.length) out.push(...(msgs as any));
              continue;
            }

            const content = relayEventUserFacingText(ev);
            if (!content.trim()) continue;

            if (role === "system" || sender === "system" || kind.startsWith("override_")) {
              out.push({
                role: "assistant",
                content,
                meta: { sender: "system" },
              } as any);
              continue;
            }

            if (sender === "host") {
              out.push(
                buildAssistantTurnMsg(content, payload, "host") || {
                  role: "assistant",
                  content,
                  meta: { sender: "host" },
                }
              );
              continue;
            }

            // Fallback: still show as a system message.
            out.push({
              role: "assistant",
              content,
              meta: { sender: "system" },
            } as any);
          }
          return out;
        });
      }
    } catch {
      // ignore
    }
  };

  const tick = async () => {
    if (cancelled) return;
    await pollOnce();
    timer = setTimeout(tick, adaptiveRelayPollDelayMs());
  };

  tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [
  API_BASE,
  isHost,
  companyName,
  companionName,
  companionKey,
  rebrandingKey,
  translatorEnabled,
  userLanguageCode,
  userLanguageName,
  userLanguagePreferenceKnown,
  sttLanguageHintCode,
  assistantConversationLanguageCode,
  assistantConversationLanguageName,
  adaptiveRelayPollDelayMs,
]);

  const [loading, setLoading] = useState(false);

  // Used to safely queue STT auto-sends while a response is still being prepared.
  // (Prevents STT transcripts from getting dropped when send() is blocked by loading=true.)
  const loadingRef = useRef<boolean>(false);

  useEffect(() => {
    loadingRef.current = Boolean(loading);
  }, [loading]);


// Host console polling (list + selected transcript)
useEffect(() => {
  if (!hostConsoleOpen) return;
  if (!isHostConsoleUser) return;
  if (!API_BASE) return;

  let cancelled = false;
  let timer: any = null;

  const fetchActive = async () => {
    try {
      const brand = (companyName || "").trim();
      const avatar = (companionName || "").trim();
      const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();

      if (!brand || !avatar || !memberId) return;

      // Keep loading indicator only when opening or when list is empty.
      setHostActiveLoading((prev) => prev || hostActiveChats.length === 0);
      setHostActiveError("");

      const res = await fetch(`${API_BASE}/host/ai-chats/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          avatar,
          memberId,
          limit: 50,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        ok?: boolean;
        sessions?: HostActiveChat[];
      };

      if (cancelled) return;

      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      setHostActiveChats(dedupeHostActiveChats(sessions));
      setHostActiveLoading(false);
    } catch (e: any) {
      if (cancelled) return;
      setHostActiveLoading(false);
      setHostActiveError(String(e?.message || e || "Failed to load active chats"));
    }
  };

  const tick = async () => {
    if (cancelled) return;
    await fetchActive();
    timer = setTimeout(tick, adaptiveHostListPollDelayMs(hostActiveChats.length));
  };

  tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [API_BASE, hostConsoleOpen, isHostConsoleUser, companyName, companionName, hostActiveChats.length, adaptiveHostListPollDelayMs]);

useEffect(() => {
  if (!hostConsoleOpen) return;

  if (hostActiveChats.length === 0) {
    if (hostSelectedSessionId) {
      setHostSelectedSessionId("");
      setHostSelectedEvents([]);
      setHostPendingContent([]);
      setHostPendingModalOpen(false);
      setHostPendingActionErr(null);
      setHostPollSinceSeq(0);
      setHostSendText("");
      setHostNotice("");
    }
    return;
  }

  const currentExists = hostActiveChats.some((c) => String(c?.session_id || "").trim() === String(hostSelectedSessionId || "").trim());
  if (currentExists) return;

  const nextSid = String(hostActiveChats[0]?.session_id || "").trim();
  if (!nextSid) return;

  setHostSelectedSessionId(nextSid);
  setHostSelectedEvents([]);
  setHostPendingContent([]);
  setHostPendingModalOpen(false);
  setHostPendingActionErr(null);
  setHostPollSinceSeq(0);
  setHostSendText("");
  setHostNotice("");
}, [hostConsoleOpen, hostActiveChats, hostSelectedSessionId]);

useEffect(() => {
  if (!hostConsoleOpen) return;
  if (!isHostConsoleUser) return;
  if (!API_BASE) return;
  if (!hostSelectedSessionId) return;

  let cancelled = false;
  let timer: any = null;

  const pollSelected = async () => {
    try {
      const brand = (companyName || "").trim();
      const avatar = (companionName || "").trim();
      const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();

      if (!brand || !avatar || !memberId) return;

      const res = await fetch(`${API_BASE}/host/ai-chats/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          avatar,
          memberId,
          session_id: hostSelectedSessionId,
          since_seq: hostPollSinceSeqRef.current,
          mark_read: true,
        }),
      });

      if (!res.ok) return;

      const data = (await res.json()) as {
        ok?: boolean;
        events?: RelayEvent[];
        next_since_seq?: number;
        override_active?: boolean;
        usage_info?: {
          minutes_remaining?: number;
          minutes_allowed?: number;
          minutes_used?: number;
        };
      };

      if (cancelled) return;

      const evs = Array.isArray(data.events) ? data.events : [];
      if (evs.length) {
        setHostSelectedEvents((prev) => mergeRelayEventsBySeq(prev, evs));

        // Queue pending scheduled content for the host (shown via modal).
        const pendingPayloads = evs
          .map((ev: RelayEvent) => (ev?.kind === "content_pending" ? (ev as any).payload : null))
          .filter(Boolean) as any[];

        if (pendingPayloads.length) {
          setHostPendingContent((prev) => {
            const seen = new Set(prev.map((p) => p.token));
            const additions: PendingContentItem[] = [];

            for (const p of pendingPayloads) {
              const token = String(p?.token || "").trim();
              const content = (p?.content || null) as ContentDelivery | null;

              if (!token || !content) continue;
              if (seen.has(token)) continue;
              seen.add(token);

              const triggerMinute =
                typeof p?.trigger_minute === "number"
                  ? p.trigger_minute
                  : typeof p?.triggerMinute === "number"
                  ? p.triggerMinute
                  : undefined;

              const createdTs =
                typeof p?.created_ts === "number"
                  ? p.created_ts
                  : typeof p?.createdTs === "number"
                  ? p.createdTs
                  : undefined;

              additions.push({ token, triggerMinute, createdTs, content });
            }

            return additions.length ? [...prev, ...additions] : prev;
          });

          setHostPendingModalOpen(true);
        }
      }

      const nextSince =
        typeof data.next_since_seq === "number"
          ? data.next_since_seq
          : hostPollSinceSeqRef.current;

      if (nextSince !== hostPollSinceSeqRef.current) {
        setHostPollSinceSeq(nextSince);
      }

      // If minutes are exhausted, backend will auto-end override and emit a system event.
      if (data.override_active === false) {
        // no-op; UI will reflect from list refresh
      }
    } catch {
      // ignore
    }
  };

  const tick = async () => {
    if (cancelled) return;
    await pollSelected();
    timer = setTimeout(tick, adaptiveHostTranscriptPollDelayMs(Boolean(hostSelectedSessionId)));
  };

  tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [
  API_BASE,
  hostConsoleOpen,
  isHostConsoleUser,
  companyName,
  companionName,
  hostSelectedSessionId,
  adaptiveHostTranscriptPollDelayMs,
]);

const hostSelectSession = (sid: string) => {
  setHostSelectedSessionId(sid);
  setHostSelectedEvents([]);
  setHostPendingContent([]);
  setHostPendingModalOpen(false);
  setHostPendingActionErr(null);
  setHostPollSinceSeq(0);
  setHostSendText("");
  setHostNotice("");
};

const hostSetOverride = async (enabled: boolean) => {
  try {
    const brand = (companyName || "").trim();
    const avatar = (companionName || "").trim();
    const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();
    const session_id = String(hostSelectedSessionId || "").trim();

    if (!brand || !avatar || !memberId || !session_id) return;

    const res = await fetch(`${API_BASE}/host/ai-chats/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, avatar, memberId, session_id, enabled }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }

    setHostNotice(enabled ? "Override enabled." : "Override ended.");
  } catch (e: any) {
    setHostNotice(String(e?.message || e || "Failed to set override"));
  }
};

const hostSendMessage = async () => {
  try {
    const text = String(hostSendText || "").trim();
    if (!text) return;

    const brand = (companyName || "").trim();
    const avatar = (companionName || "").trim();
    const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();
    const session_id = String(hostSelectedSessionId || "").trim();

    if (!brand || !avatar || !memberId || !session_id) return;

    const res = await fetch(`${API_BASE}/host/ai-chats/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, avatar, memberId, session_id, text }),
    });

    const data = await res.json().catch(() => ({} as any));

    if (!res.ok) {
      const txt = (data && (data.detail || data.message)) || `HTTP ${res.status}`;
      throw new Error(String(txt));
    }

    if (data?.minutes_exhausted) {
      setHostNotice("Member is out of minutes — override ended.");
      setHostSendText("");
      return;
    }

    const appendedEvent = (data && typeof data === "object" ? (data as any).event : null) as RelayEvent | null;
    if (appendedEvent && typeof appendedEvent === "object") {
      setHostSelectedEvents((prev) => mergeRelayEventsBySeq(prev, [appendedEvent]));
      const nextSeq = Number((appendedEvent as any)?.seq || 0);
      if (nextSeq > 0) setHostPollSinceSeq((prev) => Math.max(prev, nextSeq));
    }

    setHostSendText("");
    setHostNotice("Host message sent.");
  } catch (e: any) {
    setHostNotice(String(e?.message || e || "Failed to send host message"));
  }
};


// Shared modal STT (speech-to-text) using backend transcription (/stt/transcribe)
// - Used by Host Console and Host Session Insights.
// - Click once to start recording, click again to stop & transcribe.
// - Appends the transcript into the target text box so the host can edit before submitting.
type ModalSttController = {
  setRecording: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  recorderRef: React.MutableRefObject<MediaRecorder | null>;
  streamRef: React.MutableRefObject<MediaStream | null>;
  chunksRef: React.MutableRefObject<BlobPart[]>;
  appendText: (text: string) => void;
};

const stopModalSttCapture = useCallback(async (recorderRef: React.MutableRefObject<MediaRecorder | null>) => {
  try {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {}
    }
  } catch {}
}, []);

const transcribeModalAudioBlob = useCallback(async (blob: Blob): Promise<string> => {
  if (!blob || blob.size < 1) return "";
  const apiBase = String(API_BASE || "").replace(/\/+$/, "");
  if (!apiBase) throw new Error("API base not configured");
  const contentType = String(blob.type || "audio/webm").trim() || "application/octet-stream";

  const res = await fetch(`${apiBase}/stt/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body: blob,
  });

  let data: any = null;
  let rawText = "";
  try {
    rawText = await res.text();
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail = String(data?.detail || data?.error || rawText || `HTTP ${res.status}`);
    throw new Error(detail);
  }

  return String(data?.text || "").trim();
}, [API_BASE]);

const startModalSttCapture = useCallback(async (ctrl: ModalSttController) => {
  try {
    ctrl.setError("");

    if (!API_BASE) throw new Error("API base not configured");
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error("Microphone is not available in this browser");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctrl.streamRef.current = stream;
    ctrl.chunksRef.current = [];

    let preferredMimeType = "";
    try {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/aac",
        "audio/wav",
      ];
      for (const c of candidates) {
        if (typeof MediaRecorder !== "undefined" && (MediaRecorder as any).isTypeSupported?.(c)) {
          preferredMimeType = c;
          break;
        }
      }
    } catch {}

    const mr = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
    const mimeType = String((mr as any)?.mimeType || preferredMimeType || "audio/webm");
    ctrl.recorderRef.current = mr;

    mr.ondataavailable = (e: any) => {
      try {
        if (e?.data && e.data.size > 0) ctrl.chunksRef.current.push(e.data);
      } catch {}
    };

    mr.onstop = async () => {
      try {
        ctrl.setRecording(false);

        const chunks = ctrl.chunksRef.current || [];
        ctrl.chunksRef.current = [];

        try {
          (ctrl.streamRef.current?.getTracks?.() || []).forEach((t) => {
            try {
              t.stop();
            } catch {}
          });
        } catch {}
        ctrl.streamRef.current = null;

        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        const text = await transcribeModalAudioBlob(blob);
        if (!text) return;
        ctrl.appendText(text);
      } catch (e: any) {
        ctrl.setError(String(e?.message || e || "STT failed"));
      }
    };

    mr.start();
    ctrl.setRecording(true);
  } catch (e: any) {
    ctrl.setRecording(false);
    ctrl.setError(String(e?.message || e || "Microphone permission was blocked."));
    try {
      (ctrl.streamRef.current?.getTracks?.() || []).forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    } catch {}
    ctrl.streamRef.current = null;
  }
}, [transcribeModalAudioBlob]);

const hostStopStt = useCallback(async () => {
  await stopModalSttCapture(hostSttRecorderRef);
}, [stopModalSttCapture]);

const hostStartStt = useCallback(async () => {
  if (hostSttRecording) return;
  await startModalSttCapture({
    setRecording: setHostSttRecording,
    setError: setHostSttError,
    recorderRef: hostSttRecorderRef,
    streamRef: hostSttStreamRef,
    chunksRef: hostSttChunksRef,
    appendText: (text: string) => {
      setHostSendText((prev) => {
        const p = String(prev || "").trim();
        return p ? `${p} ${text}` : text;
      });
    },
  });
}, [hostSttRecording, startModalSttCapture]);

const cleanupHostInsightsSttResources = useCallback(() => {
  try {
    if (hostInsightsSttHardStopTimerRef.current) {
      window.clearTimeout(hostInsightsSttHardStopTimerRef.current);
      hostInsightsSttHardStopTimerRef.current = null;
    }
  } catch {}

  try {
    if (hostInsightsSttRafRef.current !== null) {
      cancelAnimationFrame(hostInsightsSttRafRef.current);
      hostInsightsSttRafRef.current = null;
    }
  } catch {}

  try {
    if (hostInsightsSttAudioCtxRef.current) {
      hostInsightsSttAudioCtxRef.current.close().catch?.(() => {});
      hostInsightsSttAudioCtxRef.current = null;
    }
  } catch {}

  try {
    (hostInsightsSttStreamRef.current?.getTracks?.() || []).forEach((t) => {
      try {
        t.stop();
      } catch {}
    });
  } catch {}
  hostInsightsSttStreamRef.current = null;
  hostInsightsSttRecorderRef.current = null;
  hostInsightsSttChunksRef.current = [];
  hostInsightsSttHasSpokenRef.current = false;
  hostInsightsSttLastVoiceAtRef.current = 0;
}, []);

const hostInsightsStopStt = useCallback(async () => {
  hostInsightsSttAbortRequestedRef.current = true;
  setHostInsightsSttEnabled(false);
  hostInsightsSttEnabledRef.current = false;
  try {
    const rec = hostInsightsSttRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {}
    }
  } catch {}
  cleanupHostInsightsSttResources();
  setHostInsightsSttRecording(false);
}, [cleanupHostInsightsSttResources]);

const hostInsightsStartSttOnce = useCallback(async () => {
  if (!hostInsightsSttEnabledRef.current) return;
  if (hostInsightsSttBusyRef.current) return;

  hostInsightsSttBusyRef.current = true;
  hostInsightsSttAbortRequestedRef.current = false;
  hostInsightsSttChunksRef.current = [];
  hostInsightsSttHasSpokenRef.current = false;
  hostInsightsSttLastVoiceAtRef.current = performance.now();
  setHostInsightsSttError("");
  setHostInsightsSttRecording(true);

  try {
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error("Microphone is not available in this browser");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } as any,
    });
    hostInsightsSttStreamRef.current = stream;

    let preferredMimeType = "";
    try {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/aac",
        "audio/wav",
      ];
      for (const c of candidates) {
        if (typeof MediaRecorder !== "undefined" && (MediaRecorder as any).isTypeSupported?.(c)) {
          preferredMimeType = c;
          break;
        }
      }
    } catch {}

    const rec = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
    hostInsightsSttRecorderRef.current = rec;
    const mimeType = String((rec as any)?.mimeType || preferredMimeType || "audio/webm");

    rec.ondataavailable = (e: any) => {
      try {
        if (e?.data && e.data.size > 0) hostInsightsSttChunksRef.current.push(e.data);
      } catch {}
    };

    const blobPromise = new Promise<Blob>((resolve, reject) => {
      rec.onstop = () => {
        resolve(new Blob(hostInsightsSttChunksRef.current || [], { type: mimeType || "audio/webm" }));
      };
      (rec as any).onerror = (ev: any) => reject(ev?.error || new Error("Recorder error"));
    });

    try {
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      hostInsightsSttAudioCtxRef.current = ctx;
      try {
        await ctx.resume();
      } catch {}
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const threshold = 0.02;
      const minRecordMs = 350;
      const maxRecordMs = 15000;
      const silenceMs = 1800;
      const startedAt = performance.now();

      const tick = () => {
        const recorder = hostInsightsSttRecorderRef.current;
        if (!recorder) return;
        if (!hostInsightsSttEnabledRef.current || hostInsightsSttAbortRequestedRef.current) {
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch {}
          return;
        }

        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();

        if (rms > threshold) {
          hostInsightsSttLastVoiceAtRef.current = now;
          hostInsightsSttHasSpokenRef.current = true;
        }

        const elapsed = now - startedAt;
        const silentFor = now - hostInsightsSttLastVoiceAtRef.current;

        if (elapsed >= maxRecordMs || (hostInsightsSttHasSpokenRef.current && elapsed > minRecordMs && silentFor >= silenceMs)) {
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch {}
          return;
        }

        hostInsightsSttRafRef.current = requestAnimationFrame(tick);
      };

      hostInsightsSttRafRef.current = requestAnimationFrame(tick);
    } catch {}

    hostInsightsSttHardStopTimerRef.current = window.setTimeout(() => {
      try {
        const recorder = hostInsightsSttRecorderRef.current;
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {}
    }, 16000);

    rec.start(250);
    const blob = await blobPromise;
    const hadSpeech = hostInsightsSttHasSpokenRef.current;

    cleanupHostInsightsSttResources();
    setHostInsightsSttRecording(false);

    if (hostInsightsSttAbortRequestedRef.current || !hostInsightsSttEnabledRef.current) return;
    if (!hadSpeech || !blob || blob.size < 2048) return;

    const text = await transcribeModalAudioBlob(blob);
    if (!text) return;

    setHostInsightsQuestion(text);
    await submitHostInsightsQuestion(text);
  } catch (e: any) {
    setHostInsightsSttError(String(e?.message || e || "STT failed"));
  } finally {
    cleanupHostInsightsSttResources();
    setHostInsightsSttRecording(false);
    hostInsightsSttBusyRef.current = false;
    if (hostInsightsSttEnabledRef.current && !hostInsightsSttAbortRequestedRef.current) {
      window.setTimeout(() => {
        void hostInsightsStartSttOnce();
      }, 250);
    }
  }
}, [cleanupHostInsightsSttResources, submitHostInsightsQuestion, transcribeModalAudioBlob]);

const hostInsightsStartStt = useCallback(async () => {
  if (hostInsightsSttEnabledRef.current) return;
  setHostInsightsSttError("");
  setHostInsightsSttEnabled(true);
  hostInsightsSttEnabledRef.current = true;
  hostInsightsSttAbortRequestedRef.current = false;
  void hostInsightsStartSttOnce();
}, [hostInsightsStartSttOnce]);

// Safety: stop host recorder if host console closes or session changes.
useEffect(() => {
  if (!hostConsoleOpen || !hostSelectedSessionId) {
    if (hostSttRecording) hostStopStt();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [hostConsoleOpen, hostSelectedSessionId]);

// Safety: stop Session Insights recorder when the modal closes.
useEffect(() => {
  if (!hostInsightsOpen && (hostInsightsSttRecording || hostInsightsSttEnabled)) {
    hostInsightsStopStt();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [hostInsightsOpen, hostInsightsSttRecording, hostInsightsSttEnabled]);

  const hostPushPendingContent = async (token: string) => {
    if (!hostSelectedSessionId) return;

    setHostPendingActionErr(null);

    try {
      const brand = (companyName || "").trim();
      const avatar = (companionName || "").trim();
      const memberId = String(hostMemberIdRef.current || memberIdRef.current || "").trim();
      const session_id = String(hostSelectedSessionId || "").trim();

      if (!brand || !avatar || !memberId || !session_id) return;

      const res = await fetch(`${API_BASE}/host/ai-chats/push-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          avatar,
          memberId,
          session_id,
          token,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const detail = data?.detail || data?.error || `HTTP ${res.status}`;
        throw new Error(String(detail));
      }

      setHostPendingContent((prev) => {
        const next = prev.filter((p) => p.token !== token);
        if (!next.length) setHostPendingModalOpen(false);
        return next;
      });
    } catch (e: any) {
      setHostPendingActionErr(e?.message || "Failed to push content");
    }
  };


  const [showClearMessagesConfirm, setShowClearMessagesConfirm] = useState(false);
  const clearEpochRef = useRef(0);

  const [chatStatus, setChatStatus] = useState<ChatStatus>("safe");

  const [sessionState, setSessionState] = useState<SessionState>({
    mode: "friend",
    model: "gpt-4o",
    adult_verified: false,
    romance_consented: false,
    explicit_consented: false,
    pending_consent: null,
  });


  const syncLanguagePreferenceFromBackend = useCallback((rawState: any) => {
    const state = rawState && typeof rawState === "object" ? rawState : {};
    const known = coerceBooleanLike(
      state?.user_language_preference_known ??
      state?.userLanguagePreferenceKnown ??
      state?.language_preference_known ??
      state?.languagePreferenceKnown
    );
    const code = normalizeLanguageTag(
      state?.user_language_code ??
      state?.userLanguageCode ??
      state?.display_language_code ??
      state?.displayLanguageCode ??
      ""
    );
    if (!code || known !== true) return;
    setUserLanguageCode(code);
    setUserLanguagePreferenceKnown(true);
  }, []);

  // Product rule: no paid plan is Trial for visitors and members alike.
  const [planName, setPlanName] = useState<PlanName>("Trial");
  const latestPlanNameRef = useRef<PlanName>(planName);
  useEffect(() => {
    latestPlanNameRef.current = planName;
  }, [planName]);

  // loggedIn must come from Wix; do NOT infer from memberId.
  // Used for upgrade polling and entitlement refresh without a full page reload.
  const [loggedIn, setLoggedIn] = useState<boolean>(false);

  const applyIntimateConsentForMember = useCallback(
    (source: string = "") => {
      const mid = String(memberIdRef.current || memberId || "").trim();
      if (!mid || isAnonMemberId(mid)) return false;
      writeStoredIntimateConsent(mid, {
        source: source || "connect",
        brand: String(companyName || "").trim(),
        avatar: String(companionName || "").trim(),
      });
      setSessionState((prev) => ({
        ...prev,
        adult_verified: true,
        explicit_consented: true,
        pending_consent: null,
      }));
      return true;
    },
    [memberId, companyName, companionName],
  );

  useEffect(() => {
    const mid = String(memberIdRef.current || memberId || "").trim();
    if (!mid || isAnonMemberId(mid)) return;

    if (readStoredIntimateConsent(mid)) {
      setSessionState((prev) =>
        prev.explicit_consented && prev.adult_verified
          ? prev
          : { ...prev, adult_verified: true, explicit_consented: true, pending_consent: null },
      );
      return;
    }

    if (!API_BASE) return;
    let cancelled = false;

    const run = async () => {
      try {
        const url = new URL(`${API_BASE}/mode-consent/intimate/status`);
        url.searchParams.set("memberId", mid);
        url.searchParams.set("brand", String(companyName || ""));
        const res = await fetch(url.toString(), { cache: "no-store" });
        const data: any = await res.json().catch(() => null);
        const granted = Boolean(data?.granted === true || data?.consented === true);
        if (cancelled || !res.ok || !granted) return;
        writeStoredIntimateConsent(mid, {
          source: "server",
          brand: String(data?.brand || companyName || "").trim(),
          avatar: String(data?.avatar || companionName || "").trim(),
          grantedEpoch: Number(data?.granted_epoch || 0) || undefined,
        });
        setSessionState((prev) => ({
          ...prev,
          adult_verified: true,
          explicit_consented: true,
          pending_consent: null,
        }));
      } catch {
        // Fail closed: if we cannot verify prior consent, the normal consent prompt remains.
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [API_BASE, memberId, companyName, companionName]);

  // ---------------------------------------------------------------------
  // PayGo Top-up (existing Pay Link) - Visitor email capture + pending intent
  //
  // Non-members: we must correlate the Wix Pay Link payment back to the visitor.
  // We do that by:
  //   1) collecting an email BEFORE opening the PayGo checkout link
  //   2) creating a pending record on the backend keyed by that email
  //   3) matching the payer email from Wix payment webhooks to this pending record
  //
  // IMPORTANT UX NOTE:
  //   The email entered here MUST match the email the user uses during the payment process,
  //   otherwise the credit will not occur.
  //
  // The backend blocks concurrent pending top-ups by email (409).
  // ---------------------------------------------------------------------
  const [topupStage, setTopupStage] = useState<TopupStage>("idle");
  const [topupModalOpen, setTopupModalOpen] = useState<boolean>(false);
  const [topupPayUrl, setTopupPayUrl] = useState<string>("");
  const [topupEmail, setTopupEmail] = useState<string>("");
  const [topupPendingId, setTopupPendingId] = useState<string>("");
  const [topupExpiresAt, setTopupExpiresAt] = useState<number | null>(null);
  const [topupError, setTopupError] = useState<string>("");
  const [topupLastCreditedMinutes, setTopupLastCreditedMinutes] = useState<number | null>(null);
  const [topupUnits, setTopupUnits] = useState<number>(1);
  const [topupMinutesPerUnit, setTopupMinutesPerUnit] = useState<number>(30);
  const [topupUnitAmountCents, setTopupUnitAmountCents] = useState<number>(0);
  const [topupAmountTotalCents, setTopupAmountTotalCents] = useState<number>(0);
  const [topupCurrency, setTopupCurrency] = useState<string>("usd");
  const [topupCheckoutClientSecret, setTopupCheckoutClientSecret] = useState<string>("");
  const [topupCheckoutSessionId, setTopupCheckoutSessionId] = useState<string>("");
  const [topupHostedUrl, setTopupHostedUrl] = useState<string>("");
  const [topupPublishableKey, setTopupPublishableKey] = useState<string>("");
  const topupCheckoutContainerRef = useRef<HTMLDivElement | null>(null);
  const embeddedCheckoutRef = useRef<any>(null);
  const topupPollTimerRef = useRef<number | null>(null);

  // Members: auto-unlock PayGo without requiring a page refresh.
  // We start watching when a member clicks the PayGo link, and poll the backend
  // (read-only) until minutes are credited.
  const [memberTopupWatching, setMemberTopupWatching] = useState<boolean>(false);
  const [memberTopupStartedAt, setMemberTopupStartedAt] = useState<number | null>(null);
  const [memberTopupError, setMemberTopupError] = useState<string>("");
  const memberTopupPollTimerRef = useRef<number | null>(null);

  // Upgrade polling (no refresh required)
  // - When the user clicks Upgrade, checkout/sign-up happens in another tab.
  // - When they return, the iframe must request the latest MEMBER_PLAN payload from the Wix parent.
  // - The Wix parent (Velo) responds by re-sending MEMBER_PLAN (planName/loggedIn/memberId/rebrandingKey).
  const [upgradeWatching, setUpgradeWatching] = useState<boolean>(false);
  const upgradeWatchStartedAtRef = useRef<number>(0);
  const upgradeWatchInitialPlanRef = useRef<string>("");
  const upgradeWatchInitialLoggedInRef = useRef<boolean>(false);
  const upgradeWatchTimerRef = useRef<number | null>(null);
  const upgradeWatchLastRequestAtRef = useRef<number>(0);


  // Sync memberId into a ref so callbacks defined above can always access the latest value.
  useEffect(() => {
    memberIdRef.current = String(memberId || "").trim();
  }, [memberId]);

  // Stable member id used for live chat (Wix memberId when available, otherwise anon:...)
  const brandKeyForAnon = useMemo(() => {
    // `rebranding` is derived from RebrandingKey and is safe to use here.
    const rawBrand = String(rebranding || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME;
    return safeBrandKey(rawBrand);
  }, [rebranding]);

  const memberIdForLiveChat = useMemo(() => {
    const mid = String(memberId || "").trim();
    if (mid) return mid;
    return getOrCreateAnonMemberId(brandKeyForAnon);
  }, [memberId, brandKeyForAnon]);

  const topupRequiresEmail = useMemo(() => {
    const mid = String(memberIdForLiveChat || "").trim();
    return !mid || isAnonMemberId(mid);
  }, [memberIdForLiveChat]);


  // ---------------------------------------------------------------------------
  // LLM priming (warm-up) to reduce latency on provider switches (OpenAI <-> xAI)
  // ---------------------------------------------------------------------------
  const warmProvider = useMemo(() => {
    return sessionState.mode === "intimate" && !!sessionState.explicit_consented ? "xai" : "openai";
  }, [sessionState.mode, sessionState.explicit_consented]);

  const warmKey = useMemo(() => {
    const rawBrand = String(companyName || rebranding || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME;
    const brandKey = safeBrandKey(rawBrand) || "core";
    const avatarKey = String(companionName || DEFAULT_COMPANION_NAME).trim().toLowerCase();
    const languageKey = normalizeLanguageTag(userLanguageCode) || "en";
    return `${warmProvider}|${sessionState.mode}|${sessionState.explicit_consented ? "1" : "0"}|${brandKey}|${avatarKey}|tr:${translatorEnabled ? "1" : "0"}|u:${languageKey}|a:${assistantConversationLanguageCode}`;
  }, [warmProvider, sessionState.mode, sessionState.explicit_consented, companyName, rebranding, companionName, translatorEnabled, userLanguageCode, assistantConversationLanguageCode]);

  const warmLastRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const buildWarmSessionStateForBackend = useCallback((): SessionState => {
    const rawBrand = String(companyName || rebranding || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME;
    const brandKey = safeBrandKey(rawBrand);
    const mid = String(memberId || "").trim() || getOrCreateAnonMemberId(brandKey);
    const companionForBackend =
      String(companionKey || "").trim() || String(companionName || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
    const rebrandingKeyForBackend = normalizeRebrandingKeyValue(rebrandingKey);
    const planNameForBackend = planName;
    const userDisplayNameForBackend = buildHostReadableViewerName(mid);
    const hostMemberIdForBackend = String(mappedHostMemberId || "").trim();

    return {
      ...sessionState,
      memberId: mid,
      member_id: mid,
      brand: rawBrand,
      avatar: String(selectedMappingAvatar || companionName || companionForBackend).trim(),
      mappingAvatar: String(selectedMappingAvatar || companionName || companionForBackend).trim(),
      mapping_avatar: String(selectedMappingAvatar || companionName || companionForBackend).trim(),
      companionType: selectedCompanionType,
      companion_type: selectedCompanionType,
      companion: companionForBackend,
      companionName: companionForBackend,
      companion_name: companionForBackend,
      planName: planNameForBackend,
      plan_name: planNameForBackend,
      rebrandingKey: rebrandingKeyForBackend,
      rebranding_key: rebrandingKeyForBackend,
      rebranding: String(rebranding || "").trim(),
      user_name: userDisplayNameForBackend,
      username: userDisplayNameForBackend,
      display_name: userDisplayNameForBackend,
      hostMemberId: hostMemberIdForBackend,
      host_member_id: hostMemberIdForBackend,
      isHostUser: isHost,
      is_host_user: isHost,
      loggedIn,
      logged_in: loggedIn,
      translator_enabled: translatorEnabled,
      translation_enabled: translatorEnabled,
      translationEnabled: translatorEnabled,
      user_language_code: normalizeLanguageTag(userLanguageCode) || "en",
      userLanguageCode: normalizeLanguageTag(userLanguageCode) || "en",
      user_language_name: userLanguageName,
      userLanguageName: userLanguageName,
      user_language_preference_known: userLanguagePreferenceKnown,
      userLanguagePreferenceKnown: userLanguagePreferenceKnown,
      language_preference_known: userLanguagePreferenceKnown,
      languagePreferenceKnown: userLanguagePreferenceKnown,
      user_language_hint_code: normalizeLanguageTag(sttLanguageHintCode) || "en",
      userLanguageHintCode: normalizeLanguageTag(sttLanguageHintCode) || "en",
      display_language_code: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
      displayLanguageCode: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
      assistant_language_code: assistantConversationLanguageCode,
      assistantLanguageCode: assistantConversationLanguageCode,
      assistant_language_name: assistantConversationLanguageName,
      assistantLanguageName: assistantConversationLanguageName,
      assistant_speech_language_code: assistantSpeechLanguageCode,
      assistantSpeechLanguageCode: assistantSpeechLanguageCode,
      assistant_speech_language_name: assistantSpeechLanguageName,
      assistantSpeechLanguageName: assistantSpeechLanguageName,
      assistant_source_language_code: assistantSpeechLanguageCode,
      assistantSourceLanguageCode: assistantSpeechLanguageCode,
      assistant_source_language_name: assistantSpeechLanguageName,
      assistantSourceLanguageName: assistantSpeechLanguageName,
    };
  }, [sessionState, companyName, rebranding, memberId, companionKey, companionName, selectedMappingAvatar, selectedCompanionType, companionPhonetic, rebrandingKey, planName, buildHostReadableViewerName, mappedHostMemberId, isHost, loggedIn, translatorEnabled, userLanguageCode, userLanguageName, userLanguagePreferenceKnown, sttLanguageHintCode, assistantConversationLanguageCode, assistantConversationLanguageName]);

  useEffect(() => {
    if (!API_BASE) return;

    // Throttle: only warm once per key per ~45s.
    const now = Date.now();
    const prev = warmLastRef.current;
    if (prev.key === warmKey && now - prev.at < 45_000) return;
    warmLastRef.current = { key: warmKey, at: now };

    const payload = {
      provider: warmProvider,
      mode: sessionState.mode,
      session_state: buildWarmSessionStateForBackend(),
    };

    try {
      fetch(`${API_BASE}/llm/warm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (e) {}
  }, [warmKey, warmProvider, sessionState.mode, buildWarmSessionStateForBackend]);


  // PayGo top-up email (stored per brand so the user doesn't have to retype it)
  const topupEmailStorageKey = useMemo(() => {
    const b = safeBrandKey(String(rebranding || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME) || "core";
    return `paygo_topup_email:${b}`;
  }, [rebranding]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((topupEmail || "").trim()) return;
    try {
      const v1 = String(window.localStorage.getItem(topupEmailStorageKey) || "").trim();
      const v2 = String(window.sessionStorage.getItem(topupEmailStorageKey) || "").trim();
      const v = v1 || v2;
      if (v) setTopupEmail(v);
    } catch (e) {}
  }, [topupEmailStorageKey, topupEmail]);

  const persistTopupEmail = useCallback(
    (email: string) => {
      if (typeof window === "undefined") return;
      const v = String(email || "").trim();
      if (!v) return;
      try {
        window.localStorage.setItem(topupEmailStorageKey, v);
        return;
      } catch (e) {}
      try {
        window.sessionStorage.setItem(topupEmailStorageKey, v);
      } catch (e) {}
    },
    [topupEmailStorageKey]
  );

  const openPaygoUrl = useCallback((url: string) => {
    const u = String(url || "").trim();
    if (!u) return;
    try {
      window.open(u, "_blank", "noopener,noreferrer");
    } catch (e) {
      try {
        window.open(u, "_blank");
      } catch (e2) {}
    }
  }, []);

  const beginPaygoTopupForVisitor = useCallback((payUrl: string) => {
    setTopupPayUrl(String(payUrl || "").trim());
    setTopupError("");
    setTopupLastCreditedMinutes(null);
    setTopupStage("collect_email");
    setTopupModalOpen(true);
  }, []);

  // Start an in-app Stripe PayGo flow. Members skip email capture; visitors must provide email.
  const beginPaygoTopupForMember = useCallback(() => {
    setTopupPayUrl("");
    setTopupError("");
    setTopupLastCreditedMinutes(null);
    setTopupCheckoutClientSecret("");
    setTopupCheckoutSessionId("");
    setTopupHostedUrl("");
    setTopupPublishableKey("");
    setTopupStage("collect_email");
    setTopupModalOpen(true);
  }, []);

  const closeTopupModal = useCallback(() => {
    setTopupModalOpen(false);
  }, []);

  // ---------------------------------------------------------------------
  // Upgrade polling (plan refresh) via postMessage
  // - Iframe requests latest plan from Wix parent by sending { type: "REQUEST_MEMBER_PLAN" }
  // - Companion page responds by re-sending MEMBER_PLAN payload to this iframe (#html1)
  // ---------------------------------------------------------------------
  const requestLatestMemberPlanFromParent = useCallback((reason: string, opts?: { force?: boolean }) => {
    try {
      if (typeof window === "undefined") return;

      const now = Date.now();
      // Throttle so we don't spam Velo / backend plan lookup.
      if (!opts?.force && now - (upgradeWatchLastRequestAtRef.current || 0) < 900) return;
      upgradeWatchLastRequestAtRef.current = now;

      const msg = {
        type: "REQUEST_MEMBER_PLAN",
        source: "elaralo-connect",
        reason: String(reason || "").slice(0, 64),
        ts: now,
        href: (() => {
          try {
            return String(window.location.href || "");
          } catch (e) {
            return "";
          }
        })(),
        referrer: (() => {
          try {
            return String(document.referrer || "");
          } catch (e) {
            return "";
          }
        })(),
      };

      const targets: Window[] = [];
      try {
        if (window.parent && window.parent !== window) targets.push(window.parent);
      } catch (e) {}
      try {
        if (window.top && window.top !== window && !targets.includes(window.top as Window)) {
          targets.push(window.top as Window);
        }
      } catch (e) {}

      for (const target of targets) {
        try { target.postMessage(msg, "*"); } catch (e) {}
        try { target.postMessage(JSON.stringify(msg), "*"); } catch (e) {}
      }
    } catch (e) {
      // ignore
    }
  }, []);

  const startUpgradeWatch = useCallback(
    (reason: string) => {
      // Capture baseline so we can stop polling once the plan/loggedIn changes.
      upgradeWatchInitialPlanRef.current = String(planName || "").trim();
      upgradeWatchInitialLoggedInRef.current = Boolean(loggedIn);
      upgradeWatchStartedAtRef.current = Date.now();

      setUpgradeWatching(true);
      requestLatestMemberPlanFromParent(reason || "upgrade");
    },
    [planName, loggedIn, requestLatestMemberPlanFromParent]
  );

  const stopUpgradeWatch = useCallback(() => {
    setUpgradeWatching(false);
  }, []);

  const applyUsageStatusSnapshot = useCallback((raw: any) => {
    if (!raw || typeof raw !== "object") return false;

    const hasSnapshot = [
      "minutes_remaining",
      "minutesRemaining",
      "minutes_allowed",
      "minutesAllowed",
      "minutes_used",
      "minutesUsed",
      "minutes_total",
      "minutesTotal",
      "minutes_exhausted",
      "minutesExhausted",
      "remaining_seconds",
      "remainingSeconds",
      "used_seconds",
      "usedSeconds",
      "total_seconds",
      "totalSeconds",
    ].some((k) => Object.prototype.hasOwnProperty.call(raw, k));

    if (!hasSnapshot) return false;

    const remainingSecondsRaw = Number(raw?.remaining_seconds ?? raw?.remainingSeconds ?? NaN);
    const hasRemainingSeconds = Number.isFinite(remainingSecondsRaw);
    const remainingFromSeconds = hasRemainingSeconds
      ? Math.max(0, Math.ceil(Math.max(0, remainingSecondsRaw) / 60))
      : 0;
    const remainingExplicit = Number(raw?.minutes_remaining ?? raw?.minutesRemaining ?? NaN);
    const remaining = Number.isFinite(remainingExplicit)
      ? Math.max(0, remainingExplicit)
      : remainingFromSeconds;
    const allowed = Number(raw?.minutes_allowed ?? raw?.minutesAllowed ?? 0) || 0;
    const total = Number(raw?.minutes_total ?? raw?.minutesTotal ?? allowed ?? 0) || 0;
    const usedFallback = total > 0 ? Math.max(0, total - remaining) : 0;
    const used = Number(raw?.minutes_used ?? raw?.minutesUsed ?? usedFallback) || 0;
    const usedSeconds = Number(raw?.used_seconds ?? raw?.usedSeconds ?? NaN);
    const totalSeconds = Number(raw?.total_seconds ?? raw?.totalSeconds ?? NaN);
    const exhausted =
      typeof raw?.minutes_exhausted === "boolean"
        ? raw.minutes_exhausted
        : typeof raw?.minutesExhausted === "boolean"
          ? raw.minutesExhausted
          : hasRemainingSeconds
            ? remainingSecondsRaw <= 0
            : remaining <= 0;

    setSessionState((prev) => ({
      ...(prev as any),
      minutes_exhausted: exhausted,
      minutes_remaining: exhausted ? 0 : remaining,
      minutes_allowed:
        allowed > 0
          ? allowed
          : Number((prev as any)?.minutes_allowed ?? (prev as any)?.minutesAllowed ?? 0) || 0,
      minutes_total:
        total > 0
          ? total
          : Number((prev as any)?.minutes_total ?? (prev as any)?.minutesTotal ?? allowed ?? 0) || 0,
      minutes_used: used,
      remaining_seconds: Number.isFinite(remainingSecondsRaw) ? remainingSecondsRaw : (prev as any)?.remaining_seconds,
      used_seconds: Number.isFinite(usedSeconds) ? usedSeconds : (prev as any)?.used_seconds,
      total_seconds: Number.isFinite(totalSeconds) ? totalSeconds : (prev as any)?.total_seconds,
    }));

    return true;
  }, []);

  // After an upgrade (plan change), refresh the usage balance once so minutes/metering gates
  // update immediately without requiring a page refresh.
  const refreshUsageStatusOnce = useCallback(async () => {
    try {
      if (typeof window === "undefined") return;
      if (!API_BASE) return;

      const companionForBackend =
        (companionKey || "").trim() ||
        (companionName || DEFAULT_COMPANION_NAME).trim() ||
        DEFAULT_COMPANION_NAME;

      const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || DEFAULT_COMPANY_NAME).trim();
      const brandKey = safeBrandKey(rawBrand);
      const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

      const session_state: any = {
        ...(sessionStateRef.current as any),
        companion: companionForBackend,
        companionName: companionForBackend,
        companion_name: companionForBackend,
  // Brand/avatar are used by the backend for host override scoping and (optionally) TTS.
  brand: (companyName || "").trim(),
  avatar: (selectedMappingAvatar || companionName || "").trim(),
        mappingAvatar: (selectedMappingAvatar || companionName || "").trim(),
        mapping_avatar: (selectedMappingAvatar || companionName || "").trim(),
        companionType: selectedCompanionType,
        companion_type: selectedCompanionType,
        phonetic: companionPhonetic,
        mapping_phonetic: companionPhonetic,
        mappingPhonetic: companionPhonetic,
        companion_phonetic: companionPhonetic,
        companionPhonetic: companionPhonetic,

        memberId: (memberIdForBackend || "").trim(),
        member_id: (memberIdForBackend || "").trim(),

        planName: String(planName || "").trim(),
        plan_name: String(planName || "").trim(),

        planLabelOverride: String(planLabelOverride || "").trim(),
        plan_label_override: String(planLabelOverride || "").trim(),

        rebrandingKey: normalizeRebrandingKeyValue(rebrandingKey),
        rebranding_key: normalizeRebrandingKeyValue(rebrandingKey),
        RebrandingKey: normalizeRebrandingKeyValue(rebrandingKey),
        rebranding: String(rebranding || "").trim(),
      };

      const res = await fetch(`${API_BASE}/usage/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current || "",
          session_state,
        }),
        cache: "no-store" as any,
      } as any);

      if (!res.ok) return;

      const data: any = await res.json().catch(() => ({}));
      applyUsageStatusSnapshot(data);
    } catch (e) {
      // ignore
    }
  }, [API_BASE, companionKey, companionName, selectedMappingAvatar, selectedCompanionType, companionPhonetic, companyName, memberId, planName, planLabelOverride, rebrandingKey, rebranding, applyUsageStatusSnapshot]);

  // Keep the on-screen usage meter in sync even when there are no new turns.
  // This endpoint is non-charging (status only), so it is safe to poll.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!API_BASE) return;

    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      // Avoid background polling when the tab is hidden to reduce load on mobile.
      try {
        if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") {
          return;
        }
      } catch {}

      void refreshUsageStatusOnce();
    };

    tick();
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [API_BASE, refreshUsageStatusOnce]);


  // CTA: Encourage visitors to become members for a smoother top-up experience (no email entry).
  // We intentionally keep the non-member flow more tedious (email required), but provide a clear upgrade path.
  const handleBecomeMemberCta = useCallback(() => {
    // Close the modal so the visitor can use the site's header "Log In" control immediately.
    setTopupModalOpen(false);
    setTopupStage("idle");
    setTopupError("");

    // Open the Upgrade URL (white-label override via rebrandingKey, else Elaralo default).
    // This matches the same URL logic used by the persistent Upgrade button.
    try {
      openUpgradeUrl();
    } catch (e) {}

    // Start upgrade polling so when the user returns (after signing up / upgrading)
    // we can request the updated MEMBER_PLAN payload and unlock immediately.
    try {
      startUpgradeWatch("nonmember_cta");
    } catch (e) {}

    // If the Wix parent/companion implements a login prompt, this message can trigger it.
    // Safe no-op if not handled.
    try {
      window.parent?.postMessage({ type: "PROMPT_LOGIN" }, "*");
    } catch (e) {}

    // Add an in-chat reminder so the user knows what to do next.
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content:
          "🔐 Want 1‑click top‑ups? Log in or sign up as a site member, then click “Add minutes” again. Members don’t need to enter an email and minutes credit instantly after payment.",
      },
    ]);
  }, [openUpgradeUrl, startUpgradeWatch]);


  const startPaygoTopupForVisitor = useCallback(async () => {
    if (!API_BASE) {
      setTopupError("API_BASE is not configured; cannot start top-up.");
      setTopupStage("error");
      setTopupModalOpen(true);
      return;
    }

    const brandNow = String(companyName || rebranding || DEFAULT_COMPANY_NAME || "Elaralo").trim() || "Elaralo";
    const memberIdNow = String(memberIdRef.current || memberIdForLiveChat || memberId || "").trim();
    const isRealMemberNow = Boolean(memberIdNow) && !isAnonMemberId(memberIdNow);
    const email = String(topupEmail || "").trim();

    if (!isRealMemberNow && (!email || !email.includes("@"))) {
      setTopupError("Please enter a valid email address before checkout.");
      setTopupStage("collect_email");
      setTopupModalOpen(true);
      return;
    }

    const units = Math.max(1, Math.min(12, Number(topupUnits || 1) || 1));
    setTopupUnits(units);
    setTopupStage("creating");
    setTopupError("");
    setTopupLastCreditedMinutes(null);
    setTopupCheckoutClientSecret("");
    setTopupCheckoutSessionId("");
    setTopupHostedUrl("");

    if (!isRealMemberNow) persistTopupEmail(email);

    const payload = {
      brand: brandNow,
      memberId: memberIdNow,
      member_id: memberIdNow,
      email: isRealMemberNow ? "" : email,
      session_id: sessionIdRef.current || "",
      sessionId: sessionIdRef.current || "",
      avatar: String(selectedMappingAvatar || companionName || "").trim(),
      mappingAvatar: String(selectedMappingAvatar || companionName || "").trim(),
      companionName: String(companionName || "").trim(),
      companion_key: String(companionKey || companionName || "").trim(),
      companionKey: String(companionKey || companionName || "").trim(),
      companion_type: String(selectedCompanionType || "").trim(),
      companionType: String(selectedCompanionType || "").trim(),
      units,
      quantity: units,
      // Keep Checkout return/navigation brand-scoped. For DulceMoon this is
      // usually https://www.dulcemoon.net/dulce-connect from document.referrer;
      // otherwise it falls back to the current Connect URL.
      return_url: paygoSafeReturnUrl(brandNow),
      returnUrl: paygoSafeReturnUrl(brandNow),
      parent_url: (() => { try { return String(document.referrer || "").trim(); } catch { return ""; } })(),
      parentUrl: (() => { try { return String(document.referrer || "").trim(); } catch { return ""; } })(),
      return_origin: (() => {
        try { return window.location.origin; } catch { return ""; }
      })(),
      // Do not auto-create/auto-open hosted Checkout. The primary PayGo
      // experience must remain inside the Connect iframe.
      allow_hosted_fallback: false,
      allowHostedFallback: false,
    };

    try {
      const res = await fetch(`${API_BASE}/stripe/paygo/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await res.text().catch(() => "");
      let json: any = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      if (!res.ok) {
        const err = typeof json?.detail === "string" ? json.detail : raw;
        throw new Error(err || `Stripe checkout setup failed (${res.status})`);
      }

      const clientSecret = String(json?.client_secret || json?.clientSecret || "").trim();
      const hostedUrl = String(json?.hosted_url || json?.hostedUrl || "").trim();
      const checkoutSessionId = String(json?.checkout_session_id || json?.checkoutSessionId || "").trim();
      const responsePublishableKey = String(json?.publishable_key || json?.publishableKey || json?.stripe_publishable_key || "").trim();
      let configPublishableKey = "";
      if (!(readRuntimeStripePublishableKey() || STRIPE_PUBLISHABLE_KEY || responsePublishableKey)) {
        const cfg = await fetchStripePaygoRuntimeConfig(String(API_BASE || ""), brandNow);
        configPublishableKey = String(cfg?.publishable_key || cfg?.publishableKey || cfg?.stripe_publishable_key || "").trim();
      }
      const minutesPerUnit = Number(json?.minutes_per_unit ?? json?.minutesPerUnit ?? 30) || 30;
      const minutesTotal = Number(json?.minutes_total ?? json?.minutesTotal ?? minutesPerUnit * units) || minutesPerUnit * units;
      const unitAmountCents = Number(json?.unit_amount_cents ?? json?.unitAmountCents ?? 0) || 0;
      const amountTotalCents = Number(json?.amount_total_cents ?? json?.amountTotalCents ?? unitAmountCents * units) || unitAmountCents * units;
      const currency = String(json?.currency || "usd").trim() || "usd";

      setTopupMinutesPerUnit(minutesPerUnit);
      setTopupLastCreditedMinutes(minutesTotal);
      setTopupUnitAmountCents(unitAmountCents);
      setTopupAmountTotalCents(amountTotalCents);
      setTopupCurrency(currency);
      setTopupCheckoutClientSecret(clientSecret);
      setTopupCheckoutSessionId(checkoutSessionId);
      setTopupHostedUrl(hostedUrl);
      const effectivePublishableKey = readRuntimeStripePublishableKey() || STRIPE_PUBLISHABLE_KEY || responsePublishableKey || configPublishableKey;
      setTopupPublishableKey(effectivePublishableKey);
      setTopupModalOpen(true);

      if (clientSecret && effectivePublishableKey) {
        setTopupStage("checkout");
      } else if (clientSecret && !effectivePublishableKey) {
        throw new Error("Stripe publishable key is not available to Connect. Add STRIPE_PUBLISHABLE_KEY to the API App Service or redeploy the Static Web App with NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.");
      } else {
        throw new Error("Stripe Embedded Checkout was not created. Payment was not opened so the user stays inside Connect.");
      }
    } catch (e: any) {
      setTopupError(String(e?.message || e || "Stripe checkout setup failed"));
      setTopupStage("error");
      setTopupModalOpen(true);
    }
  }, [
    API_BASE,
    companyName,
    rebranding,
    memberIdForLiveChat,
    memberId,
    topupEmail,
    topupUnits,
    persistTopupEmail,
    selectedMappingAvatar,
    companionName,
    companionKey,
    selectedCompanionType,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!topupModalOpen) return;
    if (topupStage !== "checkout") return;
    if (!topupCheckoutClientSecret) return;
    const container = topupCheckoutContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let checkoutInstance: any = null;
    try { container.innerHTML = ""; } catch {}

    const startEmbedded = async () => {
      try {
        const effectivePublishableKey = readRuntimeStripePublishableKey() || STRIPE_PUBLISHABLE_KEY || topupPublishableKey;
        const stripe = await loadStripeJs(effectivePublishableKey);
        if (cancelled) return;
        if (!stripe || typeof stripe.initEmbeddedCheckout !== "function") {
          throw new Error("Stripe Embedded Checkout is not available in this browser.");
        }
        checkoutInstance = await stripe.initEmbeddedCheckout({
          clientSecret: topupCheckoutClientSecret,
          onComplete: () => {
            setTopupStage("waiting");
            setMemberTopupStartedAt(Date.now());
            setMemberTopupWatching(true);
            void refreshUsageStatusOnce();
          },
        });
        if (cancelled) {
          try { checkoutInstance?.destroy?.(); } catch {}
          return;
        }
        embeddedCheckoutRef.current = checkoutInstance;
        checkoutInstance.mount(container);
      } catch (e: any) {
        if (cancelled) return;
        // Keep the PayGo process inside the Connect iframe. Do not
        // automatically open hosted Checkout in a new window/tab; that path can
        // return to the bare Static App and show the default Elaralo screen.
        setTopupError(String(e?.message || e || "Embedded Checkout failed"));
        setTopupStage("error");
      }
    };

    void startEmbedded();

    return () => {
      cancelled = true;
      try { checkoutInstance?.destroy?.(); } catch {}
      try { if (embeddedCheckoutRef.current === checkoutInstance) embeddedCheckoutRef.current = null; } catch {}
    };
  }, [topupModalOpen, topupStage, topupCheckoutClientSecret, topupPublishableKey, refreshUsageStatusOnce]);

  // Poll the backend pending record so we can show "credited" immediately without requiring a page refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!API_BASE) return;
    const pid = String(topupPendingId || "").trim();
    if (!pid) return;
    if (topupStage !== "waiting") return;

    let cancelled = false;

    const pollOnce = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${API_BASE}/topup/pending/${encodeURIComponent(pid)}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        const raw = await res.text().catch(() => "");
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        if (!res.ok) return;

        const status = String(json?.status || "").toUpperCase();
        if (status === "CREDITED") {
          const minutes = Number(json?.minutesCredited || json?.minutesToCredit || 0) || null;
          setTopupLastCreditedMinutes(minutes && minutes > 0 ? minutes : null);
          setTopupStage("credited");
          setTopupModalOpen(false);
          setTopupPendingId("");
          setTopupExpiresAt(null);
          setTopupError("");

          // Add a lightweight assistant note so the user knows they can continue.
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `✅ Payment received — ${(minutes && minutes > 0) ? minutes : "Top-up"} minutes have been added. You can continue chatting.`,
            },
          ]);
        } else if (status === "EXPIRED") {
          setTopupError("This top-up request expired. Please start again.");
          setTopupStage("error");
          setTopupModalOpen(true);
          setTopupPendingId("");
        }
      } catch (e) {
        // ignore transient polling errors
      }
    };

    pollOnce();
    const t = window.setInterval(pollOnce, 2000);
    topupPollTimerRef.current = t as any;

    return () => {
      cancelled = true;
      try { window.clearInterval(t); } catch (e) {}
    };
  }, [API_BASE, topupPendingId, topupStage]);


  // Members: poll /usage/status (read-only) until minutes are credited.
  // This avoids a page refresh and avoids burning minutes while waiting.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!API_BASE) return;
    if (!memberTopupWatching) return;

    // Meaningful for real members and visitor anon identities created by Connect.
    const mid = String(memberIdRef.current || memberIdForLiveChat || "").trim();
    if (!mid) return;

    let cancelled = false;
    const startedAt = memberTopupStartedAt || Date.now();

    const pollOnce = async () => {
      if (cancelled) return;

      // Stop after 10 minutes to avoid infinite polling if the user abandons checkout.
      if (Date.now() - startedAt > 10 * 60_000) {
        setMemberTopupWatching(false);
        return;
      }

      try {
        // Build a minimal session_state compatible with backend's usage logic.
        const companionForBackend =
          (companionKey || "").trim() ||
          (companionName || DEFAULT_COMPANION_NAME).trim() ||
          DEFAULT_COMPANION_NAME;

        const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || DEFAULT_COMPANY_NAME).trim();
        const brandKey = safeBrandKey(rawBrand);
        const memberIdForBackend = (memberId || memberIdForLiveChat || "").trim() || getOrCreateAnonMemberId(brandKey);

        const session_state: any = {
          ...(sessionStateRef.current as any),
          companion: companionForBackend,
          companionName: companionForBackend,
          companion_name: companionForBackend,

          memberId: (memberIdForBackend || "").trim(),
          member_id: (memberIdForBackend || "").trim(),

          planName: String(planName || "").trim(),
          plan_name: String(planName || "").trim(),

          planLabelOverride: String(planLabelOverride || "").trim(),
          plan_label_override: String(planLabelOverride || "").trim(),

          rebrandingKey: normalizeRebrandingKeyValue(rebrandingKey),
          rebranding_key: normalizeRebrandingKeyValue(rebrandingKey),
          RebrandingKey: normalizeRebrandingKeyValue(rebrandingKey),
          rebranding: String(rebranding || "").trim(),
        };

        const res = await fetch(`${API_BASE}/usage/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current || "",
            session_state,
          }),
          cache: "no-store" as any,
        } as any);

        if (!res.ok) return;

        const data: any = await res.json().catch(() => ({}));
        const remaining = Number(data?.minutes_remaining ?? data?.minutesRemaining ?? 0) || 0;
        applyUsageStatusSnapshot(data);

        if (remaining > 0) {
          setMemberTopupWatching(false);
          setMemberTopupError("");

          // Add a lightweight assistant note so the user knows they can continue.
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "✅ Payment received — minutes have been added. You can continue chatting.",
            },
          ]);
        }
      } catch (e: any) {
        // ignore transient polling errors
      }
    };

    pollOnce();
    const t = window.setInterval(pollOnce, 2500);
    memberTopupPollTimerRef.current = t as any;

    return () => {
      cancelled = true;
      try { window.clearInterval(t); } catch (e) {}
    };
  }, [API_BASE, memberTopupWatching, memberTopupStartedAt, memberId, memberIdForLiveChat, companionKey, companionName, planName, planLabelOverride, rebrandingKey, rebranding, applyUsageStatusSnapshot]);


  // Upgrade polling: while the user is in the upgrade flow, keep requesting the latest MEMBER_PLAN payload
  // so the iframe learns about the plan change without requiring a page refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!upgradeWatching) return;

    let cancelled = false;
    const startedAt = upgradeWatchStartedAtRef.current || Date.now();

    const pollOnce = () => {
      if (cancelled) return;

      // Stop after 3 minutes to avoid infinite polling.
      if (Date.now() - startedAt > 3 * 60_000) {
        stopUpgradeWatch();
        return;
      }

      requestLatestMemberPlanFromParent("upgrade_poll");
    };

    pollOnce();
    const t = window.setInterval(pollOnce, 2000);
    upgradeWatchTimerRef.current = t as any;

    return () => {
      cancelled = true;
      try {
        window.clearInterval(t);
      } catch (e) {}
    };
  }, [upgradeWatching, requestLatestMemberPlanFromParent, stopUpgradeWatch]);

  // When the user returns to this tab after upgrading, request a refresh immediately.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!upgradeWatching) return;

    const onFocus = () => requestLatestMemberPlanFromParent("focus");
    const onVis = () => {
      try {
        if (document.visibilityState === "visible") requestLatestMemberPlanFromParent("visible");
      } catch (e) {}
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [upgradeWatching, requestLatestMemberPlanFromParent]);


  // Auto-recovery when chat minutes are exhausted:
  //  - keep polling /usage/status so credited minutes unlock without refresh
  //  - keep nudging the parent iframe to refresh MEMBER_PLAN (covers plan upgrades)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const exhausted = Boolean((sessionStateRef.current as any)?.minutes_exhausted);
    if (!exhausted) return;

    // Start the upgrade watcher so MEMBER_PLAN refreshes continue even if the user upgraded in another tab.
    try {
      startUpgradeWatch("auto_minutes_exhausted");
    } catch (e) {}

    let cancelled = false;

    const pollOnce = async () => {
      if (cancelled) return;
      try {
        const stillExhausted = Boolean((sessionStateRef.current as any)?.minutes_exhausted);
        if (!stillExhausted) return;

        // Refresh backend usage/balance.
        await refreshUsageStatusOnce();

        // Also request the latest plan from the parent (Wix), if available.
        try {
          requestLatestMemberPlanFromParent("minutes_exhausted_poll");
        } catch (e) {}
      } catch (e) {}
    };

    pollOnce();
    const t = window.setInterval(pollOnce, 4000);

    return () => {
      cancelled = true;
      try { window.clearInterval(t); } catch (e) {}
    };
  }, [sessionState?.minutes_exhausted, refreshUsageStatusOnce, requestLatestMemberPlanFromParent, startUpgradeWatch]);

  // Stop upgrade polling once we detect a plan or login state change.
  useEffect(() => {
    if (!upgradeWatching) return;

    const initPlan = String(upgradeWatchInitialPlanRef.current || "").trim();
    const initLoggedIn = Boolean(upgradeWatchInitialLoggedInRef.current);
    const curPlan = String(planName || "").trim();
    const curLoggedIn = Boolean(loggedIn);

    const planChanged = Boolean(curPlan) && curPlan !== initPlan;
    const loginChanged = curLoggedIn !== initLoggedIn;

    if (!planChanged && !loginChanged) return;

    stopUpgradeWatch();

    // Refresh usage once so minute gates lift immediately (e.g., upgrading from Trial to a paid plan).
    void refreshUsageStatusOnce();

    // Add a short confirmation message.
    const label = String(planLabelOverride || "").trim() || curPlan || "your new plan";
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `✅ Upgrade detected — your plan is now ${label}. You can continue chatting.`,
      },
    ]);
  }, [upgradeWatching, planName, loggedIn, planLabelOverride, stopUpgradeWatch, refreshUsageStatusOnce]);



    // Lightweight viewer auto-refresh: if you are not the host, keep polling until the host creates/starts the event.
  // This avoids requiring manual page refresh for viewers waiting on the host.
  



  // True once we have received the Wix postMessage handoff (plan + companion).
  // Used to ensure the *first* audio-only TTS uses the selected companion voice (not the fallback).
  const [handoffReady, setHandoffReady] = useState<boolean>(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [setModeFlash, setSetModeFlash] = useState(false);
  const [switchCompanionFlash, setSwitchCompanionFlash] = useState(false);
  const [allowedModes, setAllowedModes] = useState<Mode[]>(["friend"]);

  // LegacyStream broadcaster (host-only) overlay
  // - "host" is determined by comparing the current Wix memberId to the LegacyStream host_member_id
  //   stored in voice_video_mappings.sqlite3 (exposed via /stream/livekit/status).
  const [livekitHostMemberId, setLivekitHostMemberId] = useState<string>("");
// Host-only Play modal (Stream vs Conference)
const [showPlayChoiceModal, setShowPlayChoiceModal] = useState<boolean>(false);

// Conference intent flag (prevents auto-rejoin when a user explicitly leaves).

// Track whether THIS client has actually joined the private session.
// We use both state (for UI) and a ref (for send() gating without stale closures).
const [conferenceJoined, setConferenceJoined] = useState<boolean>(false);
const conferenceJoinedRef = useRef<boolean>(false);

useEffect(() => {
  conferenceJoinedRef.current = conferenceJoined;
}, [conferenceJoined]);

  // LegacyStream status polling can hit different backend instances; avoid flickering UI by
  // only changing sessionActive on confirmed status responses.
  const livekitStatusInactivePollsRef = useRef<number>(0);
  // Viewer-only: treat the companion's LegacyStream session as "Live Streaming" when the HOST is live.
  // This is intentionally *global* (not tied to whether the viewer currently has the iframe open),
  // because we must block AI responses for everyone while the host is streaming.
  const viewerLiveStreaming =
    liveProvider === "stream" &&
    !streamCanStart &&
    (sessionActive ||
      (Boolean(streamEventRef) &&
        (avatarStatus === "connected" ||
          avatarStatus === "waiting" ||
          avatarStatus === "connecting" ||
          avatarStatus === "reconnecting")));

  // Viewer UX:
  // Once a Viewer joins the live stream session (Play -> iframe open), disable the Play button
  // to prevent duplicate joins. Pressing Stop re-enables Play.
  const viewerHasJoinedStream =
    liveProvider === "stream" &&
    !streamCanStart &&
    (avatarStatus === "connected" ||
      avatarStatus === "waiting" ||
      avatarStatus === "connecting" ||
      avatarStatus === "reconnecting");

  // ---------------------------------------------------------------------------
  // LegacyStream shared in-stream live chat (Host + joined Viewers)
  // - Only participants who have joined the stream UI (Play) connect.
  // - Messages are broadcast via WebSocket (HTTP fallback if WS not ready).
  // - Out-of-session visitors/members do NOT connect (so they cannot see the chat).
  // ---------------------------------------------------------------------------
  const liveChatWsRef = useRef<WebSocket | null>(null);
  const liveChatIdentityRef = useRef<string>("");
  const liveChatWsClosingRef = useRef<boolean>(false);
  const liveChatMemberIdRef = useRef<string>("");
  const liveChatRoleRef = useRef<string>("");
  const liveChatNameRef = useRef<string>("");
  const liveChatEventRefRef = useRef<string>("");
  const [, setLiveChatConnected] = useState<boolean>(false);

  // Dedup incoming chat messages (we echo-send to self).
  const liveChatSeenIdsRef = useRef<Set<string>>(new Set());
  const liveChatSeenOrderRef = useRef<string[]>([]);
  const liveChatSkipNextHistoryRef = useRef<boolean>(false);

  const rememberLiveChatId = useCallback((id: string) => {
    const msgId = String(id || '').trim();
    if (!msgId) return;
    const seen = liveChatSeenIdsRef.current;
    if (seen.has(msgId)) return;
    seen.add(msgId);
    liveChatSeenOrderRef.current.push(msgId);
    // prevent unbounded growth
    if (liveChatSeenOrderRef.current.length > 800) {
      const drop = liveChatSeenOrderRef.current.splice(0, 200);
      drop.forEach((d) => seen.delete(d));
    }
  }, []);

  const appendLiveChatMessage = useCallback(
    (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      const text = String(payload?.text || '').trim();
      if (!text) return;

      const clientMsgId = String(payload?.clientMsgId || '').trim();
      if (clientMsgId) {
        if (liveChatSeenIdsRef.current.has(clientMsgId)) return;
        rememberLiveChatId(clientMsgId);
      }

      const senderId = String(payload?.senderId || '').trim();
      const senderRole = String(payload?.senderRole || '').trim().toLowerCase();
      const nameRaw = String(payload?.name || '').trim();
      const fallbackLabel =
        senderRole === 'host'
          ? (String(companionName || 'Host').trim() || 'Host')
          : (senderId ? `Viewer-${senderId.slice(-4)}` : 'Viewer');
      const label = nameRaw || fallbackLabel;

      // Never include any live-chat lines in future /chat context (AI must ignore in-stream chat).
      const includeInAiContext = false;

      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: text,
          meta: { liveChat: true, senderId, senderRole, name: label, includeInAiContext, clientMsgId },
        },
      ]);
    },
    [companionName, rememberLiveChatId],
  );

  // Connect/disconnect the live chat websocket as the viewer/host joins/leaves the stream UI.
  useEffect(() => {
    const kind = String(sessionKind || "").trim().toLowerCase();

    const computeLiveChatEventRef = () => {
      if (kind === "conference") {
        const fallbackRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
        const room = String(sessionRoom || fallbackRoom).trim();
        const cleanRoom = sanitizeRoomToken(room, 96);
        return cleanRoom || "";
      }
      // Livestream viewers may only learn the room/eventRef from status polling (sessionRoom).
      return String(streamEventRef || sessionRoom || "").trim();
    };

    const eventRef = computeLiveChatEventRef();

    // IMPORTANT: this must be independent from the current UI mode (liveProvider).
    // Once a user has joined a live experience, they should remain connected to shared chat
    // until they explicitly press Stop (host) or opt-out (viewer, private session only).
    const inStreamUi =
      kind !== "conference" &&
      !!eventRef &&
      (isHost ? Boolean(sessionActive) : Boolean(viewerHasJoinedStream));

    const inConferenceUi =
      kind === "conference" &&
      !!eventRef &&
      (isHost ? Boolean(sessionActive) : Boolean(conferenceJoined));

    const inLiveChatUi = inStreamUi || inConferenceUi;

    // Always close if not in a live UI.
    if (!inLiveChatUi || !API_BASE) {
      try {
        liveChatWsRef.current?.close?.();
      } catch {}
      liveChatWsRef.current = null;
      liveChatWsClosingRef.current = true;
      liveChatEventRefRef.current = "";
      liveChatMemberIdRef.current = "";
      liveChatRoleRef.current = "";
      liveChatNameRef.current = "";
      return;
    }

    const role = isHost ? "host" : "viewer";
    const name =
      role === "host" ? String(companionName || "Host") : String(preferredViewerDisplayName || "").trim() || "Viewer";
    const memberIdForWs = String(memberIdForLiveChat || "").trim();

    if (
      liveChatWsRef.current &&
      liveChatWsRef.current.readyState === WebSocket.OPEN &&
      liveChatEventRefRef.current === eventRef &&
      liveChatMemberIdRef.current === memberIdForWs &&
      liveChatRoleRef.current === role &&
      liveChatNameRef.current === name
    ) {
      return;
    }

    try {
      liveChatWsRef.current?.close?.();
    } catch {}
    liveChatWsRef.current = null;
    liveChatWsClosingRef.current = false;

    const wsUrl = `${API_BASE.replace(/^http/, "ws")}/stream/livekit/livechat/${encodeURIComponent(
      eventRef
    )}?memberId=${encodeURIComponent(memberIdForWs || "")}&role=${encodeURIComponent(role)}&name=${encodeURIComponent(
      name
    )}`;

    const ws = new WebSocket(wsUrl);
    liveChatWsRef.current = ws;
    liveChatEventRefRef.current = eventRef;
    liveChatMemberIdRef.current = memberIdForWs;
    liveChatRoleRef.current = role;
    liveChatNameRef.current = name;

    ws.onmessage = (evt) => {
      try {
        const payload: any = JSON.parse(String((evt as any).data || "{}"));
        const t = String(payload?.type || "").toLowerCase();

        // History payload: { type: "history", messages: [...] }
        if (t === "history" && Array.isArray(payload?.messages)) {
          // For Live Private Conference we always start with a blank Live Sharing box.
          // Do not replay persisted history when a participant is admitted or reconnects.
          if (sessionKind === "conference") {
            liveChatSkipNextHistoryRef.current = false;
            return;
          }

          if (liveChatSkipNextHistoryRef.current) {
            // Keep the Live Sharing box blank when entering a session (Host clears history on entry).
            liveChatSkipNextHistoryRef.current = false;
            return;
          }
          for (const m of payload.messages) appendLiveChatMessage(m);
          return;
        }

        // Individual message payloads are typically { type: "chat", ... }.
        // Some legacy senders may use { type: "message", message: {...} }.
        if (t === "chat" || t === "message" || t === "") {
          const inner: any =
            t === "message" && payload?.message && typeof payload.message === "object" ? payload.message : payload;

          const textVal =
            inner && typeof inner === "object" ? inner.text ?? inner.message ?? inner.content : undefined;

          if (textVal != null && String(textVal).trim()) {
            appendLiveChatMessage(
              inner && typeof inner === "object" ? { ...inner, text: String(textVal) } : { text: String(textVal) }
            );
          }
          return;
        }

        // ignore other message types
      } catch {
        // ignore parse errors
      }
    };
    ws.onclose = () => {
      if (liveChatWsRef.current === ws) {
        liveChatWsRef.current = null;
      }
    };

    ws.onerror = () => {
      // Let HTTP fallback handle sends if WS fails.
    };

    return () => {
      try {
        ws.close();
      } catch {}
    };
  }, [
    API_BASE,
    sessionActive,
    "",
    streamEventRef,
    isHost,
    memberIdForLiveChat,
    companionName,
    preferredViewerDisplayName,
    appendLiveChatMessage,
    sessionKind,
    sessionRoom,
    companyName,
    conferenceJoined,
    viewerHasJoinedStream,
  ]);


  const sendLiveChatMessage = useCallback(
    async (text: string, clientMsgId: string) => {
      const kind = String(sessionKind || "").trim().toLowerCase();
      let eventRef = "";
      if (kind === "conference") {
        const fallbackRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
        const room = String(sessionRoom || fallbackRoom).trim();
        const cleanRoom = sanitizeRoomToken(room, 96);
        eventRef = cleanRoom || "";
      } else {
        // Livestream viewers may only learn the active room via status polling (sessionRoom)
        // until they explicitly join.
        eventRef = String(streamEventRef || sessionRoom || "").trim();
      }

      // Viewers must be actively in the Live UI to send shared chat.
      if (!isHost) {
        if (kind === "conference" && !conferenceJoinedRef.current) return;
        if (kind !== "conference" && !viewerHasJoinedStream) return;
      }

      if (!API_BASE || !eventRef) return;
      const clean = String(text || '').trim();
      if (!clean) return;

      const role = isHost ? 'host' : 'viewer';
      const name =
        role === 'host'
          ? (String(companionName || 'Host').trim() || 'Host')
          : (String(preferredViewerDisplayName || '').trim() || (memberIdForLiveChat ? `Viewer-${memberIdForLiveChat.slice(-4)}` : 'Viewer'));
      // IMPORTANT:
      // - The server expects a stable `clientMsgId` so clients can de-dupe websocket echo/history.
      // - We also include `clientId` for back-compat with older builds.
      const stableClientMsgId =
        String(clientMsgId || '').trim() ||
        ((crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

      const payload = {
        role,
        from: name,
        text: clean,
        userId: String(memberIdForLiveChat || '').trim(),
        clientMsgId: stableClientMsgId,
        clientId: stableClientMsgId,
      } as any;

      const ws = liveChatWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && liveChatEventRefRef.current === eventRef) {
        try {
          ws.send(JSON.stringify(payload));
          return;
        } catch (e) {
          // fall through to HTTP
        }
      }

      // HTTP fallback (stores message in room history + broadcasts to any connected sockets)
      try {
        const httpPayload = {
          eventRef,
          clientMsgId: payload.clientMsgId,
          name: payload.from,
          text: payload.text,
          role: payload.role,
          memberId: payload.userId,
        };

        const httpUrl = kind === 'conference' ? `${API_BASE}/conference/livekit/livechat/send` : `${API_BASE}/stream/livekit/livechat/send`;
        await fetch(httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(httpPayload),
        });
      } catch (e) {
        // ignore
      }
    },
    [API_BASE, streamEventRef, isHost, memberIdForLiveChat, companionName, preferredViewerDisplayName, sessionKind, sessionRoom, companyName],
  );

  const [showBroadcasterOverlay, setShowBroadcasterOverlay] = useState<boolean>(false);
  const [broadcasterOverlayUrl, setBroadcasterOverlayUrl] = useState<string>("");
  const [broadcastPreparing, setBroadcastPreparing] = useState<boolean>(false);
  const [broadcastError, setBroadcastError] = useState<string>("");


// LegacyStream "live session" gating (global per companion)
// - While the host is streaming, we must NOT generate AI responses for anyone.
// - We queue user messages locally and flush them once the host stops streaming.
const streamDeferredQueueRef = useRef<Array<{ text: string; state: SessionState; queuedAt: number; noticeIndex: number; clientTurnId?: string }>>([]);
const streamDeferredFlushInFlightRef = useRef<boolean>(false);
const streamPreSessionHistoryRef = useRef<Msg[] | null>(null);
const prevSessionActiveRef = useRef<boolean>(false);

// True when THIS browser session has explicitly joined the in-stream experience
// (Play pressed and not yet stopped). This is intentionally independent from the
// global sessionActive flag, because that flag indicates that *someone*
// (the Host) is streaming, while this ref indicates whether *this user* is in the
// shared in-stream chat.
const joinedStreamRef = useRef<boolean>(false);

// ===============================
// Conference helpers
// ===============================
const sanitizeRoomToken = useCallback((raw: string, maxLen = 128) => {
  // MUST match backend `_sanitize_room_token()` in main.py.
  // Backend uses underscores (not hyphens) and collapses repeated separators.
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/(^_+|_+$)/g, "");
  const out = s.length ? s : "room";
  return out.slice(0, maxLen);
}, []);

const startConferenceSession = useCallback(async () => {
    setAvatarError(null);
    setMessages([]); // Clear Live Sharing history on entry
    liveChatSeenIdsRef.current = new Set();
    liveChatSeenOrderRef.current = [];
    liveChatSkipNextHistoryRef.current = true;

    setLivekitMicEnabled(true);
  setLivekitCameraEnabled(true);

	    // Host: prime A/V permissions on the Play click (iOS/Safari requirement).
	    // Viewers are subscribe-only for now, so we do NOT require mic/cam permissions to request access.
	    if (isHost) {
	      const ok = await requestLivekitAvPermissions({
	        audio: true,
	        video: true,
	        reason: "starting a Private conference",
	      });
	      if (!ok) {
	        setAvatarStatus("error");
	        setAvatarError("Microphone and camera permissions are required to host the private conference.");
	        return;
	      }
	    }

    // Viewers request to join a private session. The host must admit them.
    if (!isHost) {
      setStreamNotice(null);
      setLivekitJoinStatus("pending");
      setAvatarStatus("waiting");

      // Reset any prior join attempt / token.
      setConferenceJoined(false);
      setLivekitJoinRequestId("");
      setLivekitToken("");
      setLivekitRole("viewer");

      // Mark intent so the "waiting to be admitted" overlay can render.
      setSessionKind("conference");

      // IMPORTANT: In conference mode, the backend may reuse an existing event_ref as the LiveKit room.
      // If we guess the room incorrectly here, the viewer will be admitted into a different room and
      // will see a blank screen. So we try to fetch the current room from status first.
      let requestedRoom = String(sessionRoom || "").trim();
      try {
        const b = encodeURIComponent(companyName);
        const a = encodeURIComponent(companionName);
        const mid = encodeURIComponent(String(memberId || ""));
        const statusResp = await fetch(
          `${API_BASE}/stream/livekit/status?brand=${b}&avatar=${a}&memberId=${mid}`
        );
        if (statusResp.ok) {
          const st = await statusResp.json();
          const stRoom = String(st.roomName || st.sessionRoom || st.streamEventRef || "").trim();
          if (stRoom) requestedRoom = stRoom;
          const stKind = String(st.sessionKind || st.kind || "").trim().toLowerCase();
          if (stKind) setSessionKind(stKind as SessionKind);
        }
      } catch {
        // ignore
      }
      if (!requestedRoom) requestedRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
      if (requestedRoom) {
        setSessionRoom(requestedRoom);
        setLivekitRoomName(requestedRoom);
        setStreamEventRef(requestedRoom);
      }

      // Viewers must join with mic + camera (they can switch to listen-only after joining).
      const granted = await requestLivekitAvPermissions({ audio: true, video: true, reason: "joining the private conference" });
      if (!granted) {
        setLivekitJoinStatus("idle");
        setAvatarStatus("idle");
        return;
      }

      // Clear any prior live-chat transcript for a clean join.
      setMessages((prev) => prev.filter((m) => !m?.meta?.liveChat));
      liveChatSeenIdsRef.current = new Set();

	      try {
	        const requestedDisplayName = String(
	          ensureViewerLiveChatName({
	            promptText: "Please enter your name to enter the the session",
	          }) ||
	            preferredViewerDisplayName ||
	            "",
	        ).trim();

        const resp = await fetch(`${API_BASE}/livekit/join_request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            roomName: requestedRoom,
            memberId: memberId || "",
            name: requestedDisplayName,
            displayName: requestedDisplayName,
          }),
        });

        const data = await resp.json().catch(() => ({} as any));

        if (!resp.ok || !data?.ok || !(data as any)?.requestId) {
          const msg =
            (data as any)?.detail ||
            (data as any)?.error ||
            `Unable to request private session (HTTP ${resp.status})`;
          setStreamNotice(String(msg));
          setAvatarStatus("waiting");
          return;
        }

        setLivekitJoinRequestId(String((data as any).requestId));
        setStreamNotice("Join request sent. Waiting for host approval…");
        return;
      } catch (err: any) {
        setStreamNotice(err?.message || "Unable to request private session.");
        setAvatarStatus("waiting");
        return;
      }
    }

    // Host starts (or resumes) the private session.
    conferenceOptOutRef.current = false;
    setStreamNotice(null);
      setLivekitJoinStatus("pending");
    setAvatarStatus("connecting");
    setConferenceJoined(false);
    setLivekitJoinRequestId("");

    try {
      const resp = await fetch(`${API_BASE}/conference/livekit/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: companyName,
          avatar: companionName,
          memberId: memberId || "",
          displayName: String(companionName || "Host").trim(),
        }),
      });

      const data = await resp.json().catch(() => ({} as any));

      if (!resp.ok || !data?.ok) {
        const msg =
          (data as any)?.detail ||
          (data as any)?.error ||
          `Failed to start private session (HTTP ${resp.status})`;
        setAvatarError(String(msg));
        setAvatarStatus("idle");
        return;
      }

      const room = String(
        (data as any)?.sessionRoom ||
          (data as any)?.room ||
          (data as any)?.roomName ||
          sanitizeRoomToken(`${companyName}-${companionName}`)
      ).trim();
      const token = String((data as any)?.token || "").trim();
      const serverUrl = String(
        (data as any)?.serverUrl || (data as any)?.server_url || LIVEKIT_URL || ""
      ).trim();

      if (!room || !token || !serverUrl) {
        setAvatarError("Private session did not return room/token/serverUrl.");
        setAvatarStatus("idle");
        return;
      }

      setLivekitServerUrl(serverUrl);
      const hostId = String((data as any)?.hostMemberId || "").trim();
      if (hostId) {
        setLivekitHostMemberId(hostId);
      }

      // Clear any prior live-chat messages from previous sessions in the UI.
      setMessages((prev) => prev.filter((m) => !(m as any)?.meta?.liveChat));

      // Clear prior live-chat transcript for a clean session start.
      setMessages((prev) => prev.filter((m) => !m?.meta?.liveChat));
      liveChatSeenIdsRef.current = new Set();

      setSessionKind("conference");
      setSessionActive(true);
      setSessionRoom(room);
      setLivekitRoomName(room);
      setStreamEventRef(room);
      setLivekitRole("host");
      setLivekitToken(token);
      setConferenceJoined(true);
      setAvatarStatus("connected");
    } catch (err: any) {
      setAvatarError(err?.message || "Network error starting private session.");
      setAvatarStatus("idle");
    }
  }, [API_BASE, companyName, companionName, isHost, memberId, sanitizeRoomToken, preferredViewerDisplayName, requestLivekitAvPermissions]);

// Keep refs to the latest state for async flush logic (avoids stale closures).
const messagesRef = useRef<Msg[]>([]);
useEffect(() => {
  messagesRef.current = messages;
}, [messages]);

// ---------------------------------------------------------------------------
// Auto-save conversation summaries (requirements):
// - every 6 turns
// - when Host override starts
// - when AI resumes after Host override ends
// - after 120 seconds of inactivity
// - at every 10-minute mark within the active conversation/session cycle
// - at each scheduled content delivery so delivered files are not missed
// ---------------------------------------------------------------------------
const autoSaveSummaryInFlightRef = useRef<boolean>(false);
const autoSaveSummaryLastAtRef = useRef<number>(0);
const autoSaveSummaryLastUserTurnsRef = useRef<number>(0);
const autoSaveSummaryIdleTimerRef = useRef<number | null>(null);
const autoSaveSummaryLastMsgLenRef = useRef<number>(0);
const autoSaveSummarySessionKeyRef = useRef<string>("");
const autoSaveSummaryTenMinuteTimerRef = useRef<number | null>(null);
const autoSaveSummaryTenMinuteLastBucketSavedRef = useRef<number>(0);
const autoSaveSummaryFirstUserTurnAtRef = useRef<number>(0);
const autoSaveSummaryTenMinuteCycleKeyRef = useRef<string>("");
const autoSaveSummaryContentDeliveryTimerRef = useRef<number | null>(null);
const autoSaveSummaryLastContentDeliveryCountRef = useRef<number>(0);

const resetAutoSaveSummaryCycleState = useCallback(() => {
  if (autoSaveSummaryTenMinuteTimerRef.current) {
    window.clearTimeout(autoSaveSummaryTenMinuteTimerRef.current);
    autoSaveSummaryTenMinuteTimerRef.current = null;
  }
  if (autoSaveSummaryContentDeliveryTimerRef.current) {
    window.clearTimeout(autoSaveSummaryContentDeliveryTimerRef.current);
    autoSaveSummaryContentDeliveryTimerRef.current = null;
  }
  autoSaveSummaryTenMinuteLastBucketSavedRef.current = 0;
  autoSaveSummaryFirstUserTurnAtRef.current = 0;
  autoSaveSummaryTenMinuteCycleKeyRef.current = "";
  autoSaveSummaryLastContentDeliveryCountRef.current = 0;
}, []);

const getAutoSaveSummaryMessages = useCallback((): Msg[] => {
  const msgList = messagesRef.current || [];
  return msgList.filter((m) => {
    const meta: any = (m as any)?.meta || {};
    if (meta?.includeInAiContext === false) return false;
    if (meta?.liveChat) return false;
    return true;
  });
}, []);

const getAutoSaveSummaryUserTurns = useCallback((): number => {
  return getAutoSaveSummaryMessages().filter((m) => m.role === "user").length;
}, [getAutoSaveSummaryMessages]);

const getAutoSaveSummaryContentDeliveryCount = useCallback((): number => {
  return getAutoSaveSummaryMessages().filter((m) => {
    if ((m as any)?.role !== "assistant") return false;
    const meta: any = (m as any)?.meta || {};
    const content = String((m as any)?.content || "");
    return Boolean(meta?.contentDelivery) || isPlatformContentPlaceholderText(content);
  }).length;
}, [getAutoSaveSummaryMessages]);

const autoSaveChatSummary = useCallback(
  async (reason: string, opts?: { force?: boolean }): Promise<boolean> => {
    try {
      if (!API_BASE) return false;

      // Throttle: avoid spamming save-summary when multiple triggers fire in quick succession.
      const now = Date.now();
      if (autoSaveSummaryInFlightRef.current) return false;
      if (!opts?.force && now - autoSaveSummaryLastAtRef.current < 3000) return false;

      const messagesForSummary = getAutoSaveSummaryMessages();
      if (!messagesForSummary.length) return false;

      autoSaveSummaryInFlightRef.current = true;
      const resp = await callSaveChatSummary(messagesForSummary, sessionState, reason || "auto_save");
      if (resp?.ok) {
        autoSaveSummaryLastAtRef.current = now;
        return true;
      }
      return false;
    } catch {
      // ignore
      return false;
    } finally {
      autoSaveSummaryInFlightRef.current = false;
    }
  },
  [API_BASE, sessionState, getAutoSaveSummaryMessages]
);

// Every message append: schedule idle timer (120s).
useEffect(() => {
  const len = (messagesRef.current || []).length || 0;
  if (!len) return;

  autoSaveSummaryLastMsgLenRef.current = len;

  if (autoSaveSummaryIdleTimerRef.current) {
    window.clearTimeout(autoSaveSummaryIdleTimerRef.current);
    autoSaveSummaryIdleTimerRef.current = null;
  }

  const startLen = len;
  autoSaveSummaryIdleTimerRef.current = window.setTimeout(() => {
    const curLen = (messagesRef.current || []).length || 0;
    if (curLen !== startLen) return; // activity occurred
    void autoSaveChatSummary("idle_120s");
  }, 120000);

  return () => {
    if (autoSaveSummaryIdleTimerRef.current) {
      window.clearTimeout(autoSaveSummaryIdleTimerRef.current);
      autoSaveSummaryIdleTimerRef.current = null;
    }
  };
}, [messages.length, autoSaveChatSummary]);

// Every 6 user turns (user messages) once the assistant has replied.
useEffect(() => {
  const msgList = messagesRef.current || [];
  if (!msgList.length) return;

  const last = msgList[msgList.length - 1];
  if (!last || last.role !== "assistant") return;

  const userTurns = getAutoSaveSummaryUserTurns();

  if (!userTurns) return;
  if (userTurns % 6 !== 0) return;
  if (autoSaveSummaryLastUserTurnsRef.current === userTurns) return;

  autoSaveSummaryLastUserTurnsRef.current = userTurns;
  void autoSaveChatSummary(`turns_${userTurns}`);
}, [messages.length, autoSaveChatSummary, getAutoSaveSummaryUserTurns]);

// Reset autosave markers whenever the underlying session changes.
// This keeps the recurring 10-minute/content-delivery autosaves session-scoped.
useEffect(() => {
  const currentSessionKey =
    String(sessionIdRef.current || "").trim() ||
    String((sessionState as any)?.session_id || (sessionState as any)?.sessionId || "").trim() ||
    "";

  if (!currentSessionKey) return;
  if (autoSaveSummarySessionKeyRef.current === currentSessionKey) return;

  autoSaveSummarySessionKeyRef.current = currentSessionKey;
  autoSaveSummaryLastUserTurnsRef.current = 0;
  autoSaveSummaryLastMsgLenRef.current = 0;
  autoSaveSummaryLastAtRef.current = 0;
  resetAutoSaveSummaryCycleState();
}, [sessionState, resetAutoSaveSummaryCycleState]);

// Reset autosave markers whenever the visible conversation is empty again.
useEffect(() => {
  const len = (messagesRef.current || []).length || 0;
  if (len) return;

  autoSaveSummaryLastUserTurnsRef.current = 0;
  autoSaveSummaryLastMsgLenRef.current = 0;
  autoSaveSummaryLastAtRef.current = 0;
  resetAutoSaveSummaryCycleState();
}, [messages.length, resetAutoSaveSummaryCycleState]);

// Track the first user turn so we can add autosaves at every 10-minute session mark.
// This is scoped to the current conversation/session cycle.
useEffect(() => {
  const userTurns = getAutoSaveSummaryUserTurns();
  if (!userTurns) {
    resetAutoSaveSummaryCycleState();
    return;
  }

  if (!autoSaveSummaryFirstUserTurnAtRef.current) {
    const startedAt = Date.now();
    const sid = String(sessionIdRef.current || "anon").trim() || "anon";
    autoSaveSummaryFirstUserTurnAtRef.current = startedAt;
    autoSaveSummaryTenMinuteLastBucketSavedRef.current = 0;
    autoSaveSummaryTenMinuteCycleKeyRef.current = `${sid}:${startedAt}`;
  }
}, [messages.length, getAutoSaveSummaryUserTurns, resetAutoSaveSummaryCycleState]);

const autoSaveSummaryUsedSeconds = Number((sessionState as any)?.used_seconds ?? (sessionState as any)?.usedSeconds ?? NaN);

// Autosave at every 10-minute mark for the current conversation/session cycle (10m, 20m, 30m, ...).
useEffect(() => {
  const userTurns = getAutoSaveSummaryUserTurns();
  if (!userTurns) return;

  const cycleKey = String(autoSaveSummaryTenMinuteCycleKeyRef.current || "").trim();
  if (!cycleKey) return;

  let cancelled = false;

  const getDueBucket = (): number => {
    const startedAt = autoSaveSummaryFirstUserTurnAtRef.current || 0;
    const wallBucket = startedAt ? Math.floor(Math.max(0, Date.now() - startedAt) / 600000) : 0;
    const usedBucket = Number.isFinite(autoSaveSummaryUsedSeconds)
      ? Math.floor(Math.max(0, autoSaveSummaryUsedSeconds) / 600)
      : 0;
    return Math.max(wallBucket, usedBucket);
  };

  const getNextDelayMs = (): number => {
    const startedAt = autoSaveSummaryFirstUserTurnAtRef.current || 0;
    if (!startedAt) return 600000;
    const nextBucket = Math.max(1, autoSaveSummaryTenMinuteLastBucketSavedRef.current + 1);
    const targetAt = startedAt + nextBucket * 600000;
    return Math.max(0, targetAt - Date.now());
  };

  const scheduleAttempt = (delayMs: number) => {
    if (autoSaveSummaryTenMinuteTimerRef.current) {
      window.clearTimeout(autoSaveSummaryTenMinuteTimerRef.current);
      autoSaveSummaryTenMinuteTimerRef.current = null;
    }

    autoSaveSummaryTenMinuteTimerRef.current = window.setTimeout(() => {
      if (cancelled) return;
      if (String(autoSaveSummaryTenMinuteCycleKeyRef.current || "").trim() !== cycleKey) return;

      void (async () => {
        const dueBucket = getDueBucket();
        const nextBucket = autoSaveSummaryTenMinuteLastBucketSavedRef.current + 1;
        if (dueBucket < nextBucket) {
          scheduleAttempt(getNextDelayMs());
          return;
        }

        const msgList = messagesRef.current || [];
        const last = msgList[msgList.length - 1];
        const assistantTurnComplete = !loadingRef.current && (!last || last.role === "assistant");
        if (!assistantTurnComplete) {
          scheduleAttempt(2000);
          return;
        }

        const ok = await autoSaveChatSummary(`session_${nextBucket * 10}m`, { force: true });
        if (cancelled) return;
        if (String(autoSaveSummaryTenMinuteCycleKeyRef.current || "").trim() !== cycleKey) return;

        if (ok) {
          autoSaveSummaryTenMinuteLastBucketSavedRef.current = nextBucket;
          const remainingDueBucket = getDueBucket();
          if (remainingDueBucket > autoSaveSummaryTenMinuteLastBucketSavedRef.current) {
            scheduleAttempt(0);
          } else {
            scheduleAttempt(getNextDelayMs());
          }
          return;
        }

        // If another autosave is in flight (or just happened), retry shortly so the
        // 10-minute snapshot is not lost for this session cycle.
        scheduleAttempt(4000);
      })();
    }, Math.max(0, delayMs));
  };

  const dueBucket = getDueBucket();
  const nextBucket = autoSaveSummaryTenMinuteLastBucketSavedRef.current + 1;
  if (dueBucket >= nextBucket) {
    scheduleAttempt(0);
  } else {
    scheduleAttempt(getNextDelayMs());
  }

  return () => {
    cancelled = true;
    if (autoSaveSummaryTenMinuteTimerRef.current) {
      window.clearTimeout(autoSaveSummaryTenMinuteTimerRef.current);
      autoSaveSummaryTenMinuteTimerRef.current = null;
    }
  };
}, [messages.length, autoSaveSummaryUsedSeconds, autoSaveChatSummary, getAutoSaveSummaryUserTurns]);

// Autosave whenever a new scheduled content delivery appears in the session transcript.
// This runs in addition to the timed/turn/idle autosaves so delivered files are not missed.
useEffect(() => {
  const userTurns = getAutoSaveSummaryUserTurns();
  if (!userTurns) return;

  const currentDeliveryCount = getAutoSaveSummaryContentDeliveryCount();
  if (!currentDeliveryCount) return;
  if (currentDeliveryCount <= autoSaveSummaryLastContentDeliveryCountRef.current) return;

  let cancelled = false;

  const scheduleAttempt = (delayMs: number) => {
    if (autoSaveSummaryContentDeliveryTimerRef.current) {
      window.clearTimeout(autoSaveSummaryContentDeliveryTimerRef.current);
      autoSaveSummaryContentDeliveryTimerRef.current = null;
    }

    autoSaveSummaryContentDeliveryTimerRef.current = window.setTimeout(() => {
      if (cancelled) return;

      const latestDeliveryCount = getAutoSaveSummaryContentDeliveryCount();
      const nextDeliveryCount = autoSaveSummaryLastContentDeliveryCountRef.current + 1;
      if (latestDeliveryCount < nextDeliveryCount) return;

      const msgList = messagesRef.current || [];
      const last = msgList[msgList.length - 1];
      const assistantTurnComplete = !loadingRef.current && (!last || last.role === "assistant");
      if (!assistantTurnComplete) {
        scheduleAttempt(2000);
        return;
      }

      void (async () => {
        const saveThroughCount = getAutoSaveSummaryContentDeliveryCount();
        const ok = await autoSaveChatSummary(`content_delivery_${saveThroughCount}`, { force: true });
        if (cancelled) return;

        if (ok) {
          autoSaveSummaryLastContentDeliveryCountRef.current = Math.max(
            autoSaveSummaryLastContentDeliveryCountRef.current,
            saveThroughCount
          );
          const refreshedCount = getAutoSaveSummaryContentDeliveryCount();
          if (refreshedCount > autoSaveSummaryLastContentDeliveryCountRef.current) {
            scheduleAttempt(0);
          }
          return;
        }

        // If another autosave is in flight (or just happened), retry shortly so the
        // content-delivery snapshot is not lost.
        scheduleAttempt(4000);
      })();
    }, Math.max(0, delayMs));
  };

  scheduleAttempt(0);

  return () => {
    cancelled = true;
    if (autoSaveSummaryContentDeliveryTimerRef.current) {
      window.clearTimeout(autoSaveSummaryContentDeliveryTimerRef.current);
      autoSaveSummaryContentDeliveryTimerRef.current = null;
    }
  };
}, [messages, autoSaveChatSummary, getAutoSaveSummaryUserTurns, getAutoSaveSummaryContentDeliveryCount]);

useEffect(() => {
  return () => {
    if (autoSaveSummaryTenMinuteTimerRef.current) {
      window.clearTimeout(autoSaveSummaryTenMinuteTimerRef.current);
      autoSaveSummaryTenMinuteTimerRef.current = null;
    }
    if (autoSaveSummaryContentDeliveryTimerRef.current) {
      window.clearTimeout(autoSaveSummaryContentDeliveryTimerRef.current);
      autoSaveSummaryContentDeliveryTimerRef.current = null;
    }
  };
}, []);

// Host override transitions: save immediately on start/end.
const prevHostOverrideRef = useRef<boolean>(false);
useEffect(() => {
  const cur = Boolean((sessionState as any)?.host_override_active);
  const prev = prevHostOverrideRef.current;

  if (cur === prev) return;
  prevHostOverrideRef.current = cur;

  void autoSaveChatSummary(cur ? "host_override_enabled" : "host_override_ended_ai_resumed");
}, [sessionState, autoSaveChatSummary]);


const stopConferenceSession = useCallback(async () => {
  if (stopInProgressRef.current) return;
  stopInProgressRef.current = true;
  setStreamNotice(null);

  try {
    // Always tear down local media + UI state (lets the user recover from a stuck session).
    cleanupIphoneLiveAvatarAudio();

    setLivekitToken("");
    setLivekitRoomName("");
    setLivekitHlsUrl("");
    setConferenceJoined(false);
      setShowBroadcasterOverlay(false);
      setBroadcasterOverlayUrl("");
      setBroadcastPreparing(false);
      setBroadcastError(null);

    setAvatarStatus("idle");
    setLivekitJoinRequestId("");
    setLivekitJoinStatus("idle");
    setLivekitPending([]);
    // Preserve AI chat history on stop; remove only live-sharing chat messages.
    setMessages((prev: any[]) =>
      (prev || []).filter((m: any) => !Boolean(m?.meta?.liveChat))
    );
    setLiveSharingNotice(null);

    // Viewer leaving should NOT stop the private session for everyone.
    if (!isHost) {
      conferenceOptOutRef.current = true;
      return;
    }

    // Host: stop *any* active session (private OR stream) to prevent stale/stuck state.
    const payload = {
      brand: companyName,
      avatar: companionName,
      memberId: memberIdRef.current || "",
    };

    await fetch(`${API_BASE}/conference/livekit/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);

    await fetch(`${API_BASE}/stream/livekit/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);

    setSessionActive(false);
    setSessionKind("");
    sessionActiveRef.current = false;
    streamOptOutRef.current = false;
    conferenceOptOutRef.current = false;
    setStreamCanStart(false);

    setStreamNotice("Stopped.");
  } catch (err) {
    console.error("stopConferenceSession failed", err);
    setStreamNotice("Stop failed. Please refresh and try again.");
  } finally {
    stopInProgressRef.current = false;
  }
}, [API_BASE, companyName, companionName, cleanupIphoneLiveAvatarAudio, isHost]);

const sessionStateRef = useRef<SessionState>(sessionState);
useEffect(() => {
  sessionStateRef.current = sessionState;
}, [sessionState]);


  const showBroadcastButton = false; // Disabled: Broadcast overlay reserved for future HLS/egress. Use Play/Stop for WebRTC LiveKit.
const goToMyElaralo = useCallback(() => {
    const url = "https://www.elaralo.com/myelaralo";

    // If running inside an iframe, attempt to navigate the *top* browsing context
    // so we leave the embed and avoid “stacked headers”.
    try {
      if (window.top && window.top !== window.self) {
        window.top.location.href = url;
        return;
      }
    } catch (e) {
      // Cross-origin access to window.top can throw.
    }

    // Alternate attempt that may still target the top browsing context.
    try {
      window.open(url, "_top");
      return;
    } catch (e) {
      // ignore
    }

    // Fallback: navigate the current frame.
    window.location.href = url;
  }, []);

  const goToCompanionList = useCallback(() => {
    const target = String(companionListReturnContext.url || "").trim();
    if (!canReturnToCompanionList || !target) return;
    try {
      window.location.assign(target);
      return;
    } catch {
      try {
        window.location.href = target;
      } catch {
        // ignore
      }
    }
  }, [canReturnToCompanionList, companionListReturnContext.url]);

  // NOTE: Upgrade navigation is handled by `openUpgradeUrl()` near the RebrandingKey section
  // so the chat session can stay loaded while the user upgrades in a new tab.



// ---------------------------------------------------------------------------
// LegacyStream broadcaster overlay (Host-only) + session status (Host + Viewer)
// - Fetch the host_member_id + current sessionActive flag for the current companion.
// - Polls so *all* visitors/members (even when not in Stream mode) can immediately gate AI replies
//   as soon as the Host hits Play.
// ---------------------------------------------------------------------------
useEffect(() => {
    if (!API_BASE || !companyName || !companionName) {
      setLivekitHostMemberId("");
      setSessionActive(false);
      livekitStatusInactivePollsRef.current = 0;
      return;
    }

    let cancelled = false;
    let pollTimer: any = null;

    const fetchStatus = async () => {
      try {
        const url = `${API_BASE}/stream/livekit/status?brand=${encodeURIComponent(
          companyName,
        )}&avatar=${encodeURIComponent(companionName)}&memberId=${encodeURIComponent(
          memberIdRef.current || "",
        )}`;
        const res = await fetch(url, { cache: "no-store" });

        if (cancelled) return;

        let data: any = null;
        try {
          data = await res.json();
        } catch (_) {
          data = null;
        }

        if (cancelled) return;

        if (!res.ok || !data?.ok) {
          // Keep last known-good; do not flicker sessionActive on transient poll failures.
          return;
        }

        const nextHostId = String(data.hostMemberId || "").trim();
        if (nextHostId) {
          setLivekitHostMemberId(nextHostId);
        }
        const nextServerUrl = String((data as any).serverUrl || (data as any).server_url || "").trim();
        if (nextServerUrl) {
          setLivekitServerUrl(nextServerUrl);
        }


        const rawKind = String((data as any).sessionKind || "").trim().toLowerCase();
        const nextRoom = String(
          (data as any).room ||
            (data as any).sessionRoom ||
            (data as any).roomName ||
            ""
        ).trim();

        // Backend versions prior to main_V11 reported `sessionActive=false` for conferences.
        // To avoid breaking Private conference UX (blank screen + state resets), treat an
        // active conference as "active" when kind=conference and roomName is present.
        const nextActive =
          Boolean((data as any).sessionActive) || (rawKind === "conference" && Boolean(nextRoom));

        const nextKind: SessionKind =
          rawKind === "conference" || rawKind === "stream" ? (rawKind as SessionKind) : nextActive ? "stream" : "";

        const effectiveMemberId = String(memberIdRef.current || "").trim();

        const nextCanStart =
          effectiveMemberId && typeof (data as any).canStart === "boolean"
            ? Boolean((data as any).canStart)
            : null;

        if (nextCanStart !== null) {
          setStreamCanStart(nextCanStart);
          if (nextCanStart) setLivekitRole("host");
          else setLivekitRole((prev) => (prev === "unknown" ? "viewer" : prev));
        }

        if (nextActive) {
          livekitStatusInactivePollsRef.current = 0;
          setSessionActive(true);
          setSessionKind(nextKind);
          setSessionRoom(nextRoom);
        } else {
          livekitStatusInactivePollsRef.current += 1;

          // Only clear after 2 consecutive "inactive" polls to avoid flicker.
          if (livekitStatusInactivePollsRef.current >= 2) {
            setSessionActive(false);
            setSessionKind("");
            setSessionRoom("");
            conferenceOptOutRef.current = false;
          }
        }
      }
      catch (_e) {
        // Keep last known-good on fetch errors.
        return;
      }
    };

    void fetchStatus();
    pollTimer = window.setInterval(() => {
      void fetchStatus();
    }, 2500);

    return () => {
      cancelled = true;
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
    };
  }, [API_BASE, companyName, companionName]);

  // If the host ends a session, ensure viewers fully exit (equivalent to pressing Stop).
  // This is a safety net in addition to LiveKit's kick/disconnect behavior.
  useEffect(() => {
    if (isHost) return;
    if (sessionActive) return;

    const viewerWasInLiveUi =
      Boolean(livekitToken) ||
      Boolean(conferenceJoined) ||
      Boolean(viewerHasJoinedStream) ||
      Boolean(streamEventRef) ||
      Boolean(sessionRoom) ||
      livekitJoinStatus !== "idle" ||
      Boolean(livekitJoinRequestId);

    if (!viewerWasInLiveUi) return;
    if (stopInProgressRef.current) return;

    void stopConferenceSession();
  }, [
    isHost,
    sessionActive,
    livekitToken,
    conferenceJoined,
    viewerHasJoinedStream,
    streamEventRef,
    sessionRoom,
    livekitJoinStatus,
    livekitJoinRequestId,
    stopConferenceSession,
  ]);

// Viewer UX: if a viewer joined before the host activated the session, we initially show a
// "Waiting on ..." notice (avatarStatus="waiting"). As soon as the host activates the session,
// remove the waiting notice.
useEffect(() => {
  if (!sessionActive) return;
    if (sessionKind === "conference") return;
  if (streamCanStart) return; // host
  if (!joinedStreamRef.current) return;
  if (avatarStatus !== "waiting") return;

  setStreamNotice("");
  setAvatarStatus("connected");
}, [sessionActive, sessionKind, streamCanStart, avatarStatus]);

  // Conference join is mediated via LiveKit join requests (viewer requests → host admits).

  


  // Reset broadcaster UI when switching companion / provider.
useEffect(() => {
  // Broadcaster overlay is stream-only and must never persist across companion/provider switches.
  setShowBroadcasterOverlay(false);
  setBroadcasterOverlayUrl("");
  setBroadcastPreparing(false);
  setBroadcastError("");
}, [companyName, companionName, liveProvider]);

// Reset stream chat queue only when switching companions (NOT when toggling providers).
// Visitors/members may be queued while Dulce is live even if they are not in Stream mode.
useEffect(() => {
  streamDeferredQueueRef.current = [];
  streamPreSessionHistoryRef.current = null;
  prevSessionActiveRef.current = false;
  joinedStreamRef.current = false;

  setLivekitHostMemberId("");
  setSessionActive(false);
}, [companyName, companionName]);

  // If host-eligibility changes (e.g., user logs out), force-hide the overlay.
  useEffect(() => {
    if (!showBroadcastButton) setShowBroadcasterOverlay(false);
  }, [showBroadcastButton]);

  const toggleBroadcastOverlay = useCallback(async () => {
    if (!showBroadcastButton) return;

    // Toggle OFF: stop the LiveKit stream session (server-side) and close overlay.
    if (showBroadcasterOverlay) {
      setBroadcastError("");
      setBroadcastPreparing(true);
      try {
        await fetch(`${API_BASE}/stream/livekit/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            memberId: memberIdRef.current || "",
          }),
        }).catch(() => {});
      } finally {
        setBroadcastPreparing(false);
        setShowBroadcasterOverlay(false);
        // Disconnect LiveKit UI (if connected via overlay)
        setLivekitToken("");
        setLivekitRoomName("");
        setLivekitHlsUrl("");
      }
      return;
    }

    // Toggle ON: start/ensure session is live + get host token.
    setShowBroadcasterOverlay(true);
    setBroadcastError("");
    setBroadcastPreparing(true);

    try {
      const embedDomain = typeof window !== "undefined" ? window.location.hostname : "";

      const res = await fetch(`${API_BASE}/stream/livekit/start_broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: companyName,
          avatar: companionName,
          embedDomain,
          memberId: memberIdRef.current || "",
        }),
      });

      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(String(data?.detail || data?.error || data?.message || `HTTP ${res.status}`));
      }
      if (!data?.isHost) {
        throw new Error("Broadcast is only available for the host account.");
      }

      const roomName = String(data?.roomName || "").trim();
      const token = String(data?.token || "").trim();
      const hlsUrl = String(data?.hlsUrl || "").trim();

      if (!roomName || !token) throw new Error("LiveKit did not return a roomName/token.");

      setLivekitRoomName(roomName);
      setLivekitRole("host");
      setLivekitToken(token);
      setLivekitHlsUrl(hlsUrl);

      // Mark locally active (used elsewhere for gating)
      setSessionActive(true);
      setSessionKind("stream");
      setSessionRoom(roomName);
    } catch (err: any) {
      console.error("LiveKit start_broadcast failed:", err);
      setBroadcastError(err?.message ? String(err.message) : String(err));
      // Keep overlay open so the host can see the error and close it via the Broadcast button.
    } finally {
      setBroadcastPreparing(false);
    }
  }, [
    API_BASE,
    companyName,
    companionName,
    showBroadcastButton,
    showBroadcasterOverlay,
  ]);



  const modePills = useMemo(() => ["friend", "romantic", "intimate"] as const, []);
  const messagesBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;

    // Keep scrolling inside the message box so the page itself doesn't "jump"
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // Speech-to-text (Web Speech API): "hands-free" mode
  // - User clicks mic once to start/stop
  // - Auto-sends after 2s of silence
  // - Automatically restarts recognition when it stops (browser behavior)
  const sttRecRef = useRef<any>(null);
  const sttSilenceTimerRef = useRef<number | null>(null);
  const sttRestartTimerRef = useRef<number | null>(null);
  const sttRecoverTimerRef = useRef<number | null>(null);
  const sttAudioCaptureFailsRef = useRef<number>(0);
  const sttLastAudioCaptureAtRef = useRef<number>(0);
  const sttNotAllowedFailsRef = useRef<number>(0);
  const sttLastNotAllowedAtRef = useRef<number>(0);
  const sttEverStartedRef = useRef<boolean>(false);

  const sttFinalRef = useRef<string>("");
  const sttInterimRef = useRef<string>("");
  const sttIgnoreUntilRef = useRef<number>(0); // suppress STT while avatar is speaking (prevents feedback loop)

  const [sttEnabled, setSttEnabled] = useState(false);
  const [sttRunning, setSttRunning] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  // Track whether the user has already granted microphone access in this session.
  // On iOS Web Speech, this becomes true on SpeechRecognition.onstart (after the permission prompt).
  const [micGranted, setMicGranted] = useState(false);
  const micGrantedRef = useRef<boolean>(false);

  // If a voice greeting is requested before mic permission is granted, we queue it here and
  // play it as soon as both mic permission + (for live) the avatar connection are ready.
  const pendingGreetingModeRef = useRef<("live" | "audio") | null>(null);


  // iOS: prefer backend STT (MediaRecorder → /stt/transcribe) for **audio-only** mode.
  // Browser SpeechRecognition can be flaky on iOS (especially after auto-restarts).
  const [backendSttAvailable, setBackendSttAvailable] = useState(true);

  // These state setters exist to trigger renders when backend STT updates refs (mobile stability).
  // We intentionally ignore the state values to avoid UI changes.
  const [, setSttInterim] = useState<string>("");
  const [, setSttFinal] = useState<string>("");

  const sttEnabledRef = useRef<boolean>(false);
  useEffect(() => {
    micGrantedRef.current = micGranted;
  }, [micGranted]);

  const sttPausedRef = useRef<boolean>(false);
  // Backend STT (iOS-safe): record mic audio via getUserMedia + MediaRecorder and transcribe server-side.
  const backendSttInFlightRef = useRef<boolean>(false);
  const backendSttAbortRef = useRef<AbortController | null>(null);
  const backendSttStreamRef = useRef<MediaStream | null>(null);
  const backendSttRecorderRef = useRef<MediaRecorder | null>(null);
  const backendSttAudioCtxRef = useRef<AudioContext | null>(null);
  const backendSttRafRef = useRef<number | null>(null);
  const backendSttHardStopTimerRef = useRef<number | null>(null);
  const backendSttLastVoiceAtRef = useRef<number>(0);
  const backendSttHasSpokenRef = useRef<boolean>(false);


  const getEmbedHint = useCallback(() => {
    if (!isEmbedded) return "";
    return " The Connect iframe must be loaded with Wix iframe permissions for microphone, camera, and autoplay before microphone capture can start.";
  }, [isEmbedded]);

  const greetingTranslationCacheRef = useRef<Record<string, string>>({});
  const getLocalizedGreeting = useCallback(async (name: string, languageCode: string, preferenceKnown: boolean) => {
    const englishText = greetingFor(name);
    const targetLanguageCode = normalizeLanguageTag(languageCode) || "en";

    if (!preferenceKnown || isEnglishLanguage(targetLanguageCode) || !API_BASE) {
      return {
        displayText: englishText,
        translationMeta: null as any,
      };
    }

    const cacheKey = `${targetLanguageCode}|${englishText}`;
    let translated = String(greetingTranslationCacheRef.current[cacheKey] || "").trim();

    if (!translated) {
      try {
        const res = await fetch(`${API_BASE}/translation/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: englishText,
            source_language_code: "en",
            target_language_code: targetLanguageCode,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          translated = String(data?.text || "").trim();
          if (translated) greetingTranslationCacheRef.current[cacheKey] = translated;
        }
      } catch (e) {}
    }

    const displayText = String(translated || englishText).trim() || englishText;
    const translationMeta = !isEnglishLanguage(targetLanguageCode) && displayText !== englishText
      ? {
          displayText,
          nativeText: displayText,
          englishText,
          userLanguageCode: targetLanguageCode,
          userLanguageName: languageNameFromCode(targetLanguageCode),
        }
      : null;

    return { displayText, translationMeta };
  }, [API_BASE]);


  // Greeting once per browser session per companion.
  // Rule:
  // - If the user's preferred language is unknown, keep the initial greeting in English.
  // - Once a preferred language is known, refresh the greeting into that language if no user turn exists yet.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isEmbedded && !startupIdentityResolved) return;

    let cancelled = false;
    const desiredName =
      (companionName || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;

    const keyName = normalizeKeyForFile(desiredName);
    const greetingLanguageCode = userLanguagePreferenceKnown
      ? (normalizeLanguageTag(userLanguageCode) || "en")
      : "en";
    const greetKey = `${GREET_ONCE_KEY}:${keyName}:${normalizeKeyForFile(greetingLanguageCode || "en")}`;

    const tmr = window.setTimeout(() => {
      (async () => {
        const already = sessionStorage.getItem(greetKey) === "1";
        const { displayText, translationMeta } = await getLocalizedGreeting(
          desiredName,
          greetingLanguageCode,
          userLanguagePreferenceKnown,
        );
        if (cancelled) return;

        let greetingMsg: Msg = {
          role: "assistant",
          content: displayText,
          meta: {
            greeting: true,
            greetingLanguageCode,
            greetingLanguageKnown: userLanguagePreferenceKnown,
          },
        };
        if (translationMeta) {
          greetingMsg = applyTranslationMetaToMsg(greetingMsg, translationMeta, displayText);
        }

        setMessages((prev) => {
          if (prev.length === 0) {
            return already ? prev : [greetingMsg];
          }

          if (prev.length === 1 && prev[0].role === "assistant") {
            const existingMsg: any = prev[0] || {};
            const existing = String(existingMsg?.content ?? "").trim();
            const existingMeta = existingMsg?.meta || {};
            const looksLikeEnglishGreeting = /^Hi,\s*(.+?)\s+here\./i.test(existing);
            const isGreeting = Boolean(existingMeta?.greeting) || looksLikeEnglishGreeting;
            if (isGreeting && existing !== String(greetingMsg.content || "").trim()) {
              return [greetingMsg];
            }
          }

          return prev;
        });

        if (!already) sessionStorage.setItem(greetKey, "1");
      })().catch(() => {});
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(tmr);
    };
  }, [companionName, getLocalizedGreeting, isEmbedded, startupIdentityResolved, userLanguageCode, userLanguagePreferenceKnown]);

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const midNow = String(memberIdRef.current || memberId || "").trim();
    const isVisitorNow = !midNow || isAnonMemberId(midNow);
    const msg = requestedMode === "intimate"
      ? isVisitorNow
        ? "Mature mode is available only to signed-in members. Visitors can use Intro and Mate modes."
        : "Mature is not available on your current plan. Please select the Upgrade button to change plans."
      : `The requested mode (${modeLabel}) is not available on your current plan. Please select the Upgrade button to change plans.`;

    setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
  }

  // Receive plan + companion from Wix postMessage
  useEffect(() => {
    // iOS/Safari can strip document.referrer, which can make strict origin checks flaky.
    // We "learn" the parent origin from the first MEMBER_PLAN payload we accept, then lock to it.
    let trustedParentOrigin: string | null = null;

    const looksLikeMemberPlanPayload = (d: any) => {
      return (
        !!d &&
        typeof d === "object" &&
        (d as any).type === "MEMBER_PLAN" &&
        typeof (d as any).brand === "string" &&
        typeof (d as any).avatar === "string"
      );
    };

    const isAllowedPostMessage = (origin: string, data: any) => {
      if (origin === window.location.origin) return true;
      if (trustedParentOrigin && origin === trustedParentOrigin) return true;

      if (isAllowedOrigin(origin)) {
        if (!trustedParentOrigin) trustedParentOrigin = origin;
        return true;
      }

      // Safari/iOS sometimes provides an empty referrer; accept the first valid payload and lock to that origin.
      if (!trustedParentOrigin && origin && origin.startsWith("https://") && looksLikeMemberPlanPayload(data)) {
        trustedParentOrigin = origin;
        return true;
      }

      return false;
    };

    function onMessage(event: MessageEvent) {
      let resolvedStartupName = "";
      // Wix HTML components sometimes deliver the payload as a JSON string.
      // Accept both object and string forms.
      let data: any = (event as any).data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          return;
        }
      }

      if (!isAllowedPostMessage(event.origin, data)) return;
      if (!data || typeof data !== "object" || (data as any).type !== "MEMBER_PLAN") return;

      data = mergeDirectCompanionHandoff(data, readDirectCompanionHandoffFromUrl());

      try {
        const cacheKey = getMemberPlanCacheKey();
        if (cacheKey) {
          const payloadText = encodeMemberPlanCachePayload(data);
          if (payloadText) {
            try { window.sessionStorage.setItem(cacheKey, payloadText); } catch (e) {}
            try { window.localStorage.setItem(cacheKey, payloadText); } catch (e) {}
          } else {
            try { window.sessionStorage.removeItem(cacheKey); } catch (e) {}
            try { window.localStorage.removeItem(cacheKey); } catch (e) {}
          }
        }
      } catch (e) {
        // ignore cache write failures
      }

      // loggedIn must come from Wix; do NOT infer from memberId.
      const incomingLoggedIn = typeof (data as any).loggedIn === "boolean" ? Boolean((data as any).loggedIn) : null;

      const hasMemberIdFieldForDowngradeGuard = "memberId" in (data as any) || "member_id" in (data as any);
      const incomingMemberIdForDowngradeGuard =
        typeof (data as any).memberId === "string"
          ? String((data as any).memberId).trim()
          : typeof (data as any).member_id === "string"
            ? String((data as any).member_id).trim()
            : "";
      const existingRealMemberIdForDowngradeGuard = String(memberIdRef.current || "").trim();
      const hasExistingRealMemberForDowngradeGuard = Boolean(existingRealMemberIdForDowngradeGuard) && !isAnonMemberId(existingRealMemberIdForDowngradeGuard);
      const incomingLooksVisitorForDowngradeGuard =
        incomingLoggedIn === false ||
        (hasMemberIdFieldForDowngradeGuard && (!incomingMemberIdForDowngradeGuard || isAnonMemberId(incomingMemberIdForDowngradeGuard)));

      // DulceMoon posts periodic MEMBER_PLAN payloads.  A stale visitor/Trial payload
      // can arrive after a real member payload and used to clear memberId/plan, which
      // hides Host Console and makes a paid Host look like Free Trial.  Never let a
      // visitor payload downgrade an already-established real member session.
      if (incomingLooksVisitorForDowngradeGuard && hasExistingRealMemberForDowngradeGuard) {
        return;
      }

      if (incomingLoggedIn !== null) {
        setLoggedIn(incomingLoggedIn);
      }

      const incomingPlanRaw =
        typeof (data as any).planName === "string"
          ? String((data as any).planName).trim()
          : typeof (data as any).plan_name === "string"
            ? String((data as any).plan_name).trim()
            : "";
      const incomingPlan = normalizePlanName(incomingPlanRaw);

      const hasExplicitRebrandingKeyField =
        "rebrandingKey" in (data as any) ||
        "rebranding_key" in (data as any) ||
        "RebrandingKey" in (data as any) ||
        "rebrandingkey" in (data as any);

      const incomingBrandName =
        typeof (data as any).brand === "string"
          ? normalizeRebrandingKeyValue((data as any).brand)
          : typeof (data as any).companyName === "string"
            ? normalizeRebrandingKeyValue((data as any).companyName)
            : typeof (data as any).company_name === "string"
              ? normalizeRebrandingKeyValue((data as any).company_name)
              : typeof (data as any).company === "string"
                ? normalizeRebrandingKeyValue((data as any).company)
                : "";

      // Optional white-label brand handoff from Wix.
      // - Elaralo site should send: { rebrandingKey: "" }
      // - Rebranding sites should send the full RebrandingKey (pipe-delimited).
      //
      // IMPORTANT: This must never alter STT/TTS start/stop code paths.
      let rawRebrandingKey = "";

      if (hasExplicitRebrandingKeyField) {
        rawRebrandingKey =
          typeof (data as any).rebrandingKey === "string"
            ? String((data as any).rebrandingKey)
            : typeof (data as any).rebranding_key === "string"
              ? String((data as any).rebranding_key)
              : typeof (data as any).rebrandingkey === "string"
                ? String((data as any).rebrandingkey)
                : typeof (data as any).RebrandingKey === "string"
                  ? String((data as any).RebrandingKey)
                  : "";
        rawRebrandingKey = normalizeRebrandingKeyValue(rawRebrandingKey);

        // Allow empty string to explicitly clear any previous rebranding state.
        setRebrandingKey(rawRebrandingKey);
      } else if ("rebranding" in (data as any)) {
        // Legacy support: some older Wix pages may still send { rebranding: "BrandName" }.
        rawRebrandingKey = typeof (data as any).rebranding === "string" ? normalizeRebrandingKeyValue((data as any).rebranding) : "";
        if (rawRebrandingKey) setRebrandingKey(rawRebrandingKey);
      }

      const rkParts = parseRebrandingKey(rawRebrandingKey);
      const payloadHasBrandIdentity =
        "rebrandingKey" in (data as any) ||
        "rebranding_key" in (data as any) ||
        "RebrandingKey" in (data as any) ||
        "rebrandingkey" in (data as any) ||
        "rebranding" in (data as any) ||
        "brand" in (data as any) ||
        "companyName" in (data as any) ||
        "company_name" in (data as any) ||
        "company" in (data as any);
      const effectiveIncomingBrandName = String(rkParts?.rebranding || (!hasExplicitRebrandingKeyField ? incomingBrandName : "") || "").trim();
      const rebrandSlugFromMessage = normalizeRebrandingSlug(effectiveIncomingBrandName);
      if (effectiveIncomingBrandName) {
        setPayloadBrandName(effectiveIncomingBrandName);
      } else if (payloadHasBrandIdentity) {
        setPayloadBrandName("");
      }

      const hasMemberIdField = "memberId" in (data as any) || "member_id" in (data as any);
      const incomingMemberId =
        typeof (data as any).memberId === "string"
          ? String((data as any).memberId).trim()
          : typeof (data as any).member_id === "string"
            ? String((data as any).member_id).trim()
            : "";
      const normalizedIncomingMemberId = incomingLoggedIn === false ? "" : incomingMemberId;
      if (hasMemberIdField) {
        setMemberId(normalizedIncomingMemberId);
      }
      const effectiveMemberId = incomingLoggedIn === false
        ? ""
        : hasMemberIdField
          ? normalizedIncomingMemberId
          : String(memberIdRef.current || "").trim();

      const hasHostMemberIdField = "hostMemberId" in (data as any) || "host_member_id" in (data as any);
      const incomingHostMemberId =
        typeof (data as any).hostMemberId === "string"
          ? String((data as any).hostMemberId).trim()
          : typeof (data as any).host_member_id === "string"
            ? String((data as any).host_member_id).trim()
            : "";
      const hasIsHostUserField = "isHostUser" in (data as any) || "is_host_user" in (data as any);
      const incomingIsHostUser = Boolean((data as any).isHostUser === true || (data as any).is_host_user === true);

      // Immediate Host Console eligibility from Wix MEMBER_PLAN. This state is
      // consumed only by Host Console gates; it does not change the existing
      // mapping-derived `isHost` used elsewhere.
      if (incomingLoggedIn === false) {
        setPayloadHostMemberId("");
        setPayloadIsHostUser(false);
      } else {
        if (hasHostMemberIdField || incomingIsHostUser) {
          setPayloadHostMemberId(incomingHostMemberId || (incomingIsHostUser ? effectiveMemberId : ""));
        }
        if (hasIsHostUserField) {
          const hostIdForCheck = incomingHostMemberId || effectiveMemberId;
          setPayloadIsHostUser(Boolean(incomingIsHostUser && effectiveMemberId && hostIdForCheck === effectiveMemberId));
        }
      }

      const hasDisplayNameField =
        "displayName" in (data as any) ||
        "display_name" in (data as any) ||
        "userName" in (data as any) ||
        "user_name" in (data as any) ||
        "username" in (data as any);
      const incomingDisplayName =
        typeof (data as any).displayName === "string"
          ? String((data as any).displayName).trim()
          : typeof (data as any).display_name === "string"
            ? String((data as any).display_name).trim()
            : typeof (data as any).userName === "string"
              ? String((data as any).userName).trim()
              : typeof (data as any).user_name === "string"
                ? String((data as any).user_name).trim()
                : typeof (data as any).username === "string"
                  ? String((data as any).username).trim()
                  : "";
      if (hasDisplayNameField) {
        setPayloadUserDisplayName(incomingLoggedIn === false ? "" : incomingDisplayName);
      }

      const incomingLanguageRaw =
        typeof (data as any).preferredLanguage === "string"
          ? String((data as any).preferredLanguage).trim()
          : typeof (data as any).preferred_language === "string"
            ? String((data as any).preferred_language).trim()
            : typeof (data as any).userPreferredLanguage === "string"
              ? String((data as any).userPreferredLanguage).trim()
              : typeof (data as any).user_preferred_language === "string"
                ? String((data as any).user_preferred_language).trim()
                : typeof (data as any).userLanguage === "string"
                  ? String((data as any).userLanguage).trim()
                  : typeof (data as any).user_language === "string"
                    ? String((data as any).user_language).trim()
                    : typeof (data as any).language === "string"
                      ? String((data as any).language).trim()
                      : typeof (data as any).locale === "string"
                        ? String((data as any).locale).trim()
                        : typeof (data as any).lang === "string"
                          ? String((data as any).lang).trim()
                          : "";
      const normalizedIncomingLanguage = normalizeLanguageTag(incomingLanguageRaw);
      if (normalizedIncomingLanguage) {
        setUserLanguageCode(normalizedIncomingLanguage);
        setUserLanguagePreferenceKnown(true);
      }

      // When RebrandingKey is present, use ElaraloPlanMap for capability gating
      // (Wix planName may be the rebrand site's plan names like "Supreme").
      const mappedPlanFromKey = normalizePlanName(String(rkParts?.elaraloPlanMap || ""));
      const hasEntitledPlan = Boolean(String(mappedPlanFromKey || incomingPlan || "").trim());
      const payloadHasPlanContext = Boolean(rawRebrandingKey) || Boolean(mappedPlanFromKey) || Boolean(incomingPlanRaw) || incomingLoggedIn === false;
      const treatAsVisitorForEntitlements = incomingLoggedIn === false || !effectiveMemberId || isAnonMemberId(effectiveMemberId);
      const effectivePlan: PlanName = treatAsVisitorForEntitlements
        ? "Trial"
        : hasEntitledPlan
          ? (mappedPlanFromKey || incomingPlan)
          : (payloadHasPlanContext ? "Trial" : (latestPlanNameRef.current || "Trial"));
      setPlanName(effectivePlan);

      // Display the rebranding site's plan label when provided (e.g., "Supreme"),
      // but only for logged-in members (Free Trial ignores plan labels by design).
      const planLabel = !treatAsVisitorForEntitlements ? String(rkParts?.plan || "").trim() : "";
      setPlanLabelOverride((prev) => {
        if (treatAsVisitorForEntitlements) return "";
        return planLabel || prev;
      });

      const incomingCompanion =
        typeof (data as any).companion === "string"
          ? String((data as any).companion).trim()
          : typeof (data as any).companionName === "string"
            ? String((data as any).companionName).trim()
            : typeof (data as any).companion_name === "string"
              ? String((data as any).companion_name).trim()
              : "";
      const incomingAvatarName =
        typeof (data as any).avatar === "string"
          ? String((data as any).avatar).trim()
          : typeof (data as any).avatarName === "string"
            ? String((data as any).avatarName).trim()
            : typeof (data as any).avatar_name === "string"
              ? String((data as any).avatar_name).trim()
              : "";
      const incomingCompanionKey =
        typeof (data as any).companionKey === "string"
          ? String((data as any).companionKey).trim()
          : typeof (data as any).companion_key === "string"
            ? String((data as any).companion_key).trim()
            : "";
      const incomingCompanionDisplayName =
        typeof (data as any).companionDisplayName === "string"
          ? String((data as any).companionDisplayName).trim()
          : typeof (data as any).companion_display_name === "string"
            ? String((data as any).companion_display_name).trim()
            : "";
      const incomingCompanionType = normalizeCompanionTypeHint(
        typeof (data as any).companionType === "string"
          ? String((data as any).companionType).trim()
          : typeof (data as any).companion_type === "string"
            ? String((data as any).companion_type).trim()
            : ""
      );
      const explicitIncomingMappingAvatar =
        typeof (data as any).mappingAvatar === "string"
          ? String((data as any).mappingAvatar).trim()
          : typeof (data as any).mapping_avatar === "string"
            ? String((data as any).mapping_avatar).trim()
            : "";
      const incomingHeadshotUrl =
        typeof (data as any).headshotUrl === "string"
          ? String((data as any).headshotUrl).trim()
          : typeof (data as any).headshot_url === "string"
            ? String((data as any).headshot_url).trim()
            : typeof (data as any).imageUrl === "string"
              ? String((data as any).imageUrl).trim()
              : typeof (data as any).image_url === "string"
                ? String((data as any).image_url).trim()
                : typeof (data as any).photoUrl === "string"
                  ? String((data as any).photoUrl).trim()
                  : typeof (data as any).photo_url === "string"
                    ? String((data as any).photo_url).trim()
                    : "";
      const resolvedCompanionKey = incomingCompanionKey || incomingCompanion || incomingAvatarName || "";
      const { baseKey } = splitCompanionKey(resolvedCompanionKey);

      if (resolvedCompanionKey) {
        setCompanionKeyRaw(resolvedCompanionKey);
        const parsed = parseCompanionMeta(baseKey || resolvedCompanionKey);
        const resolvedCompanionName = incomingCompanionDisplayName || parsed.first || incomingAvatarName || incomingCompanion || DEFAULT_COMPANION_NAME;
        resolvedStartupName = resolvedCompanionName;
        const resolvedCompanionMetaKey = parsed.key || resolvedCompanionKey;
        const filenameKeyLooksLikeAi = isAiCompanionFilenameKey(resolvedCompanionKey);
        const resolvedMappingAvatar =
          explicitIncomingMappingAvatar ||
          (filenameKeyLooksLikeAi ? (parsed.first || aiFirstNameFromKey(resolvedCompanionKey)) : "") ||
          incomingAvatarName ||
          incomingCompanion ||
          resolvedCompanionName;
        setCompanionKey(resolvedCompanionMetaKey);
        setCompanionName(resolvedCompanionName);
        setSelectedMappingAvatar(resolvedMappingAvatar);
        setSelectedCompanionType(incomingCompanionType);
        armStartupOverlay(resolvedCompanionName);

        // Keep session_state aligned with the selected companion so the backend can apply the correct persona.
        // avatar/mappingAvatar are SQL mapping identities; companionName remains the full companion key for AI filename cards.
        setSessionState((prev) => ({
          ...prev,
          companion: resolvedCompanionMetaKey,
          companionName: resolvedCompanionMetaKey,
          companion_name: resolvedCompanionMetaKey,
          avatar: resolvedMappingAvatar,
          mappingAvatar: resolvedMappingAvatar,
          mapping_avatar: resolvedMappingAvatar,
          companionType: incomingCompanionType,
          companion_type: incomingCompanionType,
        }));

        const avatarCandidates = [
          incomingHeadshotUrl,
          ...buildAvatarCandidates(baseKey || resolvedCompanionKey || resolvedCompanionName, rebrandSlugFromMessage),
        ].filter((url, index, arr) => Boolean(url) && arr.indexOf(url) === index);

        // If a selected companion already arrived with an API-served headshot, show it
        // immediately and do not let later static-app probe failures replace it with the logo.
        if (incomingHeadshotUrl) {
          setAvatarSrc(incomingHeadshotUrl);
        }

        pickFirstLoadableImage(avatarCandidates).then((picked) => {
          setAvatarSrc((prev) => {
            const current = String(prev || "").trim();
            const next = String(picked || "").trim();
            if (next && next !== DEFAULT_AVATAR) return next;
            if (incomingHeadshotUrl) return incomingHeadshotUrl;
            if (isCompanionImageUrl(current)) return prev;
            return next || current || DEFAULT_AVATAR;
          });
        });
      }

      // Brand-default starting mode:
      // - For DulceMoon (and any white-label that sends elaraloPlanMap), we start in the mode encoded in the key.
      // - Fallback: entitled plans default to Mature internally, Trial/visitors default to Mate internally.
      const incomingModePillRaw =
        typeof (data as any).modePill === "string"
          ? String((data as any).modePill)
          : typeof (data as any).mode_pill === "string"
            ? String((data as any).mode_pill)
            : typeof (data as any).modepill === "string"
              ? String((data as any).modepill)
              : "";

      const effectiveHasEntitledPlan = Boolean(String(effectivePlan || "").trim() && effectivePlan !== "Trial");
      const desiredStartModeRaw: Mode =
        modeFromModePill(incomingModePillRaw) ||
        modeFromElaraloPlanMap(rkParts?.elaraloPlanMap) ||
        (effectiveHasEntitledPlan ? "intimate" : "romantic");

      // Requirement: the *Elaralo* entitlement plan determines how many mode pills exist.
      // The Wix `modePill` selects the initially-active mode (if allowed), but does NOT change how many pills are shown.

      const nextAllowed = clampAllowedModesForIdentity(
        effectiveMemberId,
        allowedModesFromElaraloPlanMap(rkParts?.elaraloPlanMap, effectivePlan)
      );
      const desiredStartMode: Mode =
        nextAllowed.includes(desiredStartModeRaw) ? desiredStartModeRaw : fallbackModeForAllowedModes(nextAllowed);

      setAllowedModes(nextAllowed);

      const wixRequestedMode: Mode | null = modeFromModePill(incomingModePillRaw);

      // Wix can post MEMBER_PLAN more than once (init + periodic refresh). We must not continuously
      // override user-driven mode switches inside the chat. We only force-apply Wix modePill when:
      //   - this is the first MEMBER_PLAN we processed, OR
      //   - the plan context changed (new member/plan/rebrandingKey), OR
      //   - Wix actually changed the modePill value.
      const fp = `${incomingMemberId || ""}|${String(effectivePlan || "").trim()}|${normalizeRebrandingKeyValue(rawRebrandingKey)}`;
      const isPlanRefresh = fp !== wixLastFingerprintRef.current;
      wixLastFingerprintRef.current = fp;

      const wixModeChanged = Boolean(
        wixRequestedMode && wixRequestedMode !== wixLastRequestedModeRef.current
      );
      if (wixRequestedMode) {
        wixLastRequestedModeRef.current = wixRequestedMode;
      }

      const shouldForceWixMode = Boolean(
        wixRequestedMode &&
          nextAllowed.includes(wixRequestedMode) &&
          (!wixAppliedModeOnceRef.current || isPlanRefresh || wixModeChanged)
      );
      wixAppliedModeOnceRef.current = true;

      setSessionState((prev) => {
        let nextMode: Mode = prev.mode;

        // Force-apply Wix modePill only on init / plan refresh / Wix mode change.
        if (shouldForceWixMode) {
          nextMode = wixRequestedMode;
        } else {
          // Otherwise, preserve the previous mode if allowed; if not allowed, fall back.
          if (nextAllowed.includes(desiredStartMode) && (!nextAllowed.includes(nextMode) || nextMode === "friend")) {
            nextMode = desiredStartMode;
          } else if (!nextAllowed.includes(nextMode)) {
            nextMode = fallbackModeForAllowedModes(nextAllowed);
          }
        }

        if (nextMode === prev.mode && prev.pending_consent !== "intimate") return prev;
        return { ...prev, mode: nextMode, pending_consent: nextMode === "intimate" ? prev.pending_consent : null };
      });

      // Mark handoff ready so the first audio-only TTS can deterministically use the selected companion voice.
      setHandoffReady(true);
      markStartupIdentityResolved(resolvedStartupName);
    }

    window.addEventListener("message", onMessage);

    const directHandoff = directCompanionHandoff;
    if (directHandoff?.avatar) {
      try {
        window.setTimeout(() => window.postMessage(directHandoff, window.location.origin), 0);
      } catch (e) {
        // ignore direct handoff failures
      }
    }

    return () => window.removeEventListener("message", onMessage);
  }, [directCompanionHandoff, getMemberPlanCacheKey, markStartupIdentityResolved]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isEmbedded) return;
    if (startupIdentityResolved) return;

    try {
      const cacheKey = getMemberPlanCacheKey();
      const cachedRaw = String(window.sessionStorage.getItem(cacheKey) || window.localStorage.getItem(cacheKey) || "").trim();
      if (!cachedRaw) return;
      const cachedPayload = decodeMemberPlanCachePayload(cachedRaw);
      if (!cachedPayload || typeof cachedPayload !== "object" || (cachedPayload as any).type !== "MEMBER_PLAN") {
        try { window.sessionStorage.removeItem(cacheKey); } catch (e) {}
        try { window.localStorage.removeItem(cacheKey); } catch (e) {}
        return;
      }
      window.postMessage(cachedPayload, window.location.origin);
    } catch (e) {
      // ignore cache hydrate failures
    }
  }, [getMemberPlanCacheKey, isEmbedded, startupIdentityResolved]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isEmbedded) return;
    if (startupIdentityResolved) return;

    let cancelled = false;
    const startedAt = Date.now();

    const requestNow = (reason: string) => {
      if (cancelled || startupIdentityResolvedRef.current) return;
      requestLatestMemberPlanFromParent(reason, { force: true });
    };

    requestNow("bootstrap_init");
    const interval = window.setInterval(() => {
      if (cancelled || startupIdentityResolvedRef.current) return;
      if (Date.now() - startedAt > 15000) {
        try { window.clearInterval(interval); } catch (e) {}
        return;
      }
      requestNow("bootstrap_poll");
    }, 1000);

    const onFocus = () => requestNow("bootstrap_focus");
    const onPageShow = () => requestNow("bootstrap_pageshow");
    const onVisible = () => {
      try {
        if (document.visibilityState === "visible") requestNow("bootstrap_visible");
      } catch (e) {}
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      try { window.clearInterval(interval); } catch (e) {}
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isEmbedded, requestLatestMemberPlanFromParent, startupIdentityResolved]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isEmbedded) return;
    if (startupIdentityResolved) return;
    if (!API_BASE) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled || startupIdentityResolvedRef.current) return;

      const embedCtx = getEmbedContext();
      try {
        const params = new URLSearchParams();
        if (embedCtx.referrer) params.set("referrer", embedCtx.referrer);
        if (embedCtx.parentOrigin) params.set("parent_origin", embedCtx.parentOrigin);
        if (embedCtx.ancestorOrigins.length) params.set("ancestor_origins", JSON.stringify(embedCtx.ancestorOrigins));

        const brandHint = String(payloadBrandName || parseRebrandingKey(rebrandingKey || "")?.rebranding || rebranding || "").trim();
        if (brandHint && brandHint.toLowerCase() !== DEFAULT_COMPANY_NAME.toLowerCase()) {
          params.set("brand_hint", brandHint);
        }

        const res = await fetch(`${API_BASE}/mappings/bootstrap?${params.toString()}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const data = await res.json().catch(() => ({} as any));
        if (cancelled || startupIdentityResolvedRef.current) return;

        if (res.ok && data && (Boolean(data.ok) || Boolean(data.found)) && data.brand && data.avatar) {
          window.postMessage({
            type: "MEMBER_PLAN",
            loggedIn,
            planName: String(planName || "").trim(),
            memberId: String(memberIdRef.current || "").trim(),
            rebrandingKey: ("rebrandingKey" in (data || {}) || "rebranding_key" in (data || {}) || "RebrandingKey" in (data || {}))
              ? normalizeRebrandingKeyValue((data as any).rebrandingKey ?? (data as any).rebranding_key ?? (data as any).RebrandingKey)
              : normalizeRebrandingKeyValue((data as any).brand),
            rebranding: String(data.brand || "").trim(),
            brand: String(data.brand || "").trim(),
            avatar: String(data.avatar || "").trim(),
            companion: String(data.avatar || "").trim(),
            companionName: String(data.avatar || "").trim(),
          }, window.location.origin);
          return;
        }
      } catch (e) {
        // ignore bootstrap fallback failures
      }

      startupIdentityResolvedRef.current = true;
      setStartupIdentityResolved(true);
      startStartupOverlayCountdown();
    }, 1500);

    return () => {
      cancelled = true;
      try { window.clearTimeout(timer); } catch (e) {}
    };
  }, [API_BASE, getEmbedContext, isEmbedded, loggedIn, payloadBrandName, planName, rebranding, rebrandingKey, startStartupOverlayCountdown, startupIdentityResolved]);

  async function callChat(nextMessages: Msg[], stateToSend: SessionState): Promise<ChatApiResponse> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const wants_explicit = stateToSend.mode === "intimate";

// Ensure backend receives the selected companion so it can apply the correct persona.
// Without this, the backend may fall back to the default companion ("Elara") even when the UI shows another.
const companionForBackend =
  (companionKey || "").trim() ||
  (companionName || DEFAULT_COMPANION_NAME).trim() ||
  DEFAULT_COMPANION_NAME;


// NOTE:
	// - `rebranding` (legacy) is not guaranteed to be present in this build.
	// - Use RebrandingKey as the single source of truth for brand identity.
	const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || DEFAULT_COMPANY_NAME).trim();
const brandKey = safeBrandKey(rawBrand);

// For visitors (no Wix memberId), generate a stable anon id so we can track freeMinutes usage.
const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

// Viewer/User session username/display name for host readability (used in Host Console + summaries).
// Do NOT prompt here; this must be safe during normal chat.
const userDisplayNameForBackend = buildHostReadableViewerName(memberIdForBackend);

// If the user is entitled (has a real Wix memberId + active plan), strip the trial controls
// from the rebranding key so backend quota comes from the mapped Elaralo plan.

// `loggedIn` is only available when the Wix parent posts it.
// For white-label, keep the full rebrandingKey intact so backend can apply minutes/mode/links overrides.
const rebrandingKeyForBackend = normalizeRebrandingKeyValue(rebrandingKey);

    const stateToSendWithCompanion: SessionState = {
  ...stateToSend,
  companion: companionForBackend,
  // Backward/forward compatibility with any backend expecting different field names
  companionName: companionForBackend,
  companion_name: companionForBackend,
  // Brand/avatar are used by the backend for host override scoping and (optionally) TTS.
  brand: (companyName || "").trim(),
  avatar: (selectedMappingAvatar || companionName || "").trim(),
        mappingAvatar: (selectedMappingAvatar || companionName || "").trim(),
        mapping_avatar: (selectedMappingAvatar || companionName || "").trim(),
        companionType: selectedCompanionType,
        companion_type: selectedCompanionType,
        phonetic: companionPhonetic,
        mapping_phonetic: companionPhonetic,
        mappingPhonetic: companionPhonetic,
        companion_phonetic: companionPhonetic,
        companionPhonetic: companionPhonetic,

  // Member identity (from Wix)
  memberId: (memberIdForBackend || "").trim(),
  member_id: (memberIdForBackend || "").trim(),

  // Plan for entitlements (use mapped Elaralo plan when rebrandingKey provides one)
  planName: (planName || "").trim(),
  plan_name: (planName || "").trim(),

  // Optional display label (white-label plan name). Backend can use this for messaging only.
  planLabelOverride: (planLabelOverride || "").trim(),
  plan_label_override: (planLabelOverride || "").trim(),

  // White-label handoff: pass RebrandingKey to backend so it can override Upgrade/PayGo URLs, minutes, etc.
  rebrandingKey: (rebrandingKeyForBackend || "").trim(),
  rebranding_key: (rebrandingKeyForBackend || "").trim(),
  RebrandingKey: (rebrandingKeyForBackend || "").trim(),
  // Legacy support: backend may still look at "rebranding" if RebrandingKey is absent
  rebranding: (rebranding || "").trim(),

  // User session username/display name for chat identity awareness and Host Console readability. This is not necessarily the user's real name, stage name, or preferred persona name, and does not override identity facts in AI Guidelines.
  user_name: userDisplayNameForBackend,
  username: userDisplayNameForBackend,
  display_name: userDisplayNameForBackend,
  hostMemberId: String(mappedHostMemberId || "").trim(),
  host_member_id: String(mappedHostMemberId || "").trim(),
  isHostUser: isHost,
  is_host_user: isHost,
  loggedIn,
  logged_in: loggedIn,

  // Entitlement modes for backend context-mode automation.  The UI remains the
  // primary plan gate, but the backend needs the same list when it auto-detects
  // Mate/Mature context from conversation text.
  allowed_modes: allowedModes,
  allowedModes,

  translator_enabled: translatorEnabled,
  translation_enabled: translatorEnabled,
  translationEnabled: translatorEnabled,
  user_language_code: normalizeLanguageTag(userLanguageCode) || "en",
  userLanguageCode: normalizeLanguageTag(userLanguageCode) || "en",
  user_language_name: userLanguageName,
  userLanguageName: userLanguageName,
  user_language_preference_known: userLanguagePreferenceKnown,
  userLanguagePreferenceKnown: userLanguagePreferenceKnown,
  language_preference_known: userLanguagePreferenceKnown,
  languagePreferenceKnown: userLanguagePreferenceKnown,
  user_language_hint_code: normalizeLanguageTag(sttLanguageHintCode) || "en",
  userLanguageHintCode: normalizeLanguageTag(sttLanguageHintCode) || "en",
  display_language_code: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
  displayLanguageCode: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
  assistant_language_code: assistantConversationLanguageCode,
  assistantLanguageCode: assistantConversationLanguageCode,
  assistant_language_name: assistantConversationLanguageName,
  assistantLanguageName: assistantConversationLanguageName,
  assistant_speech_language_code: assistantSpeechLanguageCode,
  assistantSpeechLanguageCode: assistantSpeechLanguageCode,
  assistant_speech_language_name: assistantSpeechLanguageName,
  assistantSpeechLanguageName: assistantSpeechLanguageName,
  assistant_source_language_code: assistantSpeechLanguageCode,
  assistantSourceLanguageCode: assistantSpeechLanguageCode,
  assistant_source_language_name: assistantSpeechLanguageName,
  assistantSourceLanguageName: assistantSpeechLanguageName,
};

    const trimmedForChat = trimMessagesForChat(nextMessages);

    // Build/extend in-session conversation digests when older turns are trimmed.
    // These are kept in session_state and injected server-side so model switches remain coherent.
    const droppedCount = Math.max(0, nextMessages.length - trimmedForChat.length);
    const prevDroppedCountRaw =
      (stateToSendWithCompanion as any).summary_dropped_count ??
      (stateToSendWithCompanion as any).summaryDroppedCount ??
      0;
    const prevDroppedCount = Math.max(
      0,
      Math.min(Number(prevDroppedCountRaw || 0) || 0, nextMessages.length)
    );

    let stateForBackend: SessionState = stateToSendWithCompanion;

    if (droppedCount > prevDroppedCount) {
      const newlyDropped = nextMessages.slice(prevDroppedCount, droppedCount);
      const digest = buildDigestFromDroppedMessages(newlyDropped);

      const existing =
        (stateToSendWithCompanion as any).conversation_summaries ??
        (stateToSendWithCompanion as any).conversationSummaries ??
        (stateToSendWithCompanion as any).chat_summaries ??
        (stateToSendWithCompanion as any).chatSummaries ??
        (stateToSendWithCompanion as any).summaries ??
        (stateToSendWithCompanion as any).summary_chunks ??
        (stateToSendWithCompanion as any).summaryChunks ??
        [];

      const list: string[] = Array.isArray(existing)
        ? existing.slice().map((x: any) => String(x || ""))
        : [];

      if (digest) {
        if (!list.length || list[list.length - 1] !== digest) list.push(digest);
      }

      while (list.length > MAX_IN_SESSION_SUMMARY_CHUNKS) list.shift();

      stateForBackend = {
        ...(stateToSendWithCompanion as any),
        conversation_summaries: list,
        conversationSummaries: list,
        summary_dropped_count: droppedCount,
        summaryDroppedCount: droppedCount,
      };
    } else if (droppedCount === 0 && prevDroppedCount > 0) {
      // Likely a reset/clear; avoid leaking prior context into a new conversation.
      stateForBackend = {
        ...(stateToSendWithCompanion as any),
        conversation_summaries: [],
        conversationSummaries: [],
        summary_dropped_count: 0,
        summaryDroppedCount: 0,
      };
    }

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit,
        session_state: stateForBackend,
        messages: trimmedForChat.map((m) => serializeMessageForBackend(m)),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatApiResponse;
  }

  async function callSaveChatSummary(nextMessages: Msg[], stateToSend: SessionState, reason: string = "manual_save"): Promise<{ ok: boolean; summary?: string; error_code?: string; error?: string; key?: string; saved_at?: string }> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const companionForBackend =
      (companionKey || "").trim() ||
      (companionName || DEFAULT_COMPANION_NAME).trim() ||
      DEFAULT_COMPANION_NAME;

    const effectivePlanForBackend = String(planName || "").trim() || "Trial";

    const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || DEFAULT_COMPANY_NAME).trim();
    const brandKey = safeBrandKey(rawBrand);

    // For visitors (no Wix memberId), generate a stable anon id so we can track freeMinutes usage.
    const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

    const rebrandingKeyForBackend = normalizeRebrandingKeyValue(rebrandingKey);

    const userDisplayNameForBackend = buildHostReadableViewerName(memberIdForBackend);

    const deliveredContentFilesForSummary = extractDeliveredContentFileNamesFromMessages(nextMessages);

    const stateToSendWithCompanion: SessionState = {
      ...stateToSend,
      companion: companionForBackend,
      companionName: companionForBackend,
      companion_name: companionForBackend,
      brand: (companyName || "").trim(),
      avatar: (selectedMappingAvatar || companionName || "").trim(),
        mappingAvatar: (selectedMappingAvatar || companionName || "").trim(),
        mapping_avatar: (selectedMappingAvatar || companionName || "").trim(),
        companionType: selectedCompanionType,
        companion_type: selectedCompanionType,
        phonetic: companionPhonetic,
        mapping_phonetic: companionPhonetic,
        mappingPhonetic: companionPhonetic,
        companion_phonetic: companionPhonetic,
        companionPhonetic: companionPhonetic,
      planName: effectivePlanForBackend,
      plan_name: effectivePlanForBackend,
      plan: effectivePlanForBackend,
      planLabelOverride: (planLabelOverride || "").trim(),
      plan_label_override: (planLabelOverride || "").trim(),
      memberId: (memberIdForBackend || "").trim(),
      member_id: (memberIdForBackend || "").trim(),
      rebrandingKey: (rebrandingKeyForBackend || "").trim(),
      rebranding_key: (rebrandingKeyForBackend || "").trim(),
      RebrandingKey: (rebrandingKeyForBackend || "").trim(),
      rebranding: (rebranding || "").trim(),
      user_name: userDisplayNameForBackend,
      username: userDisplayNameForBackend,
      display_name: userDisplayNameForBackend,
      hostMemberId: String(mappedHostMemberId || "").trim(),
      host_member_id: String(mappedHostMemberId || "").trim(),
      isHostUser: isHost,
      is_host_user: isHost,
      loggedIn,
      logged_in: loggedIn,
      translator_enabled: translatorEnabled,
      translation_enabled: translatorEnabled,
      translationEnabled: translatorEnabled,
      user_language_code: normalizeLanguageTag(userLanguageCode) || "en",
      userLanguageCode: normalizeLanguageTag(userLanguageCode) || "en",
      user_language_name: userLanguageName,
      userLanguageName: userLanguageName,
      user_language_preference_known: userLanguagePreferenceKnown,
      userLanguagePreferenceKnown: userLanguagePreferenceKnown,
      language_preference_known: userLanguagePreferenceKnown,
      languagePreferenceKnown: userLanguagePreferenceKnown,
      user_language_hint_code: normalizeLanguageTag(sttLanguageHintCode) || "en",
      userLanguageHintCode: normalizeLanguageTag(sttLanguageHintCode) || "en",
      display_language_code: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
      displayLanguageCode: translatorEnabled ? (normalizeLanguageTag(userLanguageCode) || "en") : "en",
      assistant_language_code: assistantConversationLanguageCode,
      assistantLanguageCode: assistantConversationLanguageCode,
      assistant_language_name: assistantConversationLanguageName,
      assistantLanguageName: assistantConversationLanguageName,
      assistant_speech_language_code: assistantSpeechLanguageCode,
      assistantSpeechLanguageCode: assistantSpeechLanguageCode,
      assistant_speech_language_name: assistantSpeechLanguageName,
      assistantSpeechLanguageName: assistantSpeechLanguageName,
      assistant_source_language_code: assistantSpeechLanguageCode,
      assistantSourceLanguageCode: assistantSpeechLanguageCode,
      assistant_source_language_name: assistantSpeechLanguageName,
      assistantSourceLanguageName: assistantSpeechLanguageName,
      delivered_content_files: deliveredContentFilesForSummary,
      deliveredContentFiles: deliveredContentFilesForSummary,
    };

    const res = await fetch(`${API_BASE}/chat/save-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        reason: (reason || "manual_save").trim(),
        session_state: stateToSendWithCompanion,
        delivered_content_files: deliveredContentFilesForSummary,
        deliveredContentFiles: deliveredContentFilesForSummary,
        messages: nextMessages.map((m) => serializeMessageForBackend(m, { forSummary: true })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as any;
  }

  // ---------------------------------------------------------------------
// Attachments (Azure Blob via backend)
// - Only image/* uploads are supported (rendered as image previews).
// - Attachments are DISABLED during Shared Live (LegacyStream sessionActive).
// ---------------------------------------------------------------------
const uploadsDisabled = Boolean(sessionActive && sessionKind === "stream");

const uploadAttachment = useCallback(
  async (file: File): Promise<UploadedAttachment> => {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const brand = String(companyName || "").trim();
    const avatar = String(companionName || "").trim();
    const member = String(memberIdForLiveChat || "").trim();

    if (!brand || !avatar) throw new Error("Missing brand/avatar for upload");
    if (!file) throw new Error("No file selected");

    const filename = String((file as any).name || "upload").trim() || "upload";
    const contentType =
      String((file as any).type || "").trim() || "application/octet-stream";
    // Full file support (Option B): allow any file type.

    const res = await fetch(`${API_BASE}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Filename": filename,
        "X-Brand": brand,
        "X-Avatar": avatar,
        "X-Member-Id": member,
      },
      body: file,
    });

    const rawText = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      json = null;
    }

    if (!res.ok) {
      const detail = String(json?.detail || rawText || "").trim();
      throw new Error(detail || `Upload failed (${res.status})`);
    }

    const url = String(json?.url || "").trim();
    if (!url) throw new Error("Upload succeeded but no URL was returned");

    return {
      url,
      name: String(json?.name || filename || "attachment"),
      size: Number(json?.size || (file as any).size || 0),
      contentType: String(json?.contentType || contentType || "application/octet-stream"),
      container: json?.container,
      blobName: json?.blobName,
    };
  },
  [API_BASE, companyName, companionName, memberIdForLiveChat]
);

const openUploadPicker = useCallback(() => {
  if (uploadsDisabled) {
    try { window.alert("Attachments are disabled during Shared Live streaming."); } catch (e) {}
    return;
  }
  if (uploadingAttachment) return;
  try {
    uploadInputRef.current?.click();
  } catch (e) {
    // ignore
  }
}, [uploadsDisabled, uploadingAttachment]);

const onAttachmentSelected = useCallback(
  async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const input = ev.target;
    const file = input?.files && input.files.length ? input.files[0] : null;

    // Allow selecting the same file twice in a row.
    try { input.value = ""; } catch (e) {}

    if (!file) return;

    if (uploadsDisabled) {
      try { window.alert("Attachments are disabled during Shared Live streaming."); } catch (e) {}
      return;
    }

    setUploadError("");
    setUploadingAttachment(true);

    try {
      const uploaded = await uploadAttachment(file);
      setPendingAttachment(uploaded);
    } catch (e: any) {
      setPendingAttachment(null);
      setUploadError(String(e?.message || "Upload failed"));
    } finally {
      setUploadingAttachment(false);
    }
  },
  [uploadsDisabled, uploadAttachment]
);

const clearPendingAttachment = useCallback(() => {
  setPendingAttachment(null);
  setUploadError("");
}, []);

// This is the mode that drives the UI highlight:
  // - If backend is asking for intimate consent, keep intimate pill highlighted
  const effectiveActiveMode: Mode =
    sessionState.pending_consent === "intimate" ? "intimate" : sessionState.mode;

  const showConsentOverlay =
    sessionState.pending_consent === "intimate" || chatStatus === "explicit_blocked";

  function setModeFromPill(m: Mode) {
    if (!allowedModes.includes(m)) {
      showUpgradeMessage(m);
      return;
    }

    // Selecting Mature requires explicit consent; trigger the consent overlay if not already consented.
    if (m === "intimate" && !sessionState.explicit_consented) {
      setChatStatus("explicit_blocked");
    }

    setSessionState((prev) => {
      // If switching to intimate and consent is not yet granted, keep pending consent active so the overlay is shown.
      const nextPending =
        m === "intimate" && !prev.explicit_consented ? "intimate" : null;
      return { ...prev, mode: m, pending_consent: nextPending };
    });

    setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` }]);
  }


const isLiveSessionNoticeText = (s: string) => {
  const t = String(s || "").toLowerCase();
  // Back-compat: earlier builds used "Streaming live right now..."
  if (t.includes("streaming live right now") && t.includes("will respond")) return true;
  if (t.includes("in a live session") && t.includes("will respond")) return true;
  return false;
};

const filterMessagesForBackend = (msgs: Msg[]): Msg[] => {
  // Never send our local "live session" notice bubbles to the backend.
  // They are UI-only and can confuse the model if included as conversation context.
  return (msgs || []).filter((m) => {
    if (!m) return false;
    if (m.role === "assistant" && isLiveSessionNoticeText(String(m.content || ""))) return false;

    // Shared in-stream live chat: never include any live chat lines in /chat context.
    // Live stream chat is human-to-human only; AI must ignore it.
    const meta: any = (m as any).meta;
    if (meta?.liveChat === true) return false;
    return true;
  });
};

  
async function send(textOverride?: string, stateOverride?: Partial<SessionState>) {
    if (loading) return;

    // Attachments are uploaded ahead of time (pendingAttachment holds the SAS URL).
    // Allow send() when either text OR an attachment is present.
    const hasAttachment = Boolean(pendingAttachment);
    const rawText = (textOverride ?? input).trim();

    if (uploadingAttachment) return;
    if (!rawText && !hasAttachment) return;

	    // Hard rule: no attachments during Live Stream sessions.
	    if (sessionKind === "stream" && (uploadsDisabled || hostInStreamUi || viewerInStreamUi) && hasAttachment) {
	      try { window.alert("Attachments are disabled during Shared Live streaming."); } catch (e) {}
	      return;
	    }

    // If the user clears messages mid-flight, we "invalidate" any in-progress send()
    // so the assistant reply doesn't append into a cleared chat.
    const epochAtStart = clearEpochRef.current;

    // detect mode switch from prompt text
    const { mode: detectedMode, cleaned } = detectModeSwitchAndClean(rawText);

    // Plan-gate mode if user is attempting to switch
    if (detectedMode && !allowedModes.includes(detectedMode)) {
      showUpgradeMessage(detectedMode);
      setInput("");
      return;
    }

    // If the user message is ONLY a mode switch token, apply locally and don't call backend
    // e.g. "[mode:romantic]" by itself
    if (detectedMode && cleaned.length === 0) {
      if (detectedMode === "intimate" && !sessionState.explicit_consented) {
        setChatStatus("explicit_blocked");
        setSessionState((prev) => ({ ...prev, mode: "intimate", pending_consent: "intimate" }));
        setInput("");
        return;
      }
      setSessionState((prev) => ({ ...prev, mode: detectedMode, pending_consent: null }));
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Mode set to: ${MODE_LABELS[detectedMode]}` },
      ]);
      setInput("");
      return;
    }

    // Apply mode locally (so pill highlights immediately), but still send message.
    // If detectedMode is intimate, keep/trigger pending overlay on response.
    let nextState: SessionState = sessionState;
    if (detectedMode) {
      // Trigger/clear the pending consent overlay when switching modes via text.
      const nextPending =
        detectedMode === "intimate"
          ? sessionState.explicit_consented
            ? null
            : "intimate"
          : null;

      nextState = { ...sessionState, mode: detectedMode, pending_consent: nextPending };

      // Keep UI status aligned with the pending consent state.
      if (detectedMode === "intimate" && !sessionState.explicit_consented) {
        setChatStatus("explicit_blocked");
      } else if (detectedMode !== "intimate") {
        setChatStatus("safe");
      }

      setSessionState(nextState);
    }

    // Build user message content:
    // If a [mode:*] token was present, we remove it from content (cleaned) to keep chat natural.
    
const outgoingText = (detectedMode ? cleaned : rawText).trim();
    // If the user sends an attachment without text, still create a stable message for the backend/UI.
    const finalUserContent = outgoingText || (hasAttachment ? "Sent an attachment." : "");
    const turnClientId =
      (crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Build the user message.

    // Build the user message. During LegacyStream live sessions, this may also be
    // broadcast to the shared in-stream chat (without calling /chat).
    
let userMsg: Msg = {
      role: "user",
      content: finalUserContent,
      meta: { clientTurnId: turnClientId },
    };
    if (translatorEnabled && finalUserContent) {
      userMsg = applyTranslationMetaToMsg(
        userMsg,
        {
          displayText: finalUserContent,
          nativeText: finalUserContent,
          englishText: "",
          userLanguageCode: userLanguageCode,
          userLanguageName: userLanguageName,
        },
        finalUserContent,
      );
    }
    if (pendingAttachment) {
      userMsg = {
        ...userMsg,
        meta: { ...(userMsg as any).meta, attachment: pendingAttachment },
      };
    }
    const nextMessages: Msg[] = [...messages, userMsg];


// ---------------------------------------------------------------------
// Live Stream rule (LegacyStream):
// As soon as the HOST hits Play, LegacyStream sessionActive becomes true.
// While sessionActive is true, the AI companion must NOT generate responses.
//
// Behavior:
//   - Everyone: we queue the user's message locally (no /chat call).
//   - Visitors/members NOT currently inside the live stream session (no stream iframe open):
//       show a deterministic notice message.
//   - Members currently inside the live stream session:
//       allow them to type freely (no notice), but still queue messages.
//   - When the host stops streaming (sessionActive -> false): flush queued messages.
// ---------------------------------------------------------------------
let streamSessionActive = Boolean(sessionActive);
  // Whether THIS user is currently inside the shared in-stream experience.
  // (Important: this must NOT depend on the current UI mode selection; users can switch modes
  // and must still remain blocked from AI while the host is live until the stream ends.)
  const userInStreamSession = sessionKind === "conference" ? conferenceJoinedRef.current : joinedStreamRef.current;

// Avoid race with the polling loop:
// right before deciding to call /chat, do a one-off status check.
// This ensures the moment the Host hits Play (sessionActive flips) we immediately gate messages.
if (!streamSessionActive && API_BASE && companyName && companionName) {
  try {
    const url = new URL(`${API_BASE}/stream/livekit/status`);
    url.searchParams.set("brand", companyName);
    url.searchParams.set("avatar", companionName);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      const active = Boolean(data?.sessionActive);
      const hostId = String(data?.hostMemberId || "").trim();

      // Keep UI state in sync (poller will also keep updating).
      if (active !== Boolean(sessionActive)) setSessionActive(active);
      if (hostId && hostId !== livekitHostMemberId) setLivekitHostMemberId(hostId);

      streamSessionActive = active;
    }
  } catch (e) {
    // ignore
  }
}

if (streamSessionActive) {
  const who = (companionName || "This companion").trim() || "This companion";
  const sessionLabel = sessionKind === "conference" ? "private session" : "live stream";
  const notice = `${who} is in a ${sessionLabel} now but will respond once the ${sessionLabel} concludes.`;

  // In-stream members (host + joined viewers): this is a *shared live chat*.
  // Do NOT queue these messages for AI and do NOT send them to /chat later.
  if (userInStreamSession) {
    const clientMsgId =
      (crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Mark this message as a live-chat line (used for dedupe + UI labeling).
    const senderRole = isHost ? "host" : "viewer";
    const senderName =
      senderRole === "host"
        ? (String(companionName || "Host").trim() || "Host")
        : (String(preferredViewerDisplayName || "").trim() ||
           (memberIdForLiveChat ? `Viewer-${String(memberIdForLiveChat).slice(-4)}` : "Viewer"));

    userMsg = {
      ...userMsg,
      meta: {
        liveChat: true,
        senderId: String(memberIdForLiveChat || "").trim(),
        senderRole,
        name: senderName,
        // IMPORTANT: never include any in-stream live chat lines in AI context
        includeInAiContext: false,
        clientMsgId,
      },
    };

    // Update the message list to reference the updated object.
    try {
      nextMessages[nextMessages.length - 1] = userMsg;
    } catch (e) {
      // ignore
    }

    // Prevent echo duplication when the server broadcasts the same message back to us.
    rememberLiveChatId(clientMsgId);

    // Fire-and-forget: WS send (HTTP fallback inside helper).
    void sendLiveChatMessage(outgoingText, clientMsgId);

    // In-session members see their message immediately; no "live session" notice.
    setMessages(nextMessages);
    setInput("");
    clearPendingAttachment();
    return;
  }

  // Out-of-session visitors/members: show a deterministic notice and queue their message so
  // the AI can respond once the host stops streaming.
  // (These users are NOT in the shared live chat.)
  if (!streamPreSessionHistoryRef.current) {
    streamPreSessionHistoryRef.current = filterMessagesForBackend(messages);
  }

  const queuedState: SessionState = { ...nextState, ...(stateOverride || {}) };
  const noticeIndex = nextMessages.length;
  streamDeferredQueueRef.current.push({
    text: outgoingText,
    state: queuedState,
    queuedAt: Date.now(),
    noticeIndex,
    clientTurnId: turnClientId,
  });

  setMessages([...nextMessages, { role: "assistant", content: notice }]);
  setInput("");
  return;
}

// If speech-to-text "hands-free" mode is enabled, pause recognition while we send
    // and while the avatar speaks. We'll auto-resume after speaking finishes.
    const resumeSttAfter = sttEnabledRef.current;
    let resumeScheduled = false;
    if (resumeSttAfter) {
      pauseSpeechToText();

      // Defensive: clear any in-progress transcript to avoid accidental duplicate sends.
      sttFinalRef.current = "";
      sttInterimRef.current = "";
    }

    setMessages(nextMessages);
    setInput("");
    clearPendingAttachment();
    setLoading(true);

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      const data = await callChat(filterMessagesForBackend(nextMessages), sendState);

      // If the user hit "Clear Messages" while we were waiting on the response,
      // ignore this result and do not append it to a cleared chat.
      if (epochAtStart !== clearEpochRef.current) return;

      // status from backend (safe/explicit_blocked/explicit_allowed)
      if (data.mode === "safe" || data.mode === "explicit_blocked" || data.mode === "explicit_allowed") {
        setChatStatus(data.mode);
        if (data.mode === "explicit_allowed") {
          applyIntimateConsentForMember("chat_response");
        }
      }

      // Some backends return camelCase "sessionState" instead of snake_case "session_state"
      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      // Normalize & apply server session state WITHOUT using data.mode as pill mode
      if (serverSessionState) {
        syncLanguagePreferenceFromBackend(serverSessionState);
        setSessionState((prev) => {
          const merged: SessionState = { ...(prev as any), ...(serverSessionState as any) };

          // If backend says blocked, keep pill as intimate AND set pending
          if (data.mode === "explicit_blocked") {
            merged.mode = "intimate";
            merged.pending_consent = "intimate";
          }

          // If backend says allowed, clear pending (and keep mode whatever backend returned in session state)
          if (data.mode === "explicit_allowed" && merged.pending_consent) {
            merged.pending_consent = null;
          }

          // If the backend sent a mode (in session state OR top-level), normalize it so Mate always highlights
          const backendMode = normalizeMode((serverSessionState as any)?.mode ?? (data as any)?.mode);
          if (backendMode && data.mode !== "explicit_blocked") {
            merged.mode = backendMode;
          }

          // If we are not in intimate, never keep the intimate pending flag (prevents the Intimate pill from "sticking")
          if (merged.mode !== "intimate" && merged.pending_consent === "intimate") {
            merged.pending_consent = null;
          }

          return merged;
        });
      } else {
        // If blocked but session_state missing, still reflect pending
        if (data.mode === "explicit_blocked") {
          setSessionState((prev) => ({ ...prev, mode: "intimate", pending_consent: "intimate" }));
        }

        // If allowed but session_state missing, clear pending and mark consented
        if (data.mode === "explicit_allowed") {
          setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: true }));
        }

        // Fallback: if backend returned a pill mode at top-level, apply it
        const backendMode = normalizeMode((data as any)?.mode);
        if (backendMode && data.mode !== "explicit_blocked") {
          setSessionState((prev) => ({
            ...prev,
            mode: backendMode,
            pending_consent: backendMode === "intimate" ? prev.pending_consent : null,
          }));
        }
      }

      // Speak the assistant reply (if Live Avatar is connected).
      // When Live Avatar is active, we delay the assistant's text from appearing until
      // we are about to trigger the avatar speech.
      const replyText = String(data.reply || "");
      const displayReplyText = String(
        (data as any).display_reply ?? (data as any).displayReply ?? replyText ?? ""
      );
      const turnTranslation: any = (data as any).turn_translation ?? (data as any).turnTranslation ?? {};
      const userTurnTranslation: any =
        (turnTranslation && typeof turnTranslation === "object" ? (turnTranslation as any).user : null) || null;
      const replyTurnTranslation: any =
        (turnTranslation && typeof turnTranslation === "object" ? (turnTranslation as any).reply : null) ||
        (data as any).reply_translation ||
        (data as any).replyTranslation ||
        null;
      const contentMsgs = buildContentAssistantMsgs((data as any).content);
      applyUserTurnTranslationByClientId(turnClientId, userTurnTranslation, finalUserContent);
      let assistantCommitted = false;
      const commitAssistantMessage = () => {
        if (assistantCommitted) return;
        assistantCommitted = true;

        const toAdd: Msg[] = [];
        let remainingContentMsgs = contentMsgs;
        const assistantReplyMsg = buildAssistantTurnMsg(displayReplyText || replyText, replyTurnTranslation, "ai");
        if (assistantReplyMsg) {
          const firstContent = remainingContentMsgs[0];
          const firstMeta: any = (firstContent as any)?.meta || {};
          const sameShortDeliveryText =
            normalizeShortAssistantDeliveryText(firstContent?.content) &&
            normalizeShortAssistantDeliveryText(firstContent?.content) === normalizeShortAssistantDeliveryText(assistantReplyMsg.content);

          // Requested Human Companion photos already have a normal assistant reply
          // ("Here's one.").  Merge the attachment into that same turn instead of
          // rendering a duplicate "Here's one." line before the image.
          if (firstContent && isRequestedHumanPhotoDelivery(firstMeta) && sameShortDeliveryText) {
            const mergedMeta = {
              ...(assistantReplyMsg as any).meta,
              attachment: firstMeta.attachment,
              contentDelivery: firstMeta.contentDelivery,
            };
            toAdd.push({ ...assistantReplyMsg, meta: mergedMeta });
            remainingContentMsgs = remainingContentMsgs.slice(1);
          } else {
            toAdd.push(assistantReplyMsg);
          }
        }
        if (remainingContentMsgs.length) {
          toAdd.push(...remainingContentMsgs);
        }
        if (!toAdd.length) return;

        setMessages((prev) => [...prev, ...toAdd]);
      };

      // Guard against STT feedback: ignore any recognition results until after the avatar finishes speaking.
      // (We also keep STT paused during speak; this is an extra safety net.)
      const estimateSpeechMs = (text: string) => {
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const wpm = 160;
        const baseMs = (words / wpm) * 60_000;
        const punctPausesMs = (text.match(/[.!?]/g) || []).length * 250;
        return Math.min(60_000, Math.max(1_200, Math.round(baseMs + punctPausesMs)));
      };
      const estimatedSpeechMs = estimateSpeechMs(replyText);

      const hooks: SpeakAssistantHooks = {
        onWillSpeak: () => {
          // We'll treat "speaking" the same whether it's Live Avatar or local audio-only.
          if (!assistantCommitted) {
            commitAssistantMessage();
            assistantCommitted = true;
          }

          // Block STT from capturing the assistant speech.
          if (sttEnabledRef.current) {
            const now = Date.now();
            const ignoreMs = estimatedSpeechMs + 1200;
            sttIgnoreUntilRef.current = Math.max(sttIgnoreUntilRef.current || 0, now + ignoreMs);
          }
        },
        onDidNotSpeak: () => {
          // If we can't speak, still show the assistant message immediately.
          if (!assistantCommitted) {
            commitAssistantMessage();
            assistantCommitted = true;
          }
        },
      };

      const safeCompanionKey = resolveCompanionForBackend({ companionKey, companionName });

      // Prefer the DB-mapped ElevenLabs voice when present (fixes Dulce voice fallback).
      const voiceId = ((companionMapping?.elevenVoiceId || "").trim() || getElevenVoiceIdForAvatar(safeCompanionKey));

      const canLiveAvatarSpeak =
        avatarStatus === "connected" && !!didAvatarMedia && !!didAgentMgrRef.current;

      // Audio-only TTS is only played in hands-free STT mode (mic button enabled),
      // when Live Avatar is NOT speaking.
      const shouldUseLocalTts = !canLiveAvatarSpeak && sttEnabledRef.current;

      const hasAssistantReply = Boolean(replyText.trim());

      const speakPromise = (hasAssistantReply && canLiveAvatarSpeak
        ? speakAssistantReply(replyText, hooks)
        : hasAssistantReply && shouldUseLocalTts
          ? speakLocalTtsReply(replyText, voiceId, hooks)
          : (hooks.onDidNotSpeak(), Promise.resolve())
      ).catch(() => {
        // If something goes wrong, just fall back to showing text.
        hooks.onDidNotSpeak();
      });


      // If STT is enabled, resume listening only after the avatar finishes speaking.
      if (resumeSttAfter) {
        resumeScheduled = true;
        speakPromise.finally(() => {
          if (sttEnabledRef.current) resumeSpeechToText();
        });
      }
    } catch (err: any) {
      if (epochAtStart !== clearEpochRef.current) return;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err?.message ?? "Unknown error"}` },
      ]);
    } finally {
      setLoading(false);
      if (resumeSttAfter && !resumeScheduled) {
        // No speech was triggered (e.g., request failed). Resume immediately.
        if (sttEnabledRef.current) resumeSpeechToText();
      }
    }
  }

  // Keep a ref to the latest send() callback so STT handlers don't close over stale state.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // If STT auto-send fires while loading=true, we queue it and flush once loading clears.
  const sttDeferredQueueRef = useRef<string[]>([]);
  useEffect(() => {
    if (loading) return;
    if (!sttDeferredQueueRef.current.length) return;
    const next = sttDeferredQueueRef.current.shift();
    if (next) void sendRef.current(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);


// ---------------------------------------------------------------------
// Flush queued viewer/host messages once the host stops streaming.
// This keeps the "no AI responses while live" rule, while still responding later.
// ---------------------------------------------------------------------
const flushQueuedStreamMessages = useCallback(async () => {
  if (streamDeferredFlushInFlightRef.current) return;
  if (!streamDeferredQueueRef.current.length) return;

  // If the user clears messages mid-flight, we invalidate any in-progress flush.
  const epochAtStart = clearEpochRef.current;

  streamDeferredFlushInFlightRef.current = true;
  setLoading(true);

  try {
    // Start from the chat history snapshot taken when the stream session started.
    // Fall back to current messages filtered (should be rare).
    let history: Msg[] = streamPreSessionHistoryRef.current
      ? [...streamPreSessionHistoryRef.current]
      : filterMessagesForBackend(messagesRef.current || []);

    // Use the latest session state at flush time, then allow server updates to merge in.
    let workingState: SessionState = { ...(sessionStateRef.current as any) };

    // Process in FIFO order.
    while (streamDeferredQueueRef.current.length) {
      if (epochAtStart !== clearEpochRef.current) return;

      const item = streamDeferredQueueRef.current[0];
      let userMsg: Msg = {
        role: "user",
        content: String(item?.text || "").trim(),
        meta: { clientTurnId: String((item as any)?.clientTurnId || "").trim() },
      };
      if (translatorEnabled && userMsg.content) {
        userMsg = applyTranslationMetaToMsg(
          userMsg,
          {
            displayText: userMsg.content,
            nativeText: userMsg.content,
            englishText: "",
            userLanguageCode: userLanguageCode,
            userLanguageName: userLanguageName,
          },
          userMsg.content,
        );
      }
      if (!userMsg.content) {
        streamDeferredQueueRef.current.shift();
        continue;
      }

      const callMsgs: Msg[] = [...history, userMsg];

      const data = await callChat(callMsgs, item?.state ? (item.state as any) : (workingState as any));

      if (epochAtStart !== clearEpochRef.current) return;

      // status from backend (safe/explicit_blocked/explicit_allowed)
      if (data.mode === "safe" || data.mode === "explicit_blocked" || data.mode === "explicit_allowed") {
        setChatStatus(data.mode);
      }

      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      if (serverSessionState) {
        syncLanguagePreferenceFromBackend(serverSessionState);
        const merged: SessionState = { ...(workingState as any), ...(serverSessionState as any) };

        // If backend says blocked, keep pill as intimate AND set pending
        if (data.mode === "explicit_blocked") {
          (merged as any).mode = "intimate";
          (merged as any).pending_consent = "intimate";
        }

        // If backend says allowed, clear pending
        if (data.mode === "explicit_allowed" && (merged as any).pending_consent) {
          (merged as any).pending_consent = null;
        }

        // Normalize & apply backend mode when present
        const backendMode = normalizeMode((serverSessionState as any)?.mode ?? (data as any)?.mode);
        if (backendMode && data.mode !== "explicit_blocked") {
          (merged as any).mode = backendMode;
        }

        // If we are not in intimate, never keep the intimate pending flag
        if ((merged as any).mode !== "intimate" && (merged as any).pending_consent === "intimate") {
          (merged as any).pending_consent = null;
        }

        workingState = merged;
        sessionStateRef.current = merged;
        setSessionState(merged);
      } else {
        // If blocked but session_state missing, still reflect pending
        if (data.mode === "explicit_blocked") {
          workingState = { ...(workingState as any), mode: "intimate", pending_consent: "intimate" } as any;
          sessionStateRef.current = workingState;
          setSessionState(workingState);
        }

        // If allowed but session_state missing, clear pending and mark consented
        if (data.mode === "explicit_allowed") {
          workingState = { ...(workingState as any), pending_consent: null, explicit_consented: true } as any;
          sessionStateRef.current = workingState;
          setSessionState(workingState);
        }
      }

      const replyText = String((data as any).reply || "");
      const displayReplyText = String(
        (data as any).display_reply ?? (data as any).displayReply ?? replyText ?? ""
      );
      const turnTranslation: any = (data as any).turn_translation ?? (data as any).turnTranslation ?? {};
      const userTurnTranslation: any =
        (turnTranslation && typeof turnTranslation === "object" ? (turnTranslation as any).user : null) || null;
      const replyTurnTranslation: any =
        (turnTranslation && typeof turnTranslation === "object" ? (turnTranslation as any).reply : null) ||
        (data as any).reply_translation ||
        (data as any).replyTranslation ||
        null;
      const contentMsgs = buildContentAssistantMsgs((data as any).content);
      const replyMsg: Msg | null = buildAssistantTurnMsg(displayReplyText || replyText, replyTurnTranslation, "ai");
      const historyUserMsg = applyTranslationMetaToMsg(
        userMsg,
        userTurnTranslation,
        String((userMsg as any)?.content || "").trim(),
      );
      applyUserTurnTranslationByClientId(
        String((item as any)?.clientTurnId || "").trim(),
        userTurnTranslation,
        String((userMsg as any)?.content || "").trim(),
      );

      // If this queued message came from an out-of-session user, we rendered a placeholder
      // notice bubble at noticeIndex. Replace it in-place so chat ordering stays coherent.
      const noticeIndex = Number((item as any)?.noticeIndex ?? -1);
      setMessages((prev) => {
        if (!Array.isArray(prev)) return prev as any;

        const next = prev.slice();

        let replyToAppend: Msg | null = replyMsg;
        let contentToAppend: Msg[] = contentMsgs.slice();

        if (noticeIndex >= 0 && noticeIndex < next.length) {
          if (replyMsg) {
            next[noticeIndex] = replyMsg;
            replyToAppend = null;
          } else if (contentMsgs.length) {
            next[noticeIndex] = contentMsgs[0];
            contentToAppend = contentMsgs.slice(1);
          }
        }

        const append: Msg[] = [];
        if (replyToAppend) append.push(replyToAppend);
        if (contentToAppend.length) append.push(...contentToAppend);

        return append.length ? [...next, ...append] : next;
      });

      // Advance the backend history used for subsequent queued messages
      history = [...history, historyUserMsg];
      if (replyMsg) history.push(replyMsg);
      if (contentMsgs.length) history.push(...contentMsgs);

      // Remove the item only after successful processing
      streamDeferredQueueRef.current.shift();
    }
  } catch (err: any) {
    if (epochAtStart !== clearEpochRef.current) return;
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: `Error: ${err?.message ?? "Unknown error"}` },
    ]);
  } finally {
    streamPreSessionHistoryRef.current = null;
    streamDeferredFlushInFlightRef.current = false;
    setLoading(false);
  }
}, [
  applyUserTurnTranslationByClientId,
  callChat,
  translatorEnabled,
  userLanguageCode,
  userLanguageName,
  syncLanguagePreferenceFromBackend,
]);

// Detect LegacyStream session start/stop to capture history + flush queue.
useEffect(() => {
  const prev = prevSessionActiveRef.current;
  const cur = Boolean(sessionActive);

  // When the stream starts (host begins live session), snapshot the current chat history for the flush.
  if (!prev && cur) {
    streamPreSessionHistoryRef.current = filterMessagesForBackend(messagesRef.current || []);
  }

  // When the stream ends, flush queued messages automatically.
  if (prev && !cur) {
    void flushQueuedStreamMessages();
  }

  prevSessionActiveRef.current = cur;
}, [sessionActive, flushQueuedStreamMessages]);

  function clearSttSilenceTimer() {
    if (sttSilenceTimerRef.current) {
      window.clearTimeout(sttSilenceTimerRef.current);
      sttSilenceTimerRef.current = null;
    }
  }

  function clearSttRestartTimer() {
    if (sttRestartTimerRef.current) {
      window.clearTimeout(sttRestartTimerRef.current);
      sttRestartTimerRef.current = null;
    }
  }

  function clearSttRecoverTimer() {
    if (sttRecoverTimerRef.current) {
      window.clearTimeout(sttRecoverTimerRef.current);
      sttRecoverTimerRef.current = null;
    }
  }

  const resetSpeechRecognition = useCallback(() => {
    const rec = sttRecRef.current as any;
    if (!rec) return;

    try {
      rec.onstart = null;
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
    } catch (e) {
      // ignore
    }

    try {
      rec.abort?.();
    } catch (e) {
      // ignore
    }
    try {
      rec.stop?.();
    } catch (e) {
      // ignore
    }

    sttRecRef.current = null;
    setSttRunning(false);
  }, []);

  const getCurrentSttText = useCallback((): string => {
    return `${(sttFinalRef.current || "").trim()} ${(sttInterimRef.current || "").trim()}`.trim();
  }, []);

    // ------------------------------------------------------------
  // Backend STT (record + server-side transcription).
  // iOS/iPadOS Web Speech STT can be unstable; this path is far more reliable.
  // Requires backend endpoint: POST /stt/transcribe (raw audio Blob; Content-Type audio/webm|audio/mp4) -> { text }
  // ------------------------------------------------------------
  const liveAvatarActive =
    liveProvider === "d-id" &&
    (avatarStatus === "connecting" || avatarStatus === "connected" || avatarStatus === "reconnecting");

  const speechRecognitionSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    const w: any = window as any;
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  }, []);

  // Prefer backend STT for iOS **audio-only** mode (more stable than browser SpeechRecognition).
  // If SpeechRecognition is unavailable (common on iOS), use backend STT even when embedded so the user can grant mic access.
  // Keep Live Avatar mode on browser STT (it is already stable across devices).
  const useBackendStt =
    isIOS && backendSttAvailable && !liveAvatarActive && (!isEmbedded || !speechRecognitionSupported);

  const cleanupBackendSttResources = useCallback(() => {
    try {
      if (backendSttRecorderRef.current && backendSttRecorderRef.current.state !== "inactive") {
        backendSttRecorderRef.current.stop();
      }
    } catch (e) {}
    backendSttRecorderRef.current = null;

    if (backendSttHardStopTimerRef.current) {
      window.clearTimeout(backendSttHardStopTimerRef.current);
      backendSttHardStopTimerRef.current = null;
    }

    if (backendSttRafRef.current !== null) {
      cancelAnimationFrame(backendSttRafRef.current);
      backendSttRafRef.current = null;
    }

    if (backendSttStreamRef.current) {
      backendSttStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (e) {}
      });
      backendSttStreamRef.current = null;
    }

    if (backendSttAudioCtxRef.current) {
      try {
        backendSttAudioCtxRef.current.close();
      } catch (e) {}
      backendSttAudioCtxRef.current = null;
    }

    backendSttHasSpokenRef.current = false;
    backendSttLastVoiceAtRef.current = 0;
  }, []);

  const abortBackendStt = useCallback(() => {
    try {
      backendSttAbortRef.current?.abort();
    } catch (e) {}
    backendSttAbortRef.current = null;

    cleanupBackendSttResources();

    // NOTE: we intentionally do NOT flip backendSttInFlightRef here.
    // startBackendSttOnce() owns that lifecycle and will clear it in its own finally blocks.
    setSttRunning(false);
  }, [cleanupBackendSttResources]);

  const transcribeBackendStt = useCallback(
    async (blob: Blob): Promise<string> => {
      if (!API_BASE) throw new Error("Missing NEXT_PUBLIC_API_BASE_URL");

      // Backend expects raw audio bytes in the request body (NOT multipart/form-data).
      const controller = new AbortController();
      backendSttAbortRef.current = controller;

      const apiBase = API_BASE.replace(/\/+$/, "");
      const contentType = blob.type || (isIOS ? "audio/mp4" : "audio/webm");

      const resp = await fetch(`${apiBase}/stt/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          Accept: "application/json",
          "X-STT-Language": normalizeLanguageTag(sttLanguageHintCode) || "en",
          "X-User-Language": normalizeLanguageTag(sttLanguageHintCode) || "en",
        },
        body: blob,
        signal: controller.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          detail = await resp.text();
        } catch (e) {}
        throw new Error(`STT backend error ${resp.status}: ${detail || resp.statusText}`);
      }

      const data = (await resp.json()) as any;
      return String(data?.text ?? "").trim();
    },
    [API_BASE, isIOS, userLanguageCode],
  );

  const startBackendSttOnce = useCallback(async (): Promise<void> => {
    if (!useBackendStt) return;
    if (!sttEnabledRef.current || sttPausedRef.current) return;
    if (backendSttInFlightRef.current) return;

    const now0 = performance.now();
    if (now0 < sttIgnoreUntilRef.current) {
      const waitMs = Math.max(0, Math.ceil(sttIgnoreUntilRef.current - now0 + 50));
      setTimeout(() => {
        if (sttEnabledRef.current && !sttPausedRef.current) {
          startBackendSttOnce().catch(() => {});
        }
      }, waitMs);
      return;
    }

    backendSttInFlightRef.current = true;
    backendSttHasSpokenRef.current = false;
    backendSttLastVoiceAtRef.current = performance.now();

    clearSttSilenceTimer();
    setSttError(null);
    setSttRunning(true);
    setSttInterim("");
    setSttFinal("");

    try {
      const getStreamWithRetries = async (): Promise<MediaStream> => {
        const constraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        };

        let lastErr: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await navigator.mediaDevices.getUserMedia(constraints);
          } catch (e) {
            lastErr = e;
            const name = e?.name || "";
            // Permission/security errors won't succeed on retry.
            if (name === "NotAllowedError" || name === "SecurityError") break;
            await new Promise((r) => setTimeout(r, 250));
          }
        }

        throw lastErr;
      };

      const stream = await getStreamWithRetries();
      backendSttStreamRef.current = stream;

      // Choose best available recording MIME type for this browser.
      let mimeType = "";
      try {
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/mpeg"];
        for (const c of candidates) {
          if (typeof MediaRecorder !== "undefined" && (MediaRecorder as any).isTypeSupported?.(c)) {
            mimeType = c;
            break;
          }
        }
      } catch (e) {}

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        throw new Error("This browser cannot record audio for STT. Please use Live Avatar mode on this device.");
      }
      backendSttRecorderRef.current = recorder;

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      const blobPromise = new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          const type = recorder.mimeType || mimeType || "audio/webm";
          resolve(new Blob(chunks, { type }));
        };
        (recorder as any).onerror = (ev: any) => reject(ev?.error || new Error("Recorder error"));
      });

      // Simple VAD (silence detection) using AnalyserNode
      try {
        const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx: AudioContext = new Ctx();
        backendSttAudioCtxRef.current = ctx;
        try {
          await ctx.resume();
        } catch (e) {}

        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const threshold = 0.02; // RMS threshold
        const minRecordMs = 350;
        const maxRecordMs = 15000;
        const silenceMs = 2000;
        const startedAt = performance.now();

        const tick = () => {
          if (!sttEnabledRef.current || sttPausedRef.current) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch (e) {}
            return;
          }

          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const now = performance.now();

          if (rms > threshold) {
            backendSttLastVoiceAtRef.current = now;
            backendSttHasSpokenRef.current = true;
          }

          const elapsed = now - startedAt;
          const silentFor = now - backendSttLastVoiceAtRef.current;

          if (elapsed >= maxRecordMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch (e) {}
            return;
          }

          if (backendSttHasSpokenRef.current && elapsed > minRecordMs && silentFor >= silenceMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch (e) {}
            return;
          }

          backendSttRafRef.current = requestAnimationFrame(tick);
        };

        backendSttRafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        // If VAD setup fails, we still record; hard-stop timer will end it.
      }

      backendSttHardStopTimerRef.current = window.setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch (e) {}
      }, 16000);

      try {
        recorder.start(250);
      } catch (e) {
        throw new Error("Failed to start recording.");
      }

      const blob = await blobPromise;
      const hadSpeech = backendSttHasSpokenRef.current;

      // Important: release the mic/audio session BEFORE we attempt any TTS playback.
      cleanupBackendSttResources();
      setSttRunning(false);

      // If user disabled/paused during capture, do nothing further.
      if (!sttEnabledRef.current || sttPausedRef.current) return;

      // If we never detected speech, skip transcription to avoid cost/noise.
      if (!hadSpeech) return;
      if (!blob || blob.size < 2048) return;

      const text = await transcribeBackendStt(blob);
      if (!text) return;

      // Ignore if we're still inside an ignore window (e.g., avatar speech bleed).
      if (performance.now() < sttIgnoreUntilRef.current) return;

      setSttFinal(text);
      sttFinalRef.current = text;

      // If send() is currently blocked by loading=true, queue the STT transcript.
      if (loadingRef.current) {
        sttDeferredQueueRef.current.push(text);
        return;
      }

      await send(text);
    } catch (e) {
      setSttError(e?.message || "STT failed.");
    } finally {
      cleanupBackendSttResources();
      setSttRunning(false);
      backendSttInFlightRef.current = false;

      // Hands-free loop: if still enabled, start listening again.
      if (sttEnabledRef.current && !sttPausedRef.current) {
        const now = performance.now();
        const ignoreWait = now < sttIgnoreUntilRef.current ? Math.ceil(sttIgnoreUntilRef.current - now + 50) : 0;
        const baseDelay = isIOS ? 100 : 0;

        setTimeout(() => {
          startBackendSttOnce().catch(() => {});
        }, Math.max(ignoreWait, baseDelay));
      }
    }
  }, [
    clearSttSilenceTimer,
    cleanupBackendSttResources,
    isIOS,
    send,
    transcribeBackendStt,
    useBackendStt,
  ]);

  const kickBackendStt = useCallback(() => {
    if (!useBackendStt) return;
    if (!sttEnabledRef.current || sttPausedRef.current) return;
    if (backendSttInFlightRef.current) return;

    // Small delay helps iOS fully exit previous audio state.
    setTimeout(() => {
      startBackendSttOnce().catch(() => {});
    }, isIOS ? 100 : 0);
  }, [isIOS, startBackendSttOnce, useBackendStt]);

const pauseSpeechToText = useCallback(() => {
    sttPausedRef.current = true;
    clearSttSilenceTimer();

    setSttInterim("");
    setSttFinal("");

    // Backend STT: abort any in-flight record/transcribe
    abortBackendStt();

    // Browser STT: stop recognition if it exists
    const rec = sttRecRef.current;
    try {
      rec?.stop?.();
    } catch (e) {
      // ignore
    }

    // iOS Web Speech can get stuck after stop(); force a fresh recognizer next time.
    // (Embedded iOS uses Web Speech; backend STT is disabled when embedded.)
    if (isIOS && !useBackendStt) {
      resetSpeechRecognition();
    }

    setSttRunning(false);
  }, [abortBackendStt, clearSttSilenceTimer, isIOS, useBackendStt, resetSpeechRecognition]);

  const scheduleSttAutoSend = useCallback(() => {
    if (!sttEnabledRef.current) return;

    clearSttSilenceTimer();

    sttSilenceTimerRef.current = window.setTimeout(() => {
      const text = getCurrentSttText();
      if (!text) return;

      // NOTE:
      // We intentionally do NOT pause STT here.
      // - send() already pauses/resumes STT as needed for normal (non-stream) interactions to prevent feedback.
      // - During LegacyStream live sessions, send() will *not* call the backend and will *not* pause STT,
      //   which keeps iOS/Safari stable and lets members keep speaking/typing freely.
      sttFinalRef.current = "";
      sttInterimRef.current = "";
      setInput("");

      // If a response is still being prepared, STT auto-send would be dropped.
      // Queue it and flush once loading clears.
      if (loadingRef.current) {
        sttDeferredQueueRef.current.push(text);
        return;
      }

      void sendRef.current(text);
    }, 2000);
  }, [getCurrentSttText, clearSttSilenceTimer]);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    // NOTE: Web Speech API does not reliably prompt on iOS if start() is called
    // outside the user's click. We still use getUserMedia to ensure permission exists.
    if (!navigator.mediaDevices?.getUserMedia) return true;
    // iOS Safari (especially when embedded) can reject getUserMedia even when SpeechRecognition still works.
    // If we're not using backend STT, let SpeechRecognition trigger the permission prompt instead.
    if (isIOS && !useBackendStt) return true;

    // Elaralo-specific iframe handoff fix:
    // My Elaralo opens Connect by navigating the same Wix iframe that originally
    // hosted the selector. In that embedded path, Chrome can reject the
    // getUserMedia preflight even though browser SpeechRecognition can still
    // trigger the mic prompt from the actual button click. DulceMoon remains on
    // the Wix postMessage payload path and is not affected by this branch.
    if (isEmbedded && isDirectElaraloConnectLaunch && speechRecognitionSupported && !useBackendStt) {
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());

      // Mic permission is granted once getUserMedia succeeds.
      micGrantedRef.current = true;
      setMicGranted(true);
      return true;
    } catch (e) {
      console.warn("Mic permission denied/unavailable:", e);
      setSttError(
        isIOS
          ? "Microphone access is blocked for this site. Enable it in iOS Safari settings (aA > Website Settings > Microphone > Allow) and reload."
          : "Microphone permission was blocked.",
      );

      const name = e?.name || "";
      // If backend STT can't access the mic (common in some embedded contexts),
      // fall back to browser SpeechRecognition for this session.
      if (name === "NotAllowedError" || name === "SecurityError") {
        setBackendSttAvailable(false);
        try {
          sttRecRef.current?.abort?.();
        } catch (e) {
          // ignore
        }
        sttRecRef.current = null;
      }

      return false;
    }
  }, [getEmbedHint, isDirectElaraloConnectLaunch, isEmbedded, isIOS, setBackendSttAvailable, speechRecognitionSupported, useBackendStt]);

  const ensureSpeechRecognition = useCallback((): any | null => {
    if (typeof window === "undefined") return null;

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) return null;

    if (sttRecRef.current) return sttRecRef.current as any;

    const rec = new SpeechRecognitionCtor();

    // iOS + embedded contexts are more stable with continuous=false and manual restarts.
    try {
      rec.continuous = !isIOS;
    } catch (e) {
      // ignore
    }

    try {
      rec.interimResults = true;
    } catch (e) {
      // ignore
    }

    try {
      rec.lang = normalizeLanguageTag(userLanguageCode) || "en-US";
    } catch (e) {
      // ignore
    }

    rec.onstart = () => {
      setSttRunning(true);
      setSttError(null);

      sttEverStartedRef.current = true;
      micGrantedRef.current = true;
      setMicGranted(true);
      // reset audio-capture fail window on successful start
      sttAudioCaptureFailsRef.current = 0;
      sttLastAudioCaptureAtRef.current = 0;
    };

        const scheduleRestart = () => {
      setSttRunning(false);

      if (!sttEnabledRef.current || sttPausedRef.current) return;

      clearSttRestartTimer();

      const now = Date.now();
      const ignoreDelay = Math.max(0, (sttIgnoreUntilRef.current || 0) - now);

      // iOS/iPadOS: keep restart delay short to reduce clipped first words; onerror recovery handles flaky starts.
      const baseDelay = isIOS ? 200 : 250;

      sttRestartTimerRef.current = window.setTimeout(() => {
        if (!sttEnabledRef.current || sttPausedRef.current) return;

        try {
          rec.start();
        } catch (e) {
          // ignore
        }
      }, baseDelay + ignoreDelay);
    };

    rec.onend = scheduleRestart;

    rec.onerror = (event: any) => {
      const code = String(event?.error || "");

      if (code === "no-speech" || code === "aborted") {
        return;
      }

      if (code === "not-allowed" || code === "service-not-allowed") {
        const now = Date.now();
        const hadMic = Boolean(micGrantedRef.current || sttEverStartedRef.current);

        const withinWindow = now - sttLastNotAllowedAtRef.current < 15000;
        sttLastNotAllowedAtRef.current = now;
        sttNotAllowedFailsRef.current = withinWindow ? sttNotAllowedFailsRef.current + 1 : 1;

        // If we've ever started successfully, treat this as transient and auto-recover.
        if (hadMic && sttNotAllowedFailsRef.current <= 8) {
          setSttError("Microphone temporarily unavailable. Retrying…" + getEmbedHint());
          try {
            rec.stop?.();
          } catch {}
          scheduleRestart();
          return;
        }

        // Hard denial (initial block) or repeated failures: disable STT.
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        setSttEnabled(false);
        setSttRunning(false);
        clearSttSilenceTimer();
        clearSttRestartTimer();
        clearSttRecoverTimer();
        setSttError(
          isIOS
            ? "Microphone access is blocked. Enable it in iOS Safari settings (aA > Website Settings > Microphone > Allow) and reload."
            : "Microphone permission was blocked." + getEmbedHint(),
        );
        try {
          rec.stop?.();
        } catch {}
        return;
      }

      if (code === "audio-capture") {
        const now = Date.now();
        const withinWindow = now - sttLastAudioCaptureAtRef.current < 10_000;
        sttAudioCaptureFailsRef.current = withinWindow
          ? sttAudioCaptureFailsRef.current + 1
          : 1;
        sttLastAudioCaptureAtRef.current = now;

        setSttError("Speech-to-text error: audio-capture (no microphone found). Retrying…");

        // If it keeps failing, we stop instead of looping forever.
        if (sttAudioCaptureFailsRef.current >= 4) {
          sttEnabledRef.current = false;
          sttPausedRef.current = false;
          setSttEnabled(false);
          setSttRunning(false);
          clearSttSilenceTimer();
          clearSttRestartTimer();
        clearSttRecoverTimer();
          clearSttRecoverTimer();
          setSttError(
            "Speech-to-text could not access the microphone on this device. Please reload the page and try again."
              + getEmbedHint()
          );
          try {
            rec.stop?.();
          } catch (e) {
            // ignore
          }
          return;
        }

        // Recovery path: recreate recognition (helps iOS) and try again after a short delay.
        clearSttRecoverTimer();
        sttRecoverTimerRef.current = window.setTimeout(async () => {
          if (!sttEnabledRef.current || sttPausedRef.current) return;

          resetSpeechRecognition();

          const ok = await requestMicPermission();
          if (!ok) return;

          const r2 = ensureSpeechRecognition();
          if (!r2) return;

          try {
            r2.start();
          } catch (e) {
            // ignore
          }
        }, isIOS ? 1200 : 650);

        return;
      }

      console.warn("STT error:", code, event);
      setSttError(`Speech-to-text error: ${code}`);
    };

    rec.onresult = (event: any) => {
      if (!sttEnabledRef.current || sttPausedRef.current) return;
      if (Date.now() < (sttIgnoreUntilRef.current || 0)) return;

      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res?.[0]?.transcript ?? "";
        if (res?.isFinal) finalText += txt;
        else interimText += txt;
      }

      if (finalText) sttFinalRef.current = `${sttFinalRef.current} ${finalText}`.trim();
      sttInterimRef.current = interimText.trim();

      const combined = getCurrentSttText();
      setInput(combined);

      scheduleSttAutoSend();
    };

    sttRecRef.current = rec;
    return rec;
  }, [
    isIOS,
    getCurrentSttText,
    scheduleSttAutoSend,
    getEmbedHint,
    requestMicPermission,
    resetSpeechRecognition,
    userLanguageCode,
  ]);

  const resumeSpeechToText = useCallback(() => {
    if (!sttEnabledRef.current) return;

    sttPausedRef.current = false;

    // iOS/iPadOS: use backend STT recorder (more stable than Web Speech)
    if (useBackendStt) {
      kickBackendStt();
      return;
    }

    // iOS/iPadOS: starting recognition can be flaky right after media playback,
    // but adding a big delay clips the user's first words. Start immediately and
    // rely on the onerror recovery path to back off if Safari isn't ready yet.
    clearSttRestartTimer();
    const delayMs = 0; // Start immediately to avoid clipping the user's first words; onerror recovery handles mic warm-up.

    sttRestartTimerRef.current = window.setTimeout(() => {
      if (!sttEnabledRef.current) return;
      if (sttPausedRef.current) return;

      const ok = ensureSpeechRecognition();
      if (!ok) {
        sttEnabledRef.current = false;
        setSttRunning(false);
        setSttError("Speech-to-text is not supported in this browser.");
        return;
      }

      const rec = sttRecRef.current;
      if (!rec) return;

      try {
        rec.start();
        setSttRunning(true);
      } catch (e) {
        // ignore; will restart on onend if needed
      }
    }, delayMs);
  }, [
    clearSttRestartTimer,
    ensureSpeechRecognition,
    isIOS,
    kickBackendStt,
    useBackendStt,
  ]);

  // Play the companion greeting in voice/video modes (once per session, per companion).
  // (The greeting text is already injected into the chat on load — this only plays it.)
const greetInFlightRef = useRef(false);

const speakGreetingIfNeeded = useCallback(
  async (mode: "live" | "audio") => {
    // Ensure the first audio-only TTS greeting uses the selected companion voice.
    // If Wix hasn't provided plan/companion yet, or the DB voice mapping is still loading, defer.
    if (mode === "audio" && (!handoffReady || !companionMappingResolved)) {
      pendingGreetingModeRef.current = "audio";
      return;
    }

    const name = (companionName || "").trim() || "Companion";
    // Include backend mapping load/voice context in the spoken-greeting once-key.
    // This avoids suppressing a corrected pronunciation after the API reloads the
    // companion_mappings row, while still keeping the greeting once-per-session.
    const mappingLoadedAtKey = normalizeKeyForFile(String((companionMapping as any)?.loadedAt || "no-loaded-at"));
    const voiceKeyPart = normalizeKeyForFile(String((companionMapping as any)?.elevenVoiceId || (companionMapping as any)?.eleven_voice_id || "no-voice"));
    const phoneticKeyPart = normalizeKeyForFile(String(companionPhonetic || "backend-authoritative").trim() || "backend-authoritative");
    const key = `ELARALO_GREET_SPOKEN:${name}:${voiceKeyPart}:${phoneticKeyPart}:${mappingLoadedAtKey}`;

    // Already spoken this session?
    try {
      if (sessionStorage.getItem(key) === "1") return;
    } catch (e) {}

    // Prevent duplicates/races (e.g., Live Avatar connects right after mic-start).
    if (greetInFlightRef.current) return;
    greetInFlightRef.current = true;

    // IMPORTANT: do NOT pre-substitute the phonetic value in the browser.
    // The backend is the authority for both the current ElevenLabs voice and the
    // current companion_mappings.phonetic value. Sending the visible display name
    // here lets /tts/audio-url resolve the fresh DB row and prevents stale
    // mappingPhonetic values from the browser from driving the first greeting.
    const greetText = greetingForSpeech(name);
    // Local audio-only greeting must always use the companion's ElevenLabs voice.
    // (Live avatar uses its own configured voice via the DID agent.)
    const safeCompanionKey = resolveCompanionForBackend({ companionKey, companionName });

      // Prefer DB-driven voice mapping when available (fixes rebrands like Dulce using the default voice).
      const voiceId = ((companionMapping?.elevenVoiceId || "").trim() || getElevenVoiceIdForAvatar(safeCompanionKey));

    // Belt & suspenders: avoid STT re-capturing the greeting audio.
    const prevIgnore = sttIgnoreUntilRef.current;
    sttIgnoreUntilRef.current = performance.now() + 60_000; // 60s

    try {
      try {
        await pauseSpeechToText();
      } catch (e) {}

      // iOS/Safari can start the first post-mic playback in a low/communications-volume route.
      // Re-prime the audio session right before the first greeting so it isn't feeble.
      if (mode === "audio") {
        try { boostAllTtsVolumes(); } catch (e) {}
        try { await nudgeAudioSession(); } catch (e) {}
        try { primeLocalTtsAudio(true); } catch (e) {}
        try { void ensureIphoneAudioContextUnlocked(); } catch (e) {}
      }

      const hooks: SpeakAssistantHooks = {
        onWillSpeak: () => {},
        onDidNotSpeak: () => {},
      };

      if (mode === "live" && didAgentMgrRef.current) {
        // Live avatar speaks using the avatar's configured voice
        await speakAssistantReply(greetText);
      } else {
        // Local audio-only (video element on iOS; audio element on desktop)
        await speakLocalTtsReply(greetText, voiceId, hooks);
      }

      // Mark spoken ONLY after successful playback.
      try {
        sessionStorage.setItem(key, "1");
      } catch (e) {}
    } catch (e) {
      // Allow retry later if something failed.
      try {
        sessionStorage.removeItem(key);
      } catch (e) {}
      console.warn("Greeting playback failed:", e);
    } finally {
      sttIgnoreUntilRef.current = prevIgnore;
      greetInFlightRef.current = false;
      try {
        await resumeSpeechToText();
      } catch (e) {}
    }
  },
  [
    companionName,
    companionKey,
    companionPhonetic,
    companionMapping,
    companionMappingResolved,
    handoffReady,
    pauseSpeechToText,
    resumeSpeechToText,
    speakAssistantReply,
    speakLocalTtsReply,
    boostAllTtsVolumes,
    nudgeAudioSession,
    primeLocalTtsAudio,
    ensureIphoneAudioContextUnlocked,
  ],
);

  const maybePlayPendingGreeting = useCallback(async () => {
    const mode = pendingGreetingModeRef.current;
    if (!mode) return;
    if (!micGrantedRef.current) return;

    if (mode === "audio") {
      if (!handoffReady || !companionMappingResolved) return;
    }

    // Live Avatar greeting must wait until the agent is fully connected.
    if (mode === "live") {
      if (avatarStatus !== "connected" || !didAgentMgrRef.current) return;
    }

    // Clear first so we don't re-enter if something throws.
    pendingGreetingModeRef.current = null;
    await speakGreetingIfNeeded(mode);
  }, [avatarStatus, companionMappingResolved, handoffReady, speakGreetingIfNeeded]);

  // If the user started an audio-only experience before the Wix handoff arrived,
  // play the pending greeting once plan/companion information is available.
  useEffect(() => {
    if (!handoffReady || !companionMappingResolved) return;
    if (!pendingGreetingModeRef.current) return;
    void maybePlayPendingGreeting();
  }, [handoffReady, companionMappingResolved, maybePlayPendingGreeting]);

  // Auto-play the greeting once the Live Avatar is connected, but ONLY after the user has granted mic access.
  useEffect(() => {
    if (!liveAvatarActive) return;
    if (avatarStatus !== "connected") return;

    pendingGreetingModeRef.current = "live";
    void maybePlayPendingGreeting();
  }, [avatarStatus, liveAvatarActive, maybePlayPendingGreeting]);

  // Play any queued greeting as soon as mic access is granted.
  useEffect(() => {
    if (!micGranted) return;
    void maybePlayPendingGreeting();
  }, [micGranted, maybePlayPendingGreeting]);



  const stopSpeechToText = useCallback(
    (clearError: boolean = true) => {
      sttEnabledRef.current = false;
      sttPausedRef.current = false;
      setSttEnabled(false);
      clearSttSilenceTimer();

      setSttInterim("");
      setSttFinal("");
      setSttRunning(false);

      // Abort backend STT capture/transcribe if in flight
      abortBackendStt();
      backendSttInFlightRef.current = false;

      // Stop browser SpeechRecognition if it exists
      resetSpeechRecognition();

      if (clearError) setSttError(null);
    },
    [abortBackendStt, clearSttSilenceTimer, resetSpeechRecognition]
  );

  const startSpeechToText = useCallback(async (opts?: { forceBrowser?: boolean; suppressGreeting?: boolean }) => {
    const forceBrowser = !!opts?.forceBrowser;
    // iOS Safari can enter a low-volume route after stop/start transitions.
    // Apply the same "loud path" recovery we use for Clear/Save before kicking off STT.
    // IMPORTANT: do not await here; iOS SpeechRecognition must start directly from the user gesture.
    try { boostAllTtsVolumes(); } catch (e) {}
    void nudgeAudioSession();
    primeLocalTtsAudio(true);
    void ensureIphoneAudioContextUnlocked();

    sttEnabledRef.current = true;
    sttPausedRef.current = false;
    setSttEnabled(true);
    setSttError(null);

    const usingBackend = useBackendStt && !forceBrowser;

    // IMPORTANT (iOS Safari / iOS embedded): SpeechRecognition.start() must be invoked directly
    // from the user's gesture. Avoid awaiting anything before starting browser STT.
    if (isIOS && !usingBackend) {
      const ok = ensureSpeechRecognition();
      if (!ok) {
        setSttError("Speech-to-text is not supported in this browser.");
        stopSpeechToText(false);
        return;
      }
      resumeSpeechToText();
      if (!liveAvatarActive && !opts?.suppressGreeting) {
        pendingGreetingModeRef.current = "audio";
        void maybePlayPendingGreeting();
      }
      return;
    }

    const permOk = await requestMicPermission();
    if (!permOk) {
      setSttError("Microphone permission denied.");
      stopSpeechToText(false);
      return;
    }

    // iOS/iPadOS: prefer backend STT recorder (more stable than Web Speech)
    // NOTE: When starting Live Avatar, we force browser STT so D-ID voice doesn't rely on backend recorder.
    if (usingBackend) {
      // Backend STT: if we need to play the audio greeting, do it first (after mic is granted),
      // then resumeSpeechToText() will start the backend recorder.
      if (!liveAvatarActive && !opts?.suppressGreeting) {
        pendingGreetingModeRef.current = "audio";
        void maybePlayPendingGreeting();
      } else {
        kickBackendStt();
      }
      return;
    }

    const ok = ensureSpeechRecognition();
    if (!ok) {
      setSttError("Speech-to-text is not supported in this browser.");
      stopSpeechToText(false);
      return;
    }

    resumeSpeechToText();
    if (!liveAvatarActive && !opts?.suppressGreeting) {
      pendingGreetingModeRef.current = "audio";
      void maybePlayPendingGreeting();
    }
  }, [
    boostAllTtsVolumes,
    ensureSpeechRecognition,
    kickBackendStt,
    liveAvatarActive,
    maybePlayPendingGreeting,
    nudgeAudioSession,
    primeLocalTtsAudio,
    ensureIphoneAudioContextUnlocked,
    requestMicPermission,
    resumeSpeechToText,
    speakGreetingIfNeeded,
    stopSpeechToText,
    useBackendStt,
  ]);

  const toggleSpeechToText = useCallback(async () => {
    // In Live Avatar mode, mic is required. We don't allow toggling it off.
    // If STT isn't running (permission denied or stopped), we try to start it again.
    if (liveAvatarActive) {
      if (!sttEnabledRef.current) {
        await startSpeechToText({ forceBrowser: true, suppressGreeting: true });
      }
      return;
    }

    if (sttEnabledRef.current) stopSpeechToText();
    else await startSpeechToText();
  }, [liveAvatarActive, startSpeechToText, stopSpeechToText]);

  const stopHandsFreeSTT = useCallback(() => {
    // Cancel any in-flight local TTS work and advance epoch so late callbacks are ignored.
    localTtsEpochRef.current += 1;
    try {
      localTtsAbortRef.current?.abort();
    } catch (e) {}
    localTtsAbortRef.current = null;
    // Stop listening immediately
    stopSpeechToText();

    // Stop any local audio-only playback (audio OR video element).
    stopLocalTtsPlayback();
    // Force a fresh iOS audio-route prime next time the mic/audio starts (prevents low/silent volume after stop/cancel).
    localTtsUnlockedRef.current = false;

    // If Live Avatar is running, stop it too (mic is required in Live Avatar mode)
    if (liveAvatarActive) {
      void stopLiveAvatar();
    }
  }, [liveAvatarActive, stopLiveAvatar, stopLocalTtsPlayback, stopSpeechToText]);

  // Stop button handler (explicit user gesture): stop all comms AND immediately
  // re-prime the iOS/Safari audio route so that when the user manually resumes
  // (Live Avatar or Audio-only), volume does not drop to the quiet receiver path.
  const handleStopClick = useCallback(() => {
    try {
      stopHandsFreeSTT();
    } catch (e) {}

    // Conference: Stop/leave (host stops the session for everyone).
    if (sessionKind === "conference") {
      void stopConferenceSession();
      return;
    }


    // Viewer-only (Live Stream): enable Stop to close the embedded player even when mic/STT isn't running.
    // IMPORTANT: This must be synchronous on the user gesture on iOS to avoid breaking future TTS routing.
    // This does NOT affect the underlying stream session because ONLY the host calls stop_embed.
    if (liveProvider === "stream" && !streamCanStart && (joinedStreamRef.current || avatarStatus !== "idle")) {
      // Viewer stop:
      // - Always allow leaving the waiting/connected UI, even if the host has not created an eventRef yet.
      // - This MUST NOT stop the underlying live session (only the host can do that).
      try {
setStreamEventRef("");
        setStreamCanStart(false);
        setStreamNotice("");

        // Viewer explicitly left the in-stream experience.
        joinedStreamRef.current = false;
      } catch (e) {}
      try {
        setAvatarStatus("idle");
        setAvatarError(null);
      } catch (e) {}
    }

    // Host (Live Stream): ensure Stop always ends the session even if mic/STT isn't running.
    // (This is idempotent; stopLiveAvatar has its own in-flight guard.)
    if (liveProvider === "stream" && streamCanStart) {
      try {
        void stopLiveAvatar();
      } catch (e) {}
    }


    // Re-assert boosted audio routing and nudge audio session on the same user gesture.
    try { boostAllTtsVolumes(); } catch (e) {}
    try { void nudgeAudioSession(); } catch (e) {}
    try { primeLocalTtsAudio(true); } catch (e) {}
    try { void ensureIphoneAudioContextUnlocked(); } catch (e) {}
  }, [stopHandsFreeSTT, boostAllTtsVolumes, nudgeAudioSession, primeLocalTtsAudio, ensureIphoneAudioContextUnlocked, liveProvider, streamCanStart, "", streamEventRef, stopLiveAvatar]);

  // Clear Messages (with confirmation)
  const requestClearMessages = useCallback(() => {
    // Stop all audio/video + STT immediately on click (even before the user confirms).
    // This is an overt user action and prevents the assistant from continuing to speak.
    clearEpochRef.current += 1;
    setLoading(false);

    try {
      stopHandsFreeSTT();
    } catch (e) {
      // ignore
    }

    // User gesture: re-assert boosted audio routing and nudge audio session back to playback mode.
    try {
      boostAllTtsVolumes();
    } catch (e) {}
    try {
      void nudgeAudioSession();
    } catch (e) {}

    // Strong iOS recovery: prime the hidden VIDEO element on this user gesture so audio-only TTS
    // is not left in a silent/receiver route after the confirmation modal.
    try {
      primeLocalTtsAudio(true);
    } catch (e) {}
    try {
      void ensureIphoneAudioContextUnlocked();
    } catch (e) {}


    setShowClearMessagesConfirm(true);
  }, [stopHandsFreeSTT, boostAllTtsVolumes, nudgeAudioSession, primeLocalTtsAudio, ensureIphoneAudioContextUnlocked]);


  // After the Clear Messages dialog is dismissed with NO, iOS can sometimes route
  // subsequent audio to the quiet receiver / low-volume path. We "nudge" the
  // audio session back to normal playback volume and ensure our media elements
  // are not left muted/low.
  const restoreVolumesAfterClearCancel = useCallback(async () => {
    // This function runs on a user gesture (Yes/No click). Its job is purely to ensure
    // that *future* manual resumption of TTS is not routed to a silent/receiver path.

    // Re-assert boosted routing first.
    try { boostAllTtsVolumes(); } catch (e) {}

    // iOS route recovery: nudge the audio session back to normal playback.
    try { await nudgeAudioSession(); } catch (e) {}

    // Prime the hidden VIDEO element (required by your constraint) so the next audio-only
    // TTS playback is unlocked and uses the correct output route.
    try { primeLocalTtsAudio(true); } catch (e) {}

    // If Live Avatar is used on iPhone, ensure its audio context is also unlocked.
    try { void ensureIphoneAudioContextUnlocked(); } catch (e) {}

    // Ensure element mute/volume flags are sane (gain routing provides the loudness).
    try {
      const v = localTtsVideoRef.current;
      if (v) {
        v.muted = false;
        v.volume = 1;
        v.setAttribute?.("playsinline", "");
        // @ts-ignore
        v.playsInline = true;
      }
    } catch (e) {}

    try {
      const a = localTtsAudioRef.current;
      if (a) {
        a.muted = false;
        a.volume = 1;
      }
    } catch (e) {}

    try {
      const av = avatarVideoRef.current;
      if (av) {
        av.muted = false;
        av.volume = 1;
      }
    } catch (e) {}
  }, [isIOS, primeLocalTtsAudio, ensureIphoneAudioContextUnlocked, boostAllTtsVolumes, nudgeAudioSession]);


  // Cleanup
  useEffect(() => {
    return () => {
      try {
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        clearSttSilenceTimer();
        clearSttRestartTimer();
        clearSttRecoverTimer();
        const rec = sttRecRef.current;
        if (rec) {
          try {
            rec.onstart = null;
            rec.onend = null;
            rec.onresult = null;
            rec.onerror = null;
          } catch (e) {}
          try {
            rec.abort?.();
          } catch (e) {
            try {
              rec.stop?.();
            } catch (e) {}
          }
        }
      } catch (e) {}
    };
  }, []);

  // UI controls (layout-only): reused in multiple locations without changing logic.
// Viewer requirement: in Live Stream mode, the Stop button should allow a viewer to close *their own*
// embedded player (and halt any STT/TTS) without affecting the host's stream session.
const viewerCanStopStream =
  liveProvider === "stream" &&
  !streamCanStart &&
  // Allow Stop even before an eventRef/embedUrl exists (viewer waiting for host).
  (Boolean(joinedStreamRef.current) ||
    avatarStatus === "connected" ||
    avatarStatus === "waiting" ||
    avatarStatus === "connecting" ||
    avatarStatus === "reconnecting" ||
    avatarStatus === "error");

// Private session stop rules.
// Viewer can only opt-out after they\'ve actually joined.
// Host can always stop the private session when it is active (host-only).
const viewerCanStopConference = sessionKind === "conference" && !isHost && conferenceJoined;
const hostCanStopConference = sessionKind === "conference" && isHost;

// Host requirement: Stop must end the live session (and send the end-event signal to LegacyStream).
const hostCanStopStream =
  liveProvider === "stream" &&
  streamCanStart &&
  (Boolean(streamEventRef) ||
    avatarStatus === "connected" ||
    avatarStatus === "waiting" ||
    avatarStatus === "connecting" ||
    avatarStatus === "reconnecting" ||
    avatarStatus === "error");

const hostInStreamUi =
  liveProvider === "stream" &&
  streamCanStart &&
  (Boolean(streamEventRef) ||
    avatarStatus === "connected" ||
    avatarStatus === "waiting" ||
    avatarStatus === "connecting" ||
    avatarStatus === "reconnecting");

const viewerInStreamUi = viewerHasJoinedStream;
		// Attachments are disabled during Live Stream sessions, but should remain enabled for Live Private Conference.
		const attachmentButtonDisabled =
		  loading ||
		  uploadingAttachment ||
		  uploadsDisabled ||
		  (sessionKind === "stream" && (hostInStreamUi || viewerInStreamUi));

useEffect(() => {
  // Viewer STT must be disabled while in the LegacyStream stream UI to avoid transcribing the host audio.
  if (!viewerInStreamUi) return;
  if (!sttEnabledRef.current) return;
  void stopSpeechToText();
}, [viewerInStreamUi, stopSpeechToText]);

const sttControls =
    liveProvider === "stream" && livekitToken
      ? null
      : (

    <>
      <button
        type="button"
        onClick={() => {
          if (liveProvider === "stream") {
                      if (
                        streamCanStart &&
                        Boolean(streamEventRef) &&
                        (avatarStatus === "connected" || avatarStatus === "waiting")
                      )
                        return;
                      // Viewer STT must be disabled while in the stream UI to avoid transcribing the host audio.
                      if (!streamCanStart && avatarStatus !== "idle") return;
                    }
          void toggleSpeechToText();
        }}
        disabled={(liveProvider === "stream" && streamCanStart && Boolean(streamEventRef) && (avatarStatus === "connected" || avatarStatus === "waiting")) ||
                    // Viewer STT must be disabled while in the stream UI to avoid transcribing the host audio.
                    viewerInStreamUi || (liveAvatarActive && sttEnabled)}
        title="Audio"
        style={{
          width: ICON_BTN_SIZE,
          height: ICON_BTN_SIZE,
          minWidth: ICON_BTN_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: 10,
          border: "1px solid #111",
          boxSizing: "border-box",
          background: sttEnabled ? "#b00020" : "#fff",
          color: sttEnabled ? "#fff" : "#111",
          cursor: (liveProvider === "stream" && streamCanStart && Boolean(streamEventRef) && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "not-allowed" : "pointer",
          opacity: (liveProvider === "stream" && streamCanStart && Boolean(streamEventRef) && (avatarStatus === "connected" || avatarStatus === "waiting")) ? 0.6 : 1,
          fontWeight: 700,
        }}
      >
        {sttEnabled ? <MicOnIcon size={ICON_20} /> : <MicOffIcon size={ICON_20} />}
      </button>

      {!livekitUiActive && (
        <button
          type="button"
          onClick={handleStopClick}
          disabled={!(sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference)}
          title="Stop"
          aria-label="Stop"
          style={{
            width: ICON_BTN_SIZE,
            height: ICON_BTN_SIZE,
            minWidth: ICON_BTN_SIZE,
            borderRadius: 10,
            border: "1px solid #111",
            boxSizing: "border-box",
            background:
              sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference
                ? "#fff"
                : "#eee",
            color: "#111",
            cursor:
              sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference
                ? "pointer"
                : "not-allowed",
            opacity:
              sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference
                ? 1
                : 0.6,
            fontWeight: 800,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StopIcon size={ICON_18} />
        </button>
      )}

      {canReturnToCompanionList ? (
        <button
          type="button"
          onClick={() => {
            setSwitchCompanionFlash(true);
            window.setTimeout(() => {
              goToCompanionList();
              setSwitchCompanionFlash(false);
            }, 120);
          }}
          style={{
            height: ICON_BTN_SIZE,
            minHeight: ICON_BTN_SIZE,
            padding: "0 12px",
            borderRadius: 10,
            border: "1px solid #111",
            boxSizing: "border-box",
            background: switchCompanionFlash ? "#111" : "#fff",
            color: switchCompanionFlash ? "#fff" : "#111",
            cursor: "pointer",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            whiteSpace: "nowrap",
          }}
          title="Swap companion"
        >
          Swap Companion
        </button>
      ) : null}
</>
  );

  
  const visibleModePills = useMemo(() => {
    // Keep stable ordering regardless of allowedModes ordering.
    const ordered: Mode[] = ["friend", "romantic", "intimate"];
    return ordered.filter((m) => allowedModes.includes(m));
  }, [allowedModes]);

  // Upgrade is always available as a persistent top-right control (white-label URL override via rebrandingKey).
  // (We no longer gate Upgrade visibility based on allowed modes.)


// Hide "Set Mode" while the LegacyStream live session UI is active (host + viewer).
// Requirement: "Please hide the Set Mode button when in live stream."
//
// IMPORTANT: this is a *global* gate — if the host is currently streaming, Set Mode is hidden
// even if a viewer has closed the iframe locally.
const hideSetModeInStream =
  liveProvider === "stream" &&
  (sessionActive ||
    avatarStatus === "connecting" ||
    avatarStatus === "connected" ||
    avatarStatus === "reconnecting" ||
    avatarStatus === "waiting");

// If the picker is open and we enter live stream state, close it.
useEffect(() => {
  if (hideSetModeInStream && showModePicker) setShowModePicker(false);
}, [hideSetModeInStream, showModePicker]);

const modePillControls = (

    <div
      style={{
        display: "flex",
        flexDirection: isMobileUI ? "column" : "row",
        gap: 8,
        flexWrap: isMobileUI ? "nowrap" : "wrap",
        justifyContent: "flex-end",
        alignItems: isMobileUI ? "stretch" : "center",
        width: isMobileUI ? 140 : "auto",
      }}
    >
      {!showModePicker ? (
        <div
          style={{
            display: "flex",
            flexDirection: isMobileUI ? "column" : "row",
            gap: 8,
            justifyContent: "flex-end",
            alignItems: isMobileUI ? "stretch" : "center",
            width: isMobileUI ? "100%" : "auto",
          }}
        >{!hideSetModeInStream ? (

          <button
            type="button"
            onClick={() => {
              setSetModeFlash(true);
              window.setTimeout(() => {
                setShowModePicker(true);
                setSetModeFlash(false);
              }, 120);
            }}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #111",
              background: setModeFlash ? "#111" : "#fff",
              color: setModeFlash ? "#fff" : "#111",
              cursor: "pointer",
              fontWeight: 400,
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: isMobileUI ? "100%" : "auto",
              minHeight: isMobileUI ? 44 : undefined,
            }}
          >
            Set Mode
          </button>
) : null}

          <button
            type="button"
            onClick={() => {
              try { beginPaygoTopupForMember(); } catch (e) {}
            }}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #111",
              background: "#fff",
              color: "#111",
              cursor: "pointer",
              fontWeight: 400,
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: isMobileUI ? "100%" : "auto",
              minHeight: isMobileUI ? 44 : undefined,
            }}
          >
            Add Minutes
          </button>

          {/* Persistent Upgrade button (always visible; uses rebrandingKey UpgradeLink override, else Elaralo default). */}
          <button
            type="button"
            onClick={() => {
              try {
                openUpgradeUrl();
              } catch (e) {}

              // Start upgrade polling so plan changes apply without refresh.
              try {
                startUpgradeWatch("upgrade_button");
              } catch (e) {}
            }}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #111",
              background: "#fff",
              color: "#111",
              cursor: "pointer",
              fontWeight: 400,
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: isMobileUI ? "100%" : "auto",
              minHeight: isMobileUI ? 44 : undefined,
            }}
          >
            Upgrade
          </button>


          {showBroadcastButton ? (
            <button
              type="button"
              onClick={() => {
                void toggleBroadcastOverlay();
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #111",
                background: showBroadcasterOverlay ? "#111" : "#fff",
                color: showBroadcasterOverlay ? "#fff" : "#111",
                cursor: "pointer",
                fontWeight: 400,
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: isMobileUI ? "100%" : "auto",
                minHeight: isMobileUI ? 44 : undefined,
                opacity: broadcastPreparing ? 0.75 : 1,
              }}
              disabled={broadcastPreparing}
              aria-pressed={showBroadcasterOverlay}
              title="Show/Hide Broadcast UI"
            >
              {broadcastPreparing ? "Broadcast…" : "Broadcast"}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {visibleModePills.map((m) => {
            const active = effectiveActiveMode === m;
            return (
              <button
                key={m}
                onClick={() => {
                  setModeFromPill(m);
                  setShowModePicker(false);
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #ddd",
                  background: active ? "#111" : "#fff",
                  color: active ? "#fff" : "#111",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  width: isMobileUI ? "100%" : "auto",
                  minHeight: isMobileUI ? 42 : undefined,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {MODE_LABELS[m]}
              </button>
            );
          })}

          <button
            key="add-minutes"
            onClick={() => {
              setShowModePicker(false);
              try { beginPaygoTopupForMember(); } catch (e) {}
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid #ddd",
              background: "#fff",
              color: "#111",
              cursor: "pointer",
              whiteSpace: "nowrap",
              width: isMobileUI ? "100%" : "auto",
              minHeight: isMobileUI ? 42 : undefined,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Add Minutes
          </button>

          {/* Upgrade is always available (white-label URL override via rebrandingKey). */}
          <button
            key="upgrade"
            onClick={() => {
              setShowModePicker(false);
              try {
                openUpgradeUrl();
              } catch (e) {}

              // Start upgrade polling so plan changes apply without refresh.
              try {
                startUpgradeWatch("upgrade_button");
              } catch (e) {}
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid #ddd",
              background: "#fff",
              color: "#111",
              cursor: "pointer",
              whiteSpace: "nowrap",
              width: isMobileUI ? "100%" : "auto",
              minHeight: isMobileUI ? 42 : undefined,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Upgrade
          </button>

          {showBroadcastButton ? (
            <button
              key="broadcast"
              onClick={() => {
                void toggleBroadcastOverlay();
              }}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: showBroadcasterOverlay ? "#111" : "#fff",
                color: showBroadcasterOverlay ? "#fff" : "#111",
                cursor: "pointer",
                whiteSpace: "nowrap",
                opacity: broadcastPreparing ? 0.75 : 1,
              }}
              disabled={broadcastPreparing}
              aria-pressed={showBroadcasterOverlay}
              title="Show/Hide Broadcast UI"
            >
              {broadcastPreparing ? "Broadcast…" : "Broadcast"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );

  const handleAnyUserGesture = useCallback(() => {
    void primeLocalTtsAudio(true);
    void nudgeAudioSession();
    void ensureIphoneAudioContextUnlocked();
  }, [primeLocalTtsAudio, nudgeAudioSession, ensureIphoneAudioContextUnlocked]);

  const usageMeterEl = useMemo(() => {
    const used = Number((sessionState as any)?.minutes_used ?? (sessionState as any)?.minutesUsed ?? 0) || 0;
    const remaining = Number((sessionState as any)?.minutes_remaining ?? (sessionState as any)?.minutesRemaining ?? 0) || 0;
    const remainingSeconds = Number((sessionState as any)?.remaining_seconds ?? (sessionState as any)?.remainingSeconds ?? NaN);
    const allowed = Number((sessionState as any)?.minutes_allowed ?? (sessionState as any)?.minutesAllowed ?? 0) || 0;
    const total = Number((sessionState as any)?.minutes_total ?? (sessionState as any)?.minutesTotal ?? allowed ?? 0) || 0;
    const stableTotal = total > 0 ? total : Math.max(allowed, used + remaining);
    if (!stableTotal || stableTotal <= 0) return null;

    const exhausted = Boolean((sessionState as any)?.minutes_exhausted ?? (sessionState as any)?.minutesExhausted);
    const remainingFromSeconds = Number.isFinite(remainingSeconds)
      ? Math.max(0, Math.ceil(Math.max(0, remainingSeconds) / 60))
      : 0;
    const remainingComputed = exhausted
      ? 0
      : remaining > 0
        ? remaining
        : remainingFromSeconds > 0
          ? remainingFromSeconds
          : Math.max(0, stableTotal - used);
    const usedDisplay = exhausted ? stableTotal : Math.min(stableTotal, Math.max(used, stableTotal - remainingComputed));
    const pct = Math.max(0, Math.min(1, usedDisplay / stableTotal));
    const pctLabel = `${Math.round(pct * 100)}%`;

    return (
      <div style={{ marginTop: 8, maxWidth: isMobileUI ? "100%" : 440 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 10,
            fontSize: 16,
            color: "#666",
          }}
        >
          <span style={{ fontWeight: 700 }}>Usage</span>
          <span style={{ whiteSpace: "nowrap" }}>
            {usedDisplay} / {stableTotal} min • {remainingComputed} left
          </span>
        </div>

        <div
          role="progressbar"
          aria-label={`Usage: ${used} of ${stableTotal} minutes`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
          style={{
            marginTop: 4,
            height: ui.usageBarHeight,
            borderRadius: 999,
            background: "rgba(0,0,0,0.12)",
            overflow: "hidden",
          }}
          title={`${used}/${stableTotal} min (${pctLabel})`}
        >
          <div
            style={{
              width: `${Math.round(pct * 100)}%`,
              height: "100%",
              background: "rgba(0,0,0,0.65)",
            }}
          />
        </div>
      </div>
    );
  }, [
    sessionState,
    isMobileUI,
    ui.meta,
    ui.usageBarHeight,
  ]);

  const topupMinutesTotal = Math.max(1, Number(topupUnits || 1) || 1) * Math.max(1, Number(topupMinutesPerUnit || 30) || 30);
  const topupEstimatedUnitAmountCents = /dulcemoon/i.test(String(companyName || rebranding || "")) ? 699 : 499;
  const topupPriceText = formatCents(
    topupAmountTotalCents > 0 ? topupAmountTotalCents : topupEstimatedUnitAmountCents * Math.max(1, Number(topupUnits || 1) || 1),
    topupCurrency || "usd"
  );

  return (
    <main onPointerDown={handleAnyUserGesture} onTouchStart={handleAnyUserGesture} onClick={handleAnyUserGesture} style={mainContainerStyle}>

{startupOverlayOpen ? (
  <div
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 1000001,
      background: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "all",
    }}
  >
    <div
      style={{
        padding: "12px 16px",
        borderRadius: 14,
        background: "#111827",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.18)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        fontSize: 16,
        fontWeight: 700,
        letterSpacing: 0.2,
        maxWidth: "min(92vw, 520px)",
        textAlign: "center",
      }}
    >
      {startupOverlayName ? `...waiting on ${startupOverlayName}` : "Loading Connect..."}
    </div>
  </div>
) : null}
      {/* Hidden audio element for audio-only TTS (mic mode) */}
      <audio ref={localTtsAudioRef} style={{ display: "none" }} />
      {/* Hidden video element used on iOS to play audio-only TTS reliably (matches Live Avatar routing) */}
      <video
        ref={localTtsVideoRef}
        playsInline
        preload="auto"
        style={{ position: "fixed", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
      />
      {topupModalOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: topupStage === "checkout" ? "flex-start" : "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: isMobileUI ? "10px 10px calc(18px + env(safe-area-inset-bottom))" : 16,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch" as any,
            overscrollBehavior: "contain",
          }}
          onClick={() => {
            if (topupStage !== "creating" && topupStage !== "checkout") closeTopupModal();
          }}
        >
          <div
            style={{
              width: topupStage === "checkout" ? "min(760px, 100%)" : "min(560px, 100%)",
              background: "#111827",
              color: "#ffffff",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: 16,
              boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
              maxHeight: "calc(100dvh - 20px)",
              overflowY: "auto",
              WebkitOverflowScrolling: "touch" as any,
              overscrollBehavior: "contain",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {topupStage === "collect_email" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Add Connect Voice Minutes</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35, marginBottom: 12 }}>
                  Each unit adds <b>{topupMinutesPerUnit}</b> minutes. Increase the unit count if you want to buy more.
                  {topupRequiresEmail ? (
                    <>
                      <br />
                      Enter the <b>email you will use during checkout</b> so your visitor minutes can be credited.
                    </>
                  ) : null}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <label style={{ fontWeight: 800, fontSize: 13, minWidth: 90 }}>Units</label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    step={1}
                    value={topupUnits}
                    onChange={(e) => {
                      const n = Math.max(1, Math.min(12, Number(e.target.value || 1) || 1));
                      setTopupUnits(n);
                      setTopupError("");
                    }}
                    style={{
                      width: 92,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      outline: "none",
                    }}
                  />
                  <div style={{ opacity: 0.9, fontSize: 13 }}>
                    {topupMinutesTotal} minutes{topupPriceText ? ` • ${topupPriceText}` : ""}
                  </div>
                </div>

                {topupRequiresEmail ? (
                  <>
                    <div
                      style={{
                        marginBottom: 12,
                        padding: 12,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.14)",
                        background: "rgba(255,255,255,0.06)",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Want 1-click top-ups?</div>
                      <div style={{ opacity: 0.9, fontSize: 12, lineHeight: 1.35 }}>
                        Become a member to top up without typing your email. Members get instant credit after payment.
                      </div>
                      <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={() => handleBecomeMemberCta()}
                          style={{
                            padding: "9px 11px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "rgba(255,255,255,0.10)",
                            color: "#ffffff",
                            cursor: "pointer",
                            fontWeight: 800,
                          }}
                          title="Upgrade or sign up to remove the email step"
                        >
                          Upgrade / Sign up
                        </button>
                      </div>
                    </div>

                    <input
                      type="text"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={topupEmail}
                      onChange={(e) => {
                        setTopupEmail(e.target.value);
                        setTopupError("");
                      }}
                      placeholder="you@example.com"
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(255,255,255,0.06)",
                        color: "#fff",
                        outline: "none",
                        marginBottom: 10,
                      }}
                    />
                  </>
                ) : null}

                {topupError ? (
                  <div style={{ color: "#ffb4b4", fontSize: 12, marginBottom: 10, lineHeight: 1.35 }}>
                    {topupError}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => void startPaygoTopupForVisitor()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.10)",
                      color: "#ffffff",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Continue to payment
                  </button>

                  <button
                    type="button"
                    onClick={() => closeTopupModal()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : topupStage === "creating" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Preparing checkout…</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35 }}>
                  Creating a secure Stripe Embedded Checkout session inside Connect.
                </div>
              </>
            ) : topupStage === "checkout" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Secure checkout</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35, marginBottom: 10 }}>
                  Complete payment below without leaving Connect.
                </div>
                {topupError ? (
                  <div style={{ color: "#ffe082", fontSize: 12, marginBottom: 10, lineHeight: 1.35 }}>{topupError}</div>
                ) : null}
                <div
                  ref={topupCheckoutContainerRef}
                  style={{
                    height: "min(780px, calc(100dvh - 190px))",
                    minHeight: "min(520px, calc(100dvh - 190px))",
                    borderRadius: 12,
                    background: "#ffffff",
                    overflowY: "auto",
                    WebkitOverflowScrolling: "touch" as any,
                    overscrollBehavior: "contain",
                    marginBottom: 12,
                  }}
                />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {false && topupHostedUrl ? (
                    <button
                      type="button"
                      onClick={() => {
                        setTopupStage("waiting");
                        openPaygoUrl(topupHostedUrl);
                        setMemberTopupStartedAt(Date.now());
                        setMemberTopupWatching(true);
                      }}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(255,255,255,0.10)",
                        color: "#ffffff",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Open hosted checkout
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => closeTopupModal()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : topupStage === "waiting" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Waiting for payment…</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35, marginBottom: 10 }}>
                  Once Stripe confirms payment, minutes will be credited automatically. If a hosted checkout tab opened, return here after checkout completes.
                </div>

                {topupError ? (
                  <div style={{ color: "#ffe082", fontSize: 12, marginBottom: 10, lineHeight: 1.35 }}>
                    {topupError}
                  </div>
                ) : null}

                {topupExpiresAt ? (
                  <div style={{ opacity: 0.8, fontSize: 12, marginBottom: 10 }}>
                    Pending expires at: {new Date(topupExpiresAt * 1000).toLocaleString()}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => openPaygoUrl(topupPayUrl || String(rebrandingInfo?.payGoLink || "").trim())}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.10)",
                      color: "#ffffff",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Open payment
                  </button>

                  <button
                    type="button"
                    onClick={() => closeTopupModal()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : topupStage === "error" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Top-up issue</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35, marginBottom: 10 }}>
                  {topupError || "Something went wrong while setting up your top-up."}
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setTopupError("");
                      setTopupStage("collect_email");
                    }}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.10)",
                      color: "#ffffff",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Try again
                  </button>

                  <button
                    type="button"
                    onClick={() => closeTopupModal()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : topupStage === "credited" ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Minutes added ✅</div>
                <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.35, marginBottom: 10 }}>
                  {topupLastCreditedMinutes
                    ? `${topupLastCreditedMinutes} minutes have been added. You can continue chatting.`
                    : "Your minutes have been added. You can continue chatting."}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => closeTopupModal()}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.10)",
                      color: "#ffffff",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {showPlayChoiceModal && isHost ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
          onClick={() => setShowPlayChoiceModal(false)}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              background: "#111827",
              color: "#ffffff",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: 16,
              boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Start a session</div>
            <div style={{ opacity: 0.85, fontSize: 13, marginBottom: 14 }}>
              Choose <b>Stream</b> or <b>Private</b>. You can&apos;t run both at the same time.
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#ffffff",
                  background: "rgba(255,255,255,0.06)",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setShowPlayChoiceModal(false);
                  void startLiveAvatar();
                }}
              >
                Stream
              </button>

              <button
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setShowPlayChoiceModal(false);
                  void startConferenceSession();
                }}
              >
                Private
              </button>

              <button
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#ffffff",
                  background: "transparent",
                  cursor: "pointer",
                }}
                onClick={() => setShowPlayChoiceModal(false)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      ) : null}

      <header
        style={{
          display: "flex",
          flexDirection: isMobileUI ? "column" : "row",
          alignItems: "flex-start",
          gap: isMobileUI ? 10 : 12,
          marginBottom: isMobileUI ? 10 : 10,
          flexWrap: isMobileUI ? "nowrap" : "wrap",
          rowGap: isMobileUI ? 8 : 0,
          width: "100%",
        }}
      >
        {isMobileUI ? (
          <>
            <div style={{ width: "100%", minWidth: 0 }}>
              <div
                style={{
                  marginBottom: 2,
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: 0.7,
                  textTransform: "uppercase",
                  color: "#666",
                }}
              >
                {isElaraloBrandName(companyName) ? (
                  <a
                    href="https://www.elaralo.com/"
                    target="_top"
                    style={{ color: "inherit", textDecoration: "none", cursor: "pointer" }}
                    aria-label="Open Elaralo home page"
                  >
                    {companyName}
                  </a>
                ) : (
                  companyName
                )}
              </div>
              <h1 style={{ margin: 0, fontSize: Math.max(ui.title, 28), lineHeight: 1.08 }}>
                {companionName || DEFAULT_COMPANION_NAME}
              </h1>
              <div style={{ marginTop: 5, fontSize: ui.meta, color: "#666", lineHeight: 1.35 }}>
                {String((companionMapping?.companion_type ?? companionMapping?.companionType ?? "") || "").toLowerCase() === "human"
                  ? "Human Companion"
                  : "AI Companion"}
              </div>
              <div style={{ fontSize: ui.meta, color: "#666", lineHeight: 1.35 }}>
                Plan: <b>{displayPlanLabel(planName, memberId, planLabelOverride, loggedIn)}</b>
              </div>
              <div style={{ fontSize: ui.meta, color: "#666", lineHeight: 1.35 }}>
                Mode: <b>{MODE_LABELS[effectiveActiveMode]}</b>
                {chatStatus === "explicit_allowed" ? (
                  <span style={{ marginLeft: 8, color: "#0a7a2f" }}>• Consent: Allowed</span>
                ) : chatStatus === "explicit_blocked" ? (
                  <span style={{ marginLeft: 8, color: "#b00020" }}>• Consent: Required</span>
                ) : null}
              </div>
              <div style={{ fontSize: ui.meta, color: "#666", lineHeight: 1.35 }}>
                {String((companionMapping?.companion_type ?? companionMapping?.companionType ?? "") || "").toLowerCase() === "human"
                  ? "Live Companion"
                  : "Live Avatar"}: {" "}
                <b
                  style={{
                    color:
                      avatarStatus === "connected"
                        ? "#0a7a2f"
                        : avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting"
                          ? "#0d47a1"
                          : avatarStatus === "error"
                            ? "#b00020"
                            : "#666",
                  }}
                >
                  {avatarStatus}
                </b>
                {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
              </div>
            </div>

            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <div style={{ flex: "1 1 auto", minWidth: 0, maxWidth: 180 }}>
                <div
                  aria-hidden
                  onClick={secretDebugTap}
                  style={{
                    width: 118,
                    height: 148,
                    borderRadius: 16,
                    overflow: "hidden",
                    border: "1px solid rgba(17,17,17,0.14)",
                    background: "#fff",
                    boxSizing: "border-box",
                  }}
                >
                  <img
                    src={((avatarSrc && avatarSrc !== DEFAULT_AVATAR) ? avatarSrc : companyLogoSrc) || DEFAULT_AVATAR}
                    alt={companyName}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    onError={(e) => {
                      const fallback = (companyLogoSrc || DEFAULT_AVATAR);
                      const current = String((e.currentTarget as HTMLImageElement).src || avatarSrc || "").trim();
                      (e.currentTarget as HTMLImageElement).src = fallback;
                      if (isCompanionImageUrl(current)) return;
                      setAvatarSrc(fallback);
                    }}
                  />
                </div>
                <div style={{ marginTop: 2 }}>{usageMeterEl}</div>
              </div>

              <div
                style={{
                  flex: "0 0 140px",
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "stretch",
                }}
              >
                {modePillControls}
              </div>
            </div>

            {liveProvider === "stream" ? (
              <div style={{ marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {sessionActive && !hostInStreamUi && !viewerInStreamUi ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "#e8f5e9",
                      color: "#1b5e20",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    ● Live {sessionKind === "conference" ? "private" : "stream"} active
                  </span>
                ) : null}
                {!!livekitToken ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "#e3f2fd",
                      color: "#0d47a1",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    ● {hostInStreamUi
                      ? `Hosting ${sessionKind === "conference" ? "private" : "live"} ${sessionKind === "conference" ? "conference" : "stream"}`
                      : `Joined ${sessionKind === "conference" ? "private" : "live"} ${sessionKind === "conference" ? "conference" : "stream"}`}
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div
              aria-hidden
              onClick={secretDebugTap}
              style={{
                width: isTabletUI ? 84 : 92,
                height: isTabletUI ? 112 : 118,
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid rgba(17,17,17,0.14)",
                background: "#fff",
                boxSizing: "border-box",
                flex: "0 0 auto",
              }}
            >
              <img
                src={((avatarSrc && avatarSrc !== DEFAULT_AVATAR) ? avatarSrc : companyLogoSrc) || DEFAULT_AVATAR}
                alt={companyName}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                onError={(e) => {
                  const fallback = (companyLogoSrc || DEFAULT_AVATAR);
                  const current = String((e.currentTarget as HTMLImageElement).src || avatarSrc || "").trim();
                  (e.currentTarget as HTMLImageElement).src = fallback;
                  if (isCompanionImageUrl(current)) return;
                  setAvatarSrc(fallback);
                }}
              />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: ui.title }}>
                {isElaraloBrandName(companyName) ? (
                  <a
                    href="https://www.elaralo.com/"
                    target="_top"
                    style={{ color: "inherit", textDecoration: "none", cursor: "pointer" }}
                    aria-label="Open Elaralo home page"
                  >
                    {companyName}
                  </a>
                ) : (
                  companyName
                )}
              </h1>
              <div style={{ fontSize: ui.meta, color: "#666" }}>
                Companion: <b>{companionName || DEFAULT_COMPANION_NAME}</b> • Plan:{" "}
                <b>{displayPlanLabel(planName, memberId, planLabelOverride, loggedIn)}</b>
              </div>
              <div style={{ fontSize: ui.meta, color: "#666" }}>
                Mode: <b>{MODE_LABELS[effectiveActiveMode]}</b>
                {chatStatus === "explicit_allowed" ? (
                  <span style={{ marginLeft: 8, color: "#0a7a2f" }}>• Consent: Allowed</span>
                ) : chatStatus === "explicit_blocked" ? (
                  <span style={{ marginLeft: 8, color: "#b00020" }}>• Consent: Required</span>
                ) : null}
              </div>
              <div style={{ fontSize: ui.meta, color: "#666" }}>
                {String((companionMapping?.companion_type ?? companionMapping?.companionType ?? "") || "").toLowerCase() === "human" ? "Live Companion" : "Live Avatar"}: {" "}
                <b>{avatarStatus}</b>
                {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
              </div>
              {usageMeterEl}
              {liveProvider === "stream" ? (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {sessionActive && !hostInStreamUi && !viewerInStreamUi ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "#e8f5e9",
                        color: "#1b5e20",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      ● Live {sessionKind === "conference" ? "private" : "stream"} active
                    </span>
                  ) : null}
                  {!!livekitToken ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "#e3f2fd",
                        color: "#0d47a1",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      ● {hostInStreamUi
                        ? `Hosting ${sessionKind === "conference" ? "private" : "live"} ${sessionKind === "conference" ? "conference" : "stream"}`
                        : `Joined ${sessionKind === "conference" ? "private" : "live"} ${sessionKind === "conference" ? "conference" : "stream"}`}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </header>

{companionMappingError ? (
  <div
    style={{
      margin: "10px 0",
      padding: "10px 12px",
      borderRadius: 10,
      background: "#ffebee",
      color: "#b71c1c",
      fontSize: 13,
      fontWeight: 700,
      lineHeight: 1.35,
    }}
  >
    {companionMappingError}
  </div>
) : null}

{showConnectControls ? (
  <section
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      marginBottom: 12,
      flexWrap: "wrap",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {showPlayButton ? (
      <button
        onClick={() => {
          // Stream provider: Play = join/start. It must NOT toggle to Pause.
          // Leaving the session is done exclusively via Stop.
          if (liveProvider === "stream") {
            if (viewerHasJoinedStream || (avatarStatus !== "idle" && avatarStatus !== "error")) return;

            // If a conference is active, Play joins it (no STT).
            if (sessionActive && sessionKind === "conference") {
              conferenceOptOutRef.current = false;
              void startConferenceSession();
              return;
            }

            // Host-only: when idle, prompt for Stream vs Conference.
            if (isHost && !sessionActive) {
              // New live session: clear any leftover live-sharing UI from the prior run.
              setMessages([]);
              setLiveSharingNotice(null);
              setShowPlayChoiceModal(true);
              return;
            }

            void startLiveAvatar();
            return;
          }

          if (
            avatarStatus === "connected" ||
            avatarStatus === "connecting" ||
            avatarStatus === "reconnecting"
          ) {
            void stopLiveAvatar();
          } else {
            void (async () => {
              // Live Avatar requires microphone / STT. Start it automatically.
              // If iOS audio-only backend STT is currently running, restart in browser STT for Live Avatar.
              if (sttEnabledRef.current && useBackendStt) {
                stopSpeechToText();
              }

              if (!sttEnabledRef.current) {
                await startSpeechToText({ forceBrowser: true, suppressGreeting: true });
              }

              // If mic permission was denied, don't start Live Avatar.
              if (!sttEnabledRef.current) return;

              await startLiveAvatar();
            })();
          }
        }}
        disabled={liveProvider === "stream" ? (viewerHasJoinedStream || (avatarStatus !== "idle" && avatarStatus !== "error")) : false}
        style={{
          width: ICON_BTN_SIZE,
          height: ICON_BTN_SIZE,
          minWidth: ICON_BTN_SIZE,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: 10,
          border: "1px solid #111",
          boxSizing: "border-box",
          background: "#fff",
          color: "#111",
          cursor:
            liveProvider === "stream" && (viewerHasJoinedStream || (avatarStatus !== "idle" && avatarStatus !== "error"))
              ? "not-allowed"
              : "pointer",
          opacity:
            liveProvider === "stream" && (viewerHasJoinedStream || (avatarStatus !== "idle" && avatarStatus !== "error")) ? 0.6 : 1,
          fontWeight: 700,
        }}
        aria-label={
          liveProvider === "stream"
            ? viewerHasJoinedStream
              ? "Already joined"
              : "Join live stream"
            : avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting"
              ? "Stop Live Avatar"
              : "Start Live Avatar"
        }
        title={viewerHasJoinedStream ? "Already joined. Press Stop to leave." : "Video"}
      >
        {liveProvider === "stream" ? (
          <PlayIcon size={ICON_18} />
        ) : avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" ? (
          <PauseIcon size={ICON_18} />
        ) : (
          <PlayIcon size={ICON_18} />
        )}
      </button>
      ) : null}

      
      {/* When a Live Avatar is available, place mic/stop controls to the right of play/pause */}
      {sttControls}
	      {liveProvider === "stream" &&
	        ((isHost &&
	          ((sessionKind === "conference" && Boolean(livekitToken)) ||
	            (sessionKind === "stream" && sessionActive))) ||
	          (!isHost && sessionKind === "conference" && Boolean(livekitToken))) ? (	          <button
	            type="button"
	            onClick={async () => {
	              const next = !livekitMicEnabled;
	              if (next) {
	                const ok = await requestLivekitAvPermissions({
	                  audio: true,
	                  video: sessionKind === "conference",
	                  reason: "enabling microphone/camera",
	                });
	                if (!ok) return;
	              }
	              setLivekitMicEnabled(next);
	              if (sessionKind === "conference") {
	                setLivekitCameraEnabled(next);
	              }
	            }}
	            style={{
	              ...smallBtn,
	              background: livekitMicEnabled ? "#1b5e20" : "#eee",
	              color: livekitMicEnabled ? "#fff" : "#222",
	            }}
	            title={livekitMicEnabled ? "Mute Mic" : "Unmute Mic"}
	          >
	            🎙️ {livekitMicEnabled ? "Mic On" : "Mic Off"}
	          </button>
	        ) : null}

	      {liveProvider === "stream" && sessionKind === "conference" && Boolean(livekitToken) ? (
	        <button
	          type="button"
	          onClick={() => {
	            setConferenceViewMode((v) => (v === "split" ? "focus" : "split"));
	          }}
	          style={{
	            ...smallBtn,
	            background: conferenceViewMode === "focus" ? "#111" : "#eee",
	            color: conferenceViewMode === "focus" ? "#fff" : "#222",
	          }}
	          title={
	            conferenceViewMode === "focus"
	              ? "Show split view (both participants)"
	              : "Show full view (other participant only)"
	          }
	        >
	          {conferenceViewMode === "focus" ? "👥 Split View" : "🖥️ Full View"}
	        </button>
	      ) : null}
{liveProvider === "stream" &&
        ((isHost && sessionActive) ||
          (!isHost &&
            (viewerHasJoinedStream || conferenceJoined || livekitJoinStatus === "pending"))) ? (
        <button
          type="button"
          onClick={() => {
            stopLiveAvatar();
          }}
          style={{
            ...smallBtn,
            background: "#b00020",
            color: "#fff",
          }}
          title={isHost ? "Stop live session" : "Leave session"}
        >
          <StopIcon size={ICON_18} />
        </button>
      ) : null}

      {liveProvider === "stream" && !isHost ? (
        <button
          type="button"
          onClick={changeViewerLiveChatName}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            margin: 0,
            fontSize: 12,
            color: "#111",
            textDecoration: "underline",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
          aria-label="Change username"
          title="Change the name shown to others during the live session"
        >
          {String(preferredViewerDisplayName || "").trim() ? "Change username" : "Set username"}
        </button>
      ) : null}

    </div>

    {/* Right-justified Mode controls remain in this row on tablet/desktop.
        On mobile they are rendered beside the avatar in the companion card. */}
    {!isMobileUI ? modePillControls : null}
  </section>
) : null}

      <section style={{ marginTop: 18 }}>
        <div
          style={{
            display: "flex",
            gap: 18,
            marginTop: 18,
            flexWrap: "wrap",
            alignItems: "flex-start",
          }}
        >
          {showAvatarFrame ? (
            <div
	              style={{
	                flex:
	                  liveProvider === "stream" && sessionKind === "conference"
	                    ? "2 1 0"
	                    : liveProvider === "stream" && !isHost
	                      ? "2 1 0"
	                      : "0 0 360px",
                minWidth: liveProvider === "stream" && !isHost ? 320 : 280,
                maxWidth: "100%",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: 440,
                  background: "#000",
                  border: "1px solid #e5e5e5",
                  borderRadius: 12,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                {livekitToken ? (
                  <LiveKitRoom
                    token={livekitToken}
                    serverUrl={livekitServerUrl || LIVEKIT_URL}
                    connect={Boolean(livekitToken)}
	                    audio={(sessionKind === "conference" ? true : isHost) && livekitMicEnabled}
	                    video={(sessionKind === "conference" ? true : isHost) && (sessionKind === "conference" ? livekitCameraEnabled : true)}
                    onConnected={() => {
	                      // Host: once connected we treat the session as active.
	                      if (isHost) setSessionActive(true);
                      // Conference: track that we've joined the room.
                      if (sessionKind === "conference") setConferenceJoined(true);
                    }}
                    onDisconnected={() => {
                      // If the host ends the session, viewers are kicked from the room.
                      // Mirror the Stop button behavior so the viewer UI fully exits.
                      if (!stopInProgressRef.current && !isHost) {
                        void stopConferenceSession();
                        return;
                      }

                      setConferenceJoined(false);
                      setLivekitToken(null);
                      setLivekitRole(null);
                      // Viewer disconnect should not mark the session inactive globally;
                      // the status poller will reflect whether the host is still live.
                      if (isHost) setSessionActive(false);
                    }}
                    style={{ width: "100%", height: "100%" }}
                  >
                    <LiveKitAutoPublish
                      enabled={sessionKind === "conference" ? true : isHost}
                      micEnabled={(sessionKind === "conference" ? true : isHost) && livekitMicEnabled}
                      cameraEnabled={(sessionKind === "conference" ? true : isHost) && (sessionKind === "conference" ? livekitCameraEnabled : true)}
                      onError={(msg) => setStreamNotice(msg)}
                    />
	                    {sessionKind === "conference" ? (
	                      <LiveKitPrivateConferenceStage viewMode={conferenceViewMode} />
	                    ) : livekitRole === "viewer" && sessionKind === "stream" ? (
	                      <LiveKitStreamViewerStage />
	                    ) : (
	                      <VideoConference
	                        chatMessageFormatter={undefined as any}
	                        onError={(e: any) => {
	                          console.warn("LiveKit UI error", e);
	                        }}
	                      />
	                    )}

                    {livekitRole === "viewer" && (sessionKind === "stream" || sessionKind === "conference") ? null : <StartAudio label="Enable audio" />}

						{livekitRole === "host" && livekitPendingUnique.length > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          pointerEvents: "none",
                          display: "flex",
                          alignItems: "flex-end",
                          justifyContent: "center",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            background: "rgba(0,0,0,0.65)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 12,
                            padding: 14,
                            maxWidth: 340,
                            width: "100%",
                            pointerEvents: "auto",
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>Join Requests</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
							{livekitPendingUnique.map((req) => (
                              <div
                                key={req.requestId}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 10,
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <div
                                    style={{
                                      fontWeight: 600,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {req.viewerLabel || "Viewer"}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12,
                                      opacity: 0.85,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {req.identity}
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                                  <button
                                    onClick={() => {
                                      void denyLivekit(req.requestId);
                                      setLivekitPending((p) => p.filter((x) => x.requestId !== req.requestId));
                                    }}
                                    style={{
                                      padding: "6px 10px",
                                      borderRadius: 10,
                                      border: "1px solid rgba(255,255,255,0.25)",
                                      background: "transparent",
                                      color: "#fff",
                                      cursor: "pointer",
                                      fontWeight: 700,
                                    }}
                                  >
                                    Deny {req.viewerLabel}
                                  </button>
                                  <button
                                    onClick={() => {
                                      void admitLivekit(req.requestId);
                                      setLivekitPending((p) => p.filter((x) => x.requestId !== req.requestId));
                                    }}
                                    style={{
                                      padding: "6px 10px",
                                      borderRadius: 10,
                                      border: "1px solid rgba(255,255,255,0.25)",
                                      background: "#fff",
                                      color: "#111",
                                      cursor: "pointer",
                                      fontWeight: 800,
                                    }}
                                  >
                                    Admit {req.viewerLabel}
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {(livekitRole === "viewer" && sessionKind === "conference" && !conferenceJoined) ||
                    (livekitRole === "viewer" && sessionKind === "conference" && livekitJoinRequestId) ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 16,
                          textAlign: "center",
                        }}
                      >
                        <div
                          style={{
                            background: "rgba(0,0,0,0.65)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 12,
                            padding: 14,
                            maxWidth: 340,
                            color: "#fff",
                          }}
                        >
                          <div style={{ fontWeight: 800, marginBottom: 6 }}>
                            {livekitJoinRequestId ? "Request sent" : "Private session"}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.9 }}>
                            {livekitJoinRequestId
                              ? "Waiting for the host to admit you…"
                              : "Press Play to request to join."}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </LiveKitRoom>
                ) : liveProvider === "stream" ? (
                  sessionKind === "stream" && livekitHlsUrl ? (
                    <LiveKitHlsPlayer src={livekitHlsUrl} />
                  ) : !(
                      avatarStatus === "connecting" ||
                      avatarStatus === "reconnecting" ||
                      (avatarStatus === "waiting" &&
                        !(liveProvider === "stream" &&
                          sessionKind === "conference" &&
                          livekitRole === "viewer" &&
                          Boolean(livekitJoinRequestId)))
                    ) ? (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        padding: 16,
                        textAlign: "center",
                        background: "rgba(0,0,0,0.6)",
                      }}
                    >
                      {sessionActive
                        ? isHost
                          ? sessionKind === "conference"
                            ? "Press Play to re-join your Private session."
                            : "Press Play to re-join your live stream."
                          : sessionKind === "conference"
                            ? livekitJoinRequestId
                              ? "Request sent — waiting for the host to admit you…"
                              : "Press Play to request access to Private."
                            : "Press Play to join the live stream."
                        : isHost
                        ? "Press Play to start a session."
                        : "Host is offline."}
                    </div>
                  ) : null
                ) : null}

				{showAvatarFrame && (avatarStatus === "connecting" || avatarStatus === "waiting" || avatarStatus === "reconnecting") && !(liveProvider === "stream" && sessionKind === "conference" && livekitRole === "viewer" && Boolean(livekitJoinRequestId)) ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0,0,0,0.35)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontWeight: 600,
                      padding: 16,
                      textAlign: "center",
                    }}
                  >
                    {avatarStatus === "connecting"
                      ? "Starting live session…"
                      : avatarStatus === "waiting"
                      ? "Waiting for host…"
                      : avatarStatus === "reconnecting"
                      ? "Reconnecting…"
                      : "Live session ended"}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div
                    style={{
	                    flex: showAvatarFrame
	                      ? (liveProvider === "stream" && sessionKind === "conference"
	                          ? "1 1 0"
	                          : liveProvider === "stream" && Boolean(streamEventRef) && !streamCanStart
	                            ? "1 1 0"
	                            : "2 1 0")
	                      : "1 1 0",
                      minWidth: 280,
                      height: conversationHeight,
                      display: "flex",
                      flexDirection: "column",
                      position: "relative",
                    }}
                  >
                    <div
                      ref={messagesBoxRef}
                      style={{
                        flex: "1 1 auto",
                        border: "1px solid #e5e5e5",
                        borderRadius: 12,
                        padding: 12,
                        overflowY: "auto",
                        background: "#fff",
                      }}
                    >

                      {!isHost && Boolean((sessionState as any)?.host_override_active) ? (
                        <div
                          style={{
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "rgba(0,0,0,0.25)",
                            marginBottom: 10,
                            fontSize: 14,
                          }}
                        >
                          <b>Host override active.</b> You are now chatting with a human companion.
                        </div>
                      ) : null}

                      {(livekitUiActive
                        ? messages.filter((x: any) => Boolean((x as any)?.meta?.liveChat))
                        : messages.filter((x: any) => !Boolean((x as any)?.meta?.liveChat))
                      ).map((m, i) => {
                        const meta: any = (m as any).meta;
                        
                        const isHostMsg =
                          m.role === "assistant" && String(meta?.sender || "") === "host";
                        const isSystemMsg =
                          m.role === "assistant" && String(meta?.sender || "") === "system";
                        const displayName =
                          meta?.liveChat && meta?.name
                            ? String(meta.name)
                            : m.role === "assistant"
                            ? isSystemMsg
                              ? "System"
                              : isHostMsg
                                ? `${(companionName || DEFAULT_COMPANION_NAME)} (Host)`
                                : (companionName || DEFAULT_COMPANION_NAME)
                            : transcriptViewerLabel;

                        return (
                          <div
                            key={i}
                            style={{
                              marginBottom: 10,
                              whiteSpace: "pre-wrap",
                              color: m.role === "assistant" ? "#111" : "#333",
                            }}
                          >
                            <b>{displayName}:</b> {renderMsgContent(m)}
                          </div>
                        );
                      })}
                      {!livekitUiActive && loading ? (
                        <div style={{ color: "#666" }}>Thinking…</div>
                      ) : null}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center", position: "sticky", bottom: 0, background: "#fff", paddingTop: 10, paddingBottom: 10, zIndex: 20, borderTop: "1px solid #eee" }}>
                      {/** Input line with mode pills moved to the right (layout-only). */}

{isHostConsoleUser ? (
  <button
    type="button"
    onClick={() => {
      setHostConsoleOpen(true);
      setHostNotice("");
    }}
    style={{
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid rgba(255,255,255,0.35)",
      background: "rgba(0,0,0,0.22)",
      color: "white",
      cursor: "pointer",
    }}
    title="Host console (AI chat takeover)"
  >
    Host Console
  </button>
) : null}

                          <button
                            type="button"
                            onClick={requestClearMessages}
                            title="Clear"
                            aria-label="Delete"
                            style={{
                              width: ICON_BTN_SIZE,
                              height: ICON_BTN_SIZE,
                              borderRadius: 10,
                              border: "1px solid #bbb",
                              boxSizing: "border-box",
                              background: "#fff",
                              cursor: "pointer",
                              opacity: 1,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <TrashIcon size={ICON_18} />
                          </button>

                      {/* Attachment upload (images only) */}
                      <input
                        ref={uploadInputRef}
                        type="file"
                        accept="*/*"
                        style={{ display: "none" }}
                        onChange={onAttachmentSelected}
                      />
	                  <button
	                    onClick={openUploadPicker}
	                    disabled={attachmentButtonDisabled}
                        title={
                          uploadsDisabled || hostInStreamUi || viewerInStreamUi
                            ? "Attachments are disabled during Shared Live streaming."
                            : "Attach a file"
                        }
	                    style={{
	                      width: ICON_BTN_SIZE,
	                      height: ICON_BTN_SIZE,
	                      minWidth: ICON_BTN_SIZE,
	                      padding: 0,
	                      borderRadius: 10,
	                      border: "1px solid #bbb",
	                      boxSizing: "border-box",
	                      display: "inline-flex",
	                      alignItems: "center",
	                      justifyContent: "center",
	                      background: attachmentButtonDisabled ? "#e5e5e5" : "#fff",
	                      cursor: attachmentButtonDisabled ? "not-allowed" : "pointer",
	                      opacity: attachmentButtonDisabled ? 0.6 : 1,
	                      lineHeight: "18px",
	                      fontSize: 18,
	                    }}
                        type="button"
                      >
                        {uploadingAttachment ? "⏳" : "📎"}
                      </button>

                      {pendingAttachment && !uploadsDisabled && !hostInStreamUi && !viewerInStreamUi ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 8px",
                            border: "1px solid #e5e5e5",
                            borderRadius: 9999,
                            background: "#fff",
                            maxWidth: 320,
                          }}
                          title={pendingAttachment?.name || "attachment"}
                        >
                          <a href={pendingAttachment.url} target="_blank" rel="noopener noreferrer">
                            {pendingAttachment.contentType?.toLowerCase().startsWith("image/") ? (
                            <img
                              src={pendingAttachment.url}
                              alt={pendingAttachment.name}
                              style={{
                                width: 28,
                                height: 28,
                                objectFit: "cover",
                                borderRadius: 6,
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                border: "1px solid #e5e7eb",
                                background: "#fff",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 16,
                                lineHeight: "16px",
                              }}
                              title={pendingAttachment.contentType || "file"}
                            >
                              📎
                            </div>
                          )}
                          </a>
                          <a
                            href={pendingAttachment.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              fontSize: 12,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: 220,
                              color: "#111827",
                              textDecoration: "underline",
                            }}
                            title={pendingAttachment.url}
                          >
                            {pendingAttachment.name}
                          </a>
                          <button
                            onClick={clearPendingAttachment}
                            type="button"
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 9999,
                              border: "1px solid #ddd",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              lineHeight: 1,
                            }}
                            aria-label="Remove attachment"
                            title="Remove attachment"
                          >
                            ×
                          </button>
                        </div>
                      ) : uploadError && !uploadsDisabled && !hostInStreamUi && !viewerInStreamUi ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#b91c1c",
                            maxWidth: 320,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={uploadError}
                        >
                          {uploadError}
                        </div>
                      ) : null}

                      <input
                        ref={inputElRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            send();
                          }
                        }}
                        placeholder={
                          sttEnabled
                            ? "Listening…"
                            : !isHost && sessionActive && sessionKind === "conference" && !conferenceJoined
                            ? `${(companionName || "Host").trim() || "Host"} is in a private session — press Play to join.`
                            : !isHost && sessionActive && sessionKind !== "conference" && !viewerHasJoinedStream
                            ? `${(companionName || "Host").trim() || "Host"} is live — press Play to join.`
                            : "Click microphone or type message to talk with me…"
                        }
                        style={{
                          flex: 1,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                        }}
                      />

                      <button
                        onClick={() => send()}
                        disabled={loading || uploadingAttachment}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 10,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Send
                      </button>

                    </div>

          	          {sttError ? (
          	            <div style={{ marginTop: 6, fontSize: 12, color: "#b00020" }}>{sttError}</div>
          	          ) : null}

	          {/* Mobile: move the usage meter below the input box to maximize above-the-fold space. */}
	          {isMobileUI ? usageMeterEl : null}

                    {/* LiveKit Broadcast overlay (Host-only) */}
                    {showBroadcastButton && showBroadcasterOverlay ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          zIndex: 50,
                          borderRadius: 12,
                          overflow: "hidden",
                          background: "#0b0b0b",
                          border: "1px solid #e5e5e5",
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            padding: "10px 12px",
                            background: "#111",
                            color: "#fff",
                            borderBottom: "1px solid rgba(255,255,255,0.12)",
                          }}
                        >
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Broadcast (LiveKit)</div>

                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {livekitHlsUrl ? (
                              <span style={{ fontSize: 12, opacity: 0.85 }} title={livekitHlsUrl}>
                                HLS enabled
                              </span>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => void toggleBroadcastOverlay()}
                              style={{
                                padding: "8px 12px",
                                borderRadius: 10,
                                border: "1px solid #fff",
                                background: "transparent",
                                color: "#fff",
                                cursor: "pointer",
                                fontWeight: 800,
                                fontSize: 12,
                              }}
                              title="Stop broadcast"
                            >
                              Stop
                            </button>
                          </div>
                        </div>

                        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                          {broadcastPreparing ? (
                            <div
                              style={{
                                width: "100%",
                                height: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                padding: 16,
                                textAlign: "center",
                                color: "#fff",
                              }}
                            >
                              Preparing broadcast…
                            </div>
                          ) : broadcastError ? (
                            <div
                              style={{
                                width: "100%",
                                height: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                padding: 16,
                                textAlign: "center",
                                color: "#ffb4b4",
                              }}
                            >
                              Broadcast unavailable: {broadcastError}
                            </div>
                          ) : livekitToken && livekitRoomName ? (
                            <LiveKitRoom
                              token={livekitToken}
                              serverUrl={livekitServerUrl || LIVEKIT_URL}
                              connect={Boolean(livekitToken)}
                              audio={true}
                              video={true}
                              style={{ width: "100%", height: "100%" }}
                              onDisconnected={() => {
                                // If the backend stops the session, close the overlay UI.
                                setLivekitToken("");
                                setShowBroadcasterOverlay(false);
                                setSessionActive(false);
                                setSessionKind("");
                                setSessionRoom("");
                                setAvatarStatus("idle");
                              }}
                            >
                              {livekitRole === "viewer" && (sessionKind === "stream" || sessionKind === "conference") ? (
              <LiveKitStreamViewerStage />
            ) : (
              <VideoConference />
            )}
                            </LiveKitRoom>
                          ) : (
                            <div
                              style={{
                                width: "100%",
                                height: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                padding: 16,
                                textAlign: "center",
                                color: "#fff",
                              }}
                            >
                              No host token available. Click Broadcast again to retry.
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
      
        </div>
      </section>

      {/* Clear Messages confirmation overlay */}
      {showClearMessagesConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 10000,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 16,
              maxWidth: 520,
              width: "100%",
              boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Clear messages?</div>
            <div style={{ fontSize: 14, color: "#333", lineHeight: 1.4 }}>
              This will clear the conversation on your screen. All audio, video, and mic listening have been stopped. You can resume manually using the controls after closing this dialog.
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button
                type="button"
                onClick={() => {
                    setShowClearMessagesConfirm(false);
                    // User gesture: restore boosted routing so subsequent TTS isn't quiet.
                    try { boostAllTtsVolumes(); } catch (e) {}
                    // Restore audio routing/volume immediately.
                    void restoreVolumesAfterClearCancel();
                  }}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #bbb",
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  // Clear UI + any queued (live-session) messages.
                  streamDeferredQueueRef.current = [];
                  streamPreSessionHistoryRef.current = null;
                  prevSessionActiveRef.current = false;

                  setMessages([]);
                  autoSaveSummaryLastUserTurnsRef.current = 0;
                  autoSaveSummaryLastMsgLenRef.current = 0;
                  autoSaveSummaryLastAtRef.current = 0;
                  resetAutoSaveSummaryCycleState();
                  // Also reset any in-session summary digests so we don't leak old context into a new conversation.
                  setSessionState((prev) => ({
                    ...(prev as any),
                    conversation_summaries: [],
                    conversationSummaries: [],
                    summary_dropped_count: 0,
                    summaryDroppedCount: 0,
                  }));
                  try {
                    sessionStateRef.current = {
                      ...(sessionStateRef.current as any),
                      conversation_summaries: [],
                      conversationSummaries: [],
                      summary_dropped_count: 0,
                      summaryDroppedCount: 0,
                    } as any;
                  } catch (e) {}
                  setInput("");
                  try { if (inputElRef.current) inputElRef.current.value = ""; } catch (e) {}
                  setShowClearMessagesConfirm(false);
                  // User gesture: restore boosted routing so subsequent TTS isn't quiet.
                  try { boostAllTtsVolumes(); } catch (e) {}
                  // Re-prime audio outputs after a hard stop so Audio TTS doesn't come back quiet (iOS/Safari).
                  void restoreVolumesAfterClearCancel();
                }}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Yes, clear
              </button>
            </div>
          </div>
        </div>
      )}


{/* Host console overlay (AI chat takeover) */}
{hostConsoleOpen && isHostConsoleUser ? (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.55)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      zIndex: 50,
    }}
    onClick={() => setHostConsoleOpen(false)}
  >
    <div
      style={{
        width: "min(1200px, 100%)",
        maxHeight: "min(860px, 92vh)",
        overflow: "hidden",
        background: "rgba(20,20,24,0.98)",
        border: "1px solid rgba(255,255,255,0.22)",
        borderRadius: 14,
        padding: 14,
        color: "white",
      }}
      onClick={(e) => e.stopPropagation()}
    >

      {hostPendingModalOpen && hostPendingContent.length > 0 ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setHostPendingModalOpen(false)}
        >
          <div
            style={{
              width: "min(760px, 100%)",
              background: "#fff",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Scheduled content ready</div>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  This session is overridden. Push when you’re ready{" "}
                  {hostPendingContent.length > 1 ? `(${hostPendingContent.length} queued)` : ""}.
                </div>
              </div>
              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "transparent",
                  borderRadius: 8,
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setHostPendingModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              {(() => {
                const item = hostPendingContent[0];
                const msg = item?.content ? buildContentAssistantMsg(item.content) : null;

                return (
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
                      {item?.content?.stage ? `Stage: ${item.content.stage}` : ""}
                      {typeof item?.triggerMinute === "number" ? ` • Trigger minute: ${item.triggerMinute}` : ""}
                    </div>

                    <div style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 12 }}>
                      {msg ? renderMsgContent(msg) : <div style={{ fontSize: 13, opacity: 0.8 }}>No preview available.</div>}
                    </div>
                  </div>
                );
              })()}
            </div>

            {hostPendingActionErr ? (
              <div style={{ marginTop: 10, color: "#b00020", fontSize: 13 }}>{hostPendingActionErr}</div>
            ) : null}

            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "transparent",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
                onClick={() => setHostPendingModalOpen(false)}
              >
                Later
              </button>

              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "rgba(0,0,0,0.06)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
                onClick={() => hostPushPendingContent(hostPendingContent[0].token)}
              >
                Push to chat
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Host guidelines modal */}
      {hostGuidelinesOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 65,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setHostGuidelinesOpen(false)}
        >
          <div
            style={{
              width: "min(820px, 100%)",
              background: "#fff",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>AI interaction guidelines</div>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  These rules are stored for this companion and applied to all future chats.
                  If they conflict with default onboarding, <b>these guidelines take precedence</b>.
                </div>
              </div>
              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "transparent",
                  borderRadius: 8,
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setHostGuidelinesOpen(false)}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              <textarea
                value={hostGuidelinesText}
                onChange={(e) => {
                  setHostGuidelinesText(e.target.value);
                  if (hostGuidelinesStatus === "Saved" || hostGuidelinesStatus === "Loaded") {
                    setHostGuidelinesStatus("");
                  }
                }}
                placeholder="Examples: Off-limits topics, preferred terms of endearment (e.g., call viewers “papi”), tone/style constraints…"
                style={{
                  width: "100%",
                  minHeight: 220,
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.18)",
                  padding: 12,
                  fontSize: 14,
                  lineHeight: 1.4,
                  outline: "none",
                  resize: "vertical",
                }}
              />
              {hostGuidelinesError ? (
                <div style={{ marginTop: 10, color: "#b00020", fontSize: 13 }}>{hostGuidelinesError}</div>
              ) : null}

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                {hostGuidelinesStatus ? (
                  <span style={{ fontWeight: 700, opacity: 0.95 }}>{hostGuidelinesStatus}</span>
                ) : null}
                {hostGuidelinesStatus ? " • " : null}
                Saved: {hostGuidelinesSaved ? "Yes" : "No"} • Characters: {String(hostGuidelinesText || "").length}
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "transparent",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  // Revert draft to last saved value
                  setHostGuidelinesText(hostGuidelinesSaved || "");
                }}
                disabled={hostGuidelinesLoading}
              >
                Revert
              </button>

              <button
                style={{
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "rgba(0,0,0,0.06)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
                onClick={() => void saveHostGuidelines()}
                disabled={hostGuidelinesLoading}
              >
                {hostGuidelinesLoading ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
       ) : null}

      {hostInsightsOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 999999,
            background: "rgba(0,0,0,0.46)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
          onClick={() => setHostInsightsOpen(false)}
        >
          <div
            style={{
              width: "min(980px, 96vw)",
              maxHeight: "92vh",
              overflow: "hidden",
              background: "white",
              color: "#111",
              borderRadius: 14,
              padding: 14,
              boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 750 }}>Session Insights</div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>
                  Ask {hostConsolePublicFirstName} about historical session summaries for members/visitors.
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => void loadHostInsightsUsers()}
                  style={{
                    border: "1px solid rgba(0,0,0,0.14)",
                    background: "rgba(0,0,0,0.04)",
                    borderRadius: 10,
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  disabled={hostInsightsLoading}
                >
                  {hostInsightsLoading ? "Loading…" : "Refresh"}
                </button>

                <button
                  type="button"
                  onClick={() => setHostInsightsOpen(false)}
                  style={{
                    border: "1px solid rgba(0,0,0,0.14)",
                    background: "transparent",
                    borderRadius: 10,
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {hostInsightsError ? (
              <div
                style={{
                  border: "1px solid rgba(180,0,0,0.25)",
                  background: "rgba(180,0,0,0.06)",
                  borderRadius: 12,
                  padding: 10,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                {hostInsightsError}
              </div>
            ) : null}

            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "stretch",
                flex: "1 1 auto",
                minHeight: 0,
                flexWrap: "wrap",
              }}
            >
              {/* Users */}
              <div
                style={{
                  flex: "1 1 260px",
                  minWidth: 240,
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.82 }}>Members / Visitors</div>
                  <button
                    type="button"
                    onClick={() => {
                      setHostInsightsSelectedMemberId("");
                      void loadHostInsightsSummaries("");
                    }}
                    style={{
                      border: "1px solid rgba(0,0,0,0.14)",
                      background: "transparent",
                      borderRadius: 10,
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                    title="Show recent summaries across all members"
                    disabled={hostInsightsLoading}
                  >
                    Recent
                  </button>
                </div>

                <div
                  ref={hostInsightsUsersScrollRef}
                  style={{
                    overflowY: "auto",
                    overflowX: "hidden",
                    minHeight: 0,
                    height: 0,
                    maxHeight: "100%",
                    flex: "1 1 0",
                    paddingRight: 2,
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                    touchAction: "pan-y",
                  }}
                >
                  {hostInsightsUsers.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7, padding: 8 }}>
                      No saved session summaries found yet.
                    </div>
                  ) : (
                    hostInsightsUsers.map((u) => {
                      const selected = hostInsightsSelectedMemberId === u.memberId;
                      return (
                        <button
                          key={u.memberId}
                          type="button"
                          onClick={() => {
                            setHostInsightsSelectedMemberId(u.memberId);
                            void loadHostInsightsSummaries(u.memberId);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            border: selected ? "1px solid rgba(0,120,255,0.40)" : "1px solid rgba(0,0,0,0.08)",
                            background: selected ? "rgba(0,120,255,0.06)" : "rgba(0,0,0,0.02)",
                            borderRadius: 12,
                            padding: 10,
                            cursor: "pointer",
                            marginBottom: 8,
                          }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 750, marginBottom: 2 }}>
                            {u.userName || u.memberId}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 2 }}>
                            {u.memberId}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.72 }}>
                            {`${u.summaryCount || 0} summaries`}
                            {u.summaryLastSeen ? ` · Latest summary ${u.summaryLastSeen}` : ""}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.72 }}>
                            {(() => {
                              const totalMinutes = Number(u.minutesTotal ?? u.minutesAllowed ?? 0) || 0;
                              const usedMinutes = Number(u.minutesUsed ?? 0) || 0;
                              const remainingMinutes = Number(u.minutesRemaining ?? Math.max(0, totalMinutes - usedMinutes)) || 0;
                              const usageLabel = totalMinutes > 0
                                ? `Usage ${usedMinutes}/${totalMinutes} min • ${remainingMinutes} left`
                                : "Usage unavailable";
                              return `${usageLabel}${u.lastSeen ? ` · Last active ${u.lastSeen}` : ""}`;
                            })()}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Summaries + Ask */}
              <div
                style={{
                  flex: "2 1 420px",
                  minWidth: 280,
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 12,
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.82 }}>
                    {hostInsightsSelectedMemberId ? `Summaries: ${hostInsightsSelectedMemberId}` : "Recent summaries (all)"}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setHostInsightsAnswer("");
                      setHostInsightsQuestion("");
                    }}
                    style={{
                      border: "1px solid rgba(0,0,0,0.14)",
                      background: "transparent",
                      borderRadius: 10,
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                    disabled={hostInsightsLoading}
                    title="Clear question and answer"
                  >
                    Clear
                  </button>
                </div>

                <div
                  style={{
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "rgba(0,0,0,0.02)",
                    borderRadius: 12,
                    padding: 10,
                    overflowY: "auto",
                    overflowX: "hidden",
                    minHeight: 120,
                    maxHeight: 220,
                    flex: "0 1 220px",
                    fontSize: 12,
                    color: "#111",
                    whiteSpace: "pre-wrap",
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                    touchAction: "pan-y",
                  }}
                >
                  {hostInsightsSummaries.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>No summaries loaded.</div>
                  ) : (
                    hostInsightsSummaries.map((s, idx) => {
                      const summaryText = sanitizePublicModeLabelsText(s.summary || "").trim();
                      const transcript = Array.isArray(s.messages) ? s.messages : [];
                      return (
                        <div key={`${s.sessionId || ""}-${idx}`} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                          <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 4 }}>
                            {s.createDatetime}
                            {s.sessionId ? ` · ${s.sessionId}` : ""}
                            {s.reason ? ` · ${s.reason}` : ""}
                          </div>

                          {summaryText ? (
                            <div style={{ marginBottom: transcript.length ? 8 : 0, whiteSpace: "pre-wrap" }}>
                              {summaryText}
                            </div>
                          ) : null}

                          {transcript.length ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {transcript.map((m, midx) => {
                                const sender = String(m.sender || "").trim();
                                const viewerName = String(m.user_name || s.userName || "").trim() || "User";
                                const companionLabel = String((companionName || DEFAULT_COMPANION_NAME) ?? "").trim() || "AI";
                                const label =
                                  sender === "user"
                                    ? viewerName
                                    : sender === "host"
                                      ? `${companionLabel} (Host)`
                                      : sender === "ai" || sender === "xai"
                                        ? companionLabel
                                        : "System";
                                return (
                                  <div key={`${s.sessionId || idx}-${m.seq || midx}`} style={{ paddingLeft: 6, borderLeft: "2px solid rgba(0,0,0,0.08)" }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.78, marginBottom: 2 }}>
                                      {label}
                                    </div>
                                    <div style={{ whiteSpace: "pre-wrap" }}>
                                      {sanitizePublicModeLabelsText(m.content || "").trim() || <span style={{ opacity: 0.55 }}>(empty)</span>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : !summaryText ? (
                            <div style={{ opacity: 0.7 }}>No transcript or summary available.</div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.82 }}>Ask {hostConsolePublicFirstName}</div>
                  <textarea
                    value={hostInsightsQuestion}
                    onChange={(e) => setHostInsightsQuestion(e.target.value)}
                    placeholder={
                      hostInsightsSelectedMemberId
                        ? "Ask about this member/visitor’s past sessions…"
                        : "Ask about all members/visitors’ past sessions…"
                    }
                    style={{
                      width: "100%",
                      minHeight: 64,
                      maxHeight: 120,
                      resize: "vertical",
                      border: "1px solid rgba(0,0,0,0.14)",
                      borderRadius: 12,
                      padding: 10,
                      fontSize: 13,
                      color: "#111",
                      outline: "none",
                    }}
                    disabled={hostInsightsLoading || hostInsightsSttEnabled}
                  />

                  {hostInsightsSttError ? (
                    <div style={{ fontSize: 12, color: "#b00020" }}>
                      {hostInsightsSttError}
                    </div>
                  ) : null}

                  {hostInsightsSttEnabled ? (
                    <div style={{ fontSize: 11, opacity: 0.72 }}>
                      Hands-free STT is on. Speak naturally and {hostConsolePublicFirstName} will ask automatically after a short pause. Press Stop mic to switch back to typing.
                    </div>
                  ) : null}

                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (hostInsightsSttEnabled) hostInsightsStopStt();
                        else hostInsightsStartStt();
                      }}
                      style={{
                        border: "1px solid rgba(0,0,0,0.18)",
                        background: hostInsightsSttEnabled ? "rgba(180,0,0,0.08)" : "rgba(0,0,0,0.04)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        cursor: "pointer",
                        fontSize: 12,
                        color: "#111",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                      disabled={hostInsightsLoading && !hostInsightsSttEnabled}
                      title={hostInsightsSttEnabled ? "Stop hands-free speech-to-text and switch back to typing" : "Start hands-free speech-to-text"}
                    >
                      <span aria-hidden="true">{hostInsightsSttEnabled ? "■" : "🎤"}</span>
                      <span>
                        {hostInsightsSttEnabled
                          ? hostInsightsSttRecording
                            ? "Stop mic"
                            : hostInsightsLoading
                              ? "Working…"
                              : "Mic on"
                          : "Speak question"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void askHostInsights()}
                      style={{
                        border: "1px solid rgba(0,0,0,0.18)",
                        background: "rgba(0,0,0,0.06)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                      disabled={hostInsightsLoading || hostInsightsSttEnabled || !(hostInsightsQuestion || "").trim()}
                    >
                      {hostInsightsLoading ? "Asking…" : "Ask"}
                    </button>
                  </div>
                </div>

                {hostInsightsAnswer ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      flex: "1 1 180px",
                      minHeight: 0,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.82 }}>Response</div>
                    <div
                      ref={hostInsightsAnswerScrollRef}
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(0,0,0,0.02)",
                        borderRadius: 12,
                        padding: 10,
                        fontSize: 13,
                        color: "#111",
                        whiteSpace: "pre-wrap",
                        overflowY: "auto",
                        overflowX: "hidden",
                        minHeight: 140,
                        height: 0,
                        maxHeight: 260,
                        flex: "1 1 0",
                        WebkitOverflowScrolling: "touch",
                        overscrollBehavior: "contain",
                        touchAction: "pan-y",
                      }}
                    >
                      {sanitizePublicModeLabelsText(hostInsightsAnswer)}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 180px" }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            Host Console
          </div>
          <div style={{ fontSize: 12, opacity: 0.82 }}>
            {companyName} · {companionName || DEFAULT_COMPANION_NAME}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flex: "1 1 420px" }}>
          <button
            type="button"
            onClick={() => {
              setHostGuidelinesError("");
              setHostGuidelinesOpen(true);
              void loadHostGuidelines();
            }}
            style={{
              border: "1px solid rgba(64,160,255,0.45)",
              background: "rgba(64,160,255,0.12)",
              color: "#7bc0ff",
              borderRadius: 10,
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
            title="Edit AI companion interaction guidelines (persisted)"
          >
            AI Guidelines
          </button>

          <button
            type="button"
            onClick={() => {
              setHostInsightsError("");
              setHostInsightsAnswer("");
              setHostInsightsQuestion("");
              setHostInsightsSelectedMemberId("");
              setHostInsightsSummaries([]);
              setHostInsightsOpen(true);
              void loadHostInsightsUsers();
            }}
            style={{
              border: "1px solid rgba(64,160,255,0.45)",
              background: "rgba(64,160,255,0.12)",
              color: "#7bc0ff",
              borderRadius: 10,
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
            title={`Ask ${hostConsolePublicFirstName} about historical session summaries for visitors/members`}
          >
            Session Insights
          </button>

          {hostPendingContent.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setHostPendingActionErr(null);
                setHostPendingModalOpen(true);
              }}
              style={{
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                borderRadius: 10,
                padding: "8px 10px",
                cursor: "pointer",
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              Pending ({hostPendingContent.length})
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setHostConsoleOpen(false)}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.28)",
              background: "rgba(0,0,0,0.28)",
              color: "white",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Close
          </button>
        </div>
      </div>

      {hostActiveError ? (
        <div style={{ marginTop: 10, color: "#ffb3b3", fontSize: 13 }}>
          {hostActiveError}
        </div>
      ) : null}

      {hostNotice ? (
        <div style={{ marginTop: 10, color: "#fff1b3", fontSize: 13 }}>
          {hostNotice}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: isMobileUI ? "1fr" : isTabletUI ? "320px 1fr" : "360px 1fr",
          gap: 12,
          height: "calc(min(860px, 92vh) - 170px)",
        }}
      >
        {/* Left: Active chats */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 12,
            padding: 10,
            overflow: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <div style={{ fontWeight: 700 }}>Active chats</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {hostActiveLoading ? "Loading…" : `${hostActiveChats.length}`}
            </div>
          </div>

          {hostActiveChats.length === 0 && !hostActiveLoading ? (
            <div style={{ fontSize: 13, opacity: 0.8 }}>
              No active sessions detected yet.
            </div>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hostActiveChats.map((c) => {
              const isSelected = c.session_id === hostSelectedSessionId;
              const memberLabel =
                (String((c as any).user_name || "").trim() ||
                  (c.member_id || "").trim() ||
                  "anonymous / visitor");
              const mins =
                typeof c.minutes_remaining === "number"
                  ? c.minutes_remaining
                  : undefined;

              return (
                <button
                  key={c.session_id}
                  type="button"
                  onClick={() => hostSelectSession(c.session_id)}
                  style={{
                    textAlign: "left",
                    padding: "10px 10px",
                    borderRadius: 12,
                    border: isSelected
                      ? "1px solid rgba(255,255,255,0.55)"
                      : "1px solid rgba(255,255,255,0.14)",
                    background: isSelected
                      ? "rgba(255,255,255,0.10)"
                      : "rgba(0,0,0,0.20)",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {memberLabel}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      {typeof c.unread === "number" && c.unread > 0
                        ? `• ${c.unread} new`
                        : ""}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                    <div>
                      {c.override_active ? "Override: ON" : "Override: off"}
                    </div>
                    {typeof mins === "number" ? <div>Minutes: {mins}</div> : null}
                  </div>

                  {c.summary ? (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9, whiteSpace: "pre-wrap" }}>
                      {sanitizePublicModeLabelsText(c.summary)}
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                      (No summary yet)
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Selected transcript + controls */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 700 }}>
              {hostSelectedSessionId ? "Session" : "Select a session"}
            </div>

            {hostSelectedSessionId ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {(() => {
                  const selected = hostActiveChats.find(
                    (c) => c.session_id === hostSelectedSessionId
                  );
                  const overrideOn = Boolean(selected?.override_active);
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => hostSetOverride(!overrideOn)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.28)",
                          background: overrideOn
                            ? "rgba(120,255,170,0.18)"
                            : "rgba(0,0,0,0.28)",
                          color: "white",
                          cursor: "pointer",
                        }}
                        title="Toggle host override for this session"
                      >
                        {overrideOn ? "End override" : "Enable override"}
                      </button>
                    </>
                  );
                })()}
              </div>
            ) : null}
          </div>

          {hostSelectedSessionId ? (
            <div style={{ fontSize: 12, opacity: 0.78, marginTop: 6 }}>
              {hostSelectedSessionId}
            </div>
          ) : null}

          <div
            style={{
              marginTop: 10,
              flex: 1,
              overflow: "auto",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              padding: 10,
              background: "rgba(0,0,0,0.20)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {hostSelectedSessionId && hostSelectedEvents.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.75 }}>
                Waiting for messages…
              </div>
            ) : null}

            {hostSelectedEvents.map((ev, idx) => {
              const sender = String((ev as any).sender || "");
              const selected = hostActiveChats.find(
                (c) => c.session_id === hostSelectedSessionId
              );
              const userName = String(
                (ev as any).user_name || (selected as any)?.user_name || ""
              ).trim();
              const companionLabel = String(
                (companionName || DEFAULT_COMPANION_NAME) ?? ""
              ).trim();
              const label =
                sender === "user"
                  ? (userName || "User")
                  : sender === "host"
                    ? `${companionLabel} (Host)`
                    : sender === "ai" || sender === "xai"
                      ? (companionLabel || "AI")
                      : "System";

              return (
                <div key={`${(ev as any).seq || idx}`} style={{ fontSize: 13, lineHeight: 1.35 }}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 2 }}>
                    {label}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>
                    {relayEventHostFacingText(ev)}
                  </div>
                </div>
              );
            })}
          </div>

          {hostSttError ? (
            <div style={{ fontSize: 12, color: "#ffb3b3", marginTop: 8 }}>
              {hostSttError}
            </div>
          ) : null}

          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "stretch" }}>
            {(() => {
              const selected = hostActiveChats.find(
                (c) => c.session_id === hostSelectedSessionId
              );
              const overrideOn = Boolean(selected?.override_active);
              const sttDisabled = !hostSelectedSessionId || !overrideOn;

              return (
                <button
                  onClick={() => {
                    if (sttDisabled) return;
                    if (hostSttRecording) hostStopStt();
                    else hostStartStt();
                  }}
                  disabled={sttDisabled}
                  title={
                    sttDisabled
                      ? "Enable override to use STT"
                      : hostSttRecording
                        ? "Stop recording"
                        : "Start recording"
                  }
                  style={{
                    width: ICON_BTN_SIZE,
                    height: ICON_BTN_SIZE,
                    minWidth: ICON_BTN_SIZE,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.22)",
                    boxSizing: "border-box",
                    background: hostSttRecording
                      ? "rgba(255,0,0,0.25)"
                      : "rgba(0,0,0,0.22)",
                    color: "white",
                    cursor: sttDisabled ? "not-allowed" : "pointer",
                    opacity: sttDisabled ? 0.55 : 1,
                  }}
                >
                  {hostSttRecording ? "■" : "🎤"}
                </button>
              );
            })()}
            <textarea
              value={hostSendText}
              onChange={(e) => setHostSendText(e.target.value)}
              placeholder="Send a host message…"
              style={{
                flex: 1,
                minHeight: 44,
                maxHeight: 140,
                resize: "vertical",
                padding: "10px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(0,0,0,0.22)",
                color: "white",
                outline: "none",
                fontSize: 14,
              }}
              disabled={!hostSelectedSessionId}
            />

            <button
              type="button"
              onClick={hostSendMessage}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.28)",
                background: "rgba(0,0,0,0.28)",
                color: "white",
                cursor: "pointer",
                minWidth: 92,
              }}
              disabled={!hostSelectedSessionId || !hostSendText.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
) : null}


{/* Consent overlay */}
      {showConsentOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 16,
              maxWidth: 520,
              width: "100%",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Consent Required</h3>
            <p style={{ marginTop: 0 }}>
              To enable <b>Mature</b> mode, please confirm you are 18+ and consent to an
              Mature conversation.
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  // Ensure backend receives pending_consent + intimate mode
                  if (!allowedModes.includes("intimate")) {
                    showUpgradeMessage("intimate");
                    setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: false, mode: prev.mode === "intimate" ? fallbackModeForAllowedModes(allowedModes) : prev.mode }));
                    setChatStatus("safe");
                    return;
                  }
                  setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
                  send("Yes", { pending_consent: "intimate", mode: "intimate" });
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                }}
              >
                Yes
              </button>

              <button
                onClick={() => {
                  if (!allowedModes.includes("intimate")) {
                    showUpgradeMessage("intimate");
                    setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: false, mode: prev.mode === "intimate" ? fallbackModeForAllowedModes(allowedModes) : prev.mode }));
                    setChatStatus("safe");
                    return;
                  }
                  setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
                  send("No", { pending_consent: "intimate", mode: "intimate" });
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                No
              </button>

              <button
                onClick={() => {
                  setChatStatus("safe");
                  setSessionState((prev) => ({ ...prev, pending_consent: null, mode: fallbackModeForAllowedModes(allowedModes) }));
                }}
                style={{
                  marginLeft: "auto",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                Cancel
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              Tip: You can also type <b>[mode:intimate]</b> or <b>[mode:romantic]</b> to switch.
            </div>
          </div>
        </div>
      )}

      {/* Debug overlay (mobile-friendly) */}
      {debugOpen && (
        <div
          style={{
            position: "fixed",
            left: 10,
            right: 10,
            // Place the overlay at the bottom so it doesn't cover the mic + input controls.
            bottom: "calc(10px + env(safe-area-inset-bottom))",
            zIndex: 999999,
            background: "rgba(0,0,0,0.88)",
            color: "#fff",
            borderRadius: 12,
            padding: 10,
            boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
            maxHeight: "35vh",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Debug Logs ({debugLogs.length})</div>
            <button
              onClick={async () => {
                const textToCopy = debugLogs.join("\n");
                let copied = false;

                // Try modern Clipboard API first.
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(textToCopy);
                    copied = true;
                  }
                } catch {
                  copied = false;
                }

                // Fallback: execCommand("copy") via a hidden textarea.
                if (!copied) {
                  try {
                    const ta = document.createElement("textarea");
                    ta.value = textToCopy;
                    ta.setAttribute("readonly", "true");
                    ta.style.position = "fixed";
                    ta.style.top = "0";
                    ta.style.left = "0";
                    ta.style.width = "1px";
                    ta.style.height = "1px";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    copied = document.execCommand("copy");
                    document.body.removeChild(ta);
                  } catch {
                    copied = false;
                  }
                }

                if (copied) {
                  // eslint-disable-next-line no-alert
                  alert("Copied debug logs to clipboard.");
                } else {
                  // Last resort: show a prompt with selectable text so the user can copy manually.
                  // eslint-disable-next-line no-alert
                  window.prompt("Copy debug logs:", textToCopy);
                }
              }}
              style={{
                marginLeft: "auto",
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Copy
            </button>
            <button
              onClick={() => setDebugLogs([])}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
            <button
              onClick={() => setDebugOpen(false)}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Close
            </button>
            <button
              onClick={() => {
                setDebugOpen(false);
                setDebugEnabled(false);
                setDebugLogs([]);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,80,80,0.25)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Disable
            </button>
          </div>

          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowY: "auto",
              maxHeight: "26vh",
              borderRadius: 10,
              padding: 8,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {debugLogs.length === 0 ? (
              <div style={{ opacity: 0.8 }}>No logs yet. Tap around, then press Copy.</div>
            ) : (
              debugLogs.map((l, i) => <div key={i}>{l}</div>)
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85 }}>
            Tip: Tap the avatar image 5 times to toggle this overlay.
          </div>
        </div>
      )}

</main>
  );
}
