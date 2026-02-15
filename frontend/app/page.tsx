"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import elaraLogo from "../public/elaralo-logo.png";


import { LiveKitRoom, VideoConference, GridLayout, ParticipantTile, useTracks, RoomAudioRenderer } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import Hls from "hls.js";
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

const SaveIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    style={{ display: "block" }}
  >
    <path
      d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm2 16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11v5H7v2h10V4.41L19 6.41V19z"
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

type LiveProvider = "d-id" | "stream";

type SessionKind = "stream" | "private" | "conference" | "";

// Jitsi Meet External API is loaded at runtime (script tag).
declare global {
  interface Window {
    JitsiMeetExternalAPI?: any;
  }
}
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
};

type ChatStatus = "safe" | "explicit_blocked" | "explicit_allowed";

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

type ChatApiResponse = {
  reply: string;
  mode?: ChatStatus; // IMPORTANT: this is STATUS, not the UI pill mode
  session_state?: Partial<SessionState>;
};

type PlanName =
  | "Trial"
  | "Friend"
  | "Romantic"
  | "Intimate (18+)"
  | "Pay as You Go"
  | "Test - Friend"
  | "Test - Romantic"
  | "Test - Intimate (18+)"
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



// --- Plan and companion helpers (no UI changes beyond required labels) ---
function normalizePlanName(raw: any): PlanName {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const key = s.toLowerCase();

  switch (key) {
    case "trial":
      return "Trial";
    case "friend":
      return "Friend";
    case "romantic":
      return "Romantic";
    case "intimate (18+)":
      return "Intimate (18+)";
    case "pay as you go":
      return "Pay as You Go";
    case "test - friend":
      return "Test - Friend";
    case "test - romantic":
      return "Test - Romantic";
    case "test - intimate (18+)":
      return "Test - Intimate (18+)";
    case "test - pay as you go":
      return "Test - Pay as You Go";
    default:
      return null;
  }
}

function stripTrialControlsFromRebrandingKey(key: string): string {
  const p = parseRebrandingKey(key);
  if (!p) return key;

  // IMPORTANT:
  // Historically some backend paths read the *plan* segment (6th field) from the rebrandingKey to decide
  // included minutes. For white-label sites, the 6th field may be the white-label plan label (e.g. "Test - Exclusive")
  // and the Elaralo entitlement plan is carried in `elaraloPlanMap` (e.g. "Intimate (18+)").
  //
  // To ensure quota/minutes are computed from the mapped Elaralo plan, we copy `elaraloPlanMap` into the plan slot
  // when it's present.
  const entitlementPlan = (p.elaraloPlanMap || "").trim() || (p.plan || "").trim();
  // Keep format stable (9 segments).
  // Blank-out FreeMinutes + CycleDays so the backend can fall back to plan defaults
  // when the user is entitled (i.e., has an active plan).
  return [
    p.rebranding,
    p.upgradeLink,
    p.payGoLink,
    p.payGoPrice,
    p.payGoMinutes,
    entitlementPlan,
    p.elaraloPlanMap,
    "",
    "",
  ].join("|");
}

function displayPlanLabel(planName: PlanName, memberId: string, planLabelOverride?: string): string {
  const hasMemberId = Boolean((memberId || "").trim());

  // Requirement: If we do not have a memberId, the visitor is on Trial, shown as "Free Trial".
  if (!hasMemberId) return "Free Trial";

  // White-label: show the rebranding site's plan label when provided (e.g., "Supreme"),
  // while still using ElaraloPlanMap for capability gating.
  const override = String(planLabelOverride || "").trim();
  if (override) return override;

  // Requirement: Unknown / Not Provided only when the plan information for a member is not provided.
  if (!planName) return "Unknown / Not Provided";

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
  if (s.includes("intimate")) return "intimate";
  if (s.includes("romantic")) return "romantic";
  if (s.includes("friend")) return "friend";
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

const HEADSHOT_DIR = "/companion/headshot";

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

function parseRebrandingKey(raw: string): RebrandingKeyParts | null {
  const v = String(raw || "").trim();
  if (!v) return null;

  // Legacy support: if there is no "|" delimiter, treat this as just the brand name.
  if (!v.includes("|")) {
    const brand = stripRebrandingKeyLabel(v);
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

  const parts = v.split("|").map((p) => stripRebrandingKeyLabel(p));

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

type Phase1AvatarMedia = {
  didAgentId: string;
  didClientKey: string;
  elevenVoiceId: string;
};

const PHASE1_AVATAR_MEDIA: Record<string, Phase1AvatarMedia> = {
  "Jennifer": {
    "didAgentId": "v2_agt_n7itFF6f",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "19STyYD15bswVz51nqLf"
  },
  "Jason": {
    "didAgentId": "v2_agt_WpC1hOBQ",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "j0jBf06B5YHDbCWVmlmr"
  },
  "Tonya": {
    "didAgentId": "v2_agt_2lL6f5YY",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "Hybl6rg76ZOcgqZqN5WN"
  }
} as any;

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

  // Many companions arrive from Wix as a descriptive key like:
  //   "Ashley-Female-Caucasian-Millennials"
  // while our ElevenLabs map is keyed by the first name ("Ashley").
  // Normalize to reduce accidental fallback to Elara for the greeting.
  const firstToken = raw.split("-")[0]?.trim() || "";
  if (firstToken && ELEVEN_VOICE_ID_BY_AVATAR[firstToken]) return ELEVEN_VOICE_ID_BY_AVATAR[firstToken];

  // Case-insensitive match as a final attempt.
  const ciKey = Object.keys(ELEVEN_VOICE_ID_BY_AVATAR).find(
    (k) => k.toLowerCase() === raw.toLowerCase() || (firstToken && k.toLowerCase() === firstToken.toLowerCase())
  );
  if (ciKey) return ELEVEN_VOICE_ID_BY_AVATAR[ciKey];

  // Fallback to Elara so audio-only TTS always has a voice.
  return ELEVEN_VOICE_ID_BY_AVATAR["Elara"] || "";
}
function getPhase1AvatarMedia(avatarName: string | null | undefined): Phase1AvatarMedia | null {
  if (!avatarName) return null;

  const direct = PHASE1_AVATAR_MEDIA[avatarName];
  if (direct) return direct;

  const key = Object.keys(PHASE1_AVATAR_MEDIA).find(
    (k) => k.toLowerCase() === avatarName.toLowerCase()
  );
  return key ? PHASE1_AVATAR_MEDIA[key] : null;
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
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate (18+)",
};

// Plan → mode availability mapping (UI pills)
// Requirements:
// - Friend or Test - Friend Plan: Friend only
// - Romantic or Test - Romantic Plan: Friend + Romantic
// - Intimate (18+) or Test - Intimate (18+) Plan: Friend + Romantic + Intimate (18+)
const ROMANTIC_ALLOWED_PLANS: PlanName[] = [
  "Trial",
  "Romantic",
  "Intimate (18+)",
  "Pay as You Go",
  "Test - Romantic",
  "Test - Intimate (18+)",
  "Test - Pay as You Go",
];


function allowedModesForPlan(planName: PlanName): Mode[] {
  const modes: Mode[] = ["friend"];
  if (ROMANTIC_ALLOWED_PLANS.includes(planName)) modes.push("romantic");
  if (
    planName === "Intimate (18+)" ||
    planName === "Test - Intimate (18+)" ||
    planName === "Pay as You Go" ||
    planName === "Test - Pay as You Go"
  )
    modes.push("intimate");
  return modes;
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
  for (const enc of encVariants) {
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
 * Supports:
 * - [mode:romantic], mode:romantic
 * - "switch to romantic", "romantic mode", "set mode to romantic", etc.
 */
function detectModeSwitchAndClean(text: string): { mode: Mode | null; cleaned: string } {
  const raw = text || "";
  const t = raw.toLowerCase();

  // explicit tokens
  // NOTE: allow "romance" token from older builds as a synonym for "romantic"
  const tokenRe =
    /\[mode:(friend|romantic|romance|intimate|explicit)\]|mode:(friend|romantic|romance|intimate|explicit)/gi;

  let tokenMode: Mode | null = null;
  let cleaned = raw.replace(tokenRe, (m) => {
    const mm = m.toLowerCase();
    if (mm.includes("friend")) tokenMode = "friend";
    else if (mm.includes("romantic") || mm.includes("romance")) tokenMode = "romantic";
    else if (mm.includes("intimate") || mm.includes("explicit")) tokenMode = "intimate";
    return "";
  });

  cleaned = cleaned.trim();

  if (tokenMode) return { mode: tokenMode, cleaned };

  // soft phrasing (covers friend->romantic and intimate->romantic)
  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back)\b.*\bfriend\b/.test(soft) || /\bfriend mode\b/.test(soft);

  const wantsRomantic =
    // "romantic mode" / "romance mode"
    /\b(romantic|romance) mode\b/.test(soft) ||
    // switch/set/back/go/turn ... romantic
    /\b(switch|set|turn|go|back)\b.*\b(romantic|romance)\b/.test(soft) ||
    // natural phrasing users actually type
    /\b(let['’]?s|lets)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\b(be|being|try|trying|have|having)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\bromantic conversation\b/.test(soft) ||
    /\bromance again\b/.test(soft) ||
    /\btry romance again\b/.test(soft);

  const wantsIntimate =
    /\b(switch|set|turn|go|back)\b.*\b(intimate|explicit|adult|18\+)\b/.test(soft) ||
    /\b(intimate|explicit) mode\b/.test(soft);

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


export default function Page() {
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

  // Keep the latest Wix memberId available for callbacks defined earlier in this file.
  // This avoids TypeScript/TDZ issues where a callback dependency array would otherwise
  // reference `memberId` before its declaration.
  const memberIdRef = useRef<string>("");

  // Wix member id (empty for visitors). Declared early so it can be referenced
  // safely in dependency arrays above (prevents TS "used before its declaration").
  const [memberId, setMemberId] = useState<string>("");

  const autoJoinStreamRef = useRef<boolean>(false);

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


  // Companion identity (drives persona + Phase 1 live avatar mapping)
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);
  // Optional white-label rebranding (RebrandingKey from Wix or ?rebrandingKey=...).
  // IMPORTANT: This must never alter STT/TTS start/stop code paths.
  const [rebrandingKey, setRebrandingKey] = useState<string>("");

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

        return (
          <React.Fragment key={idx}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
            >
              {label}
            </a>
            {punct}
          </React.Fragment>
        );
      });
    };

    const textNode = renderTextWithLinks(m.content || "", m.role === "assistant");

    const attachmentNode = attUrl ? (
      <div style={{ marginTop: 6 }}>
        <a href={attUrl} target="_blank" rel="noopener noreferrer">
          {isImage ? (
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
          ) : (
            <span style={{ textDecoration: "underline" }}>{attName || "Open attachment"}</span>
          )}
        </a>
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

  // Upgrade URL (defaults to env; overridden by RebrandingKey when present)
  const upgradeUrl = useMemo(() => {
    const u = String(rebrandingInfo?.upgradeLink || "").trim();
    return u || UPGRADE_URL;
  }, [rebrandingInfo]);

  const [companyLogoSrc, setCompanyLogoSrc] = useState<string>(DEFAULT_AVATAR);
  const companyName = (rebrandingName || DEFAULT_COMPANY_NAME);
  const [companionKey, setCompanionKey] = useState<string>("");
  const [companionKeyRaw, setCompanionKeyRaw] = useState<string>("");

  // Viewer-only: display name used in the shared in-stream chat.
  // - Stored locally so we only prompt once per (brand, companion).
  const liveChatUsernameStorageKey = useMemo(() => {
    const b = safeBrandKey(String(companyName || "").trim() || "core") || "core";
    const a = safeBrandKey(String(companionName || "").trim() || "companion") || "companion";
    return `livekit_livechat_username:${b}:${a}`;
  }, [companyName, companionName]);

  const [viewerLiveChatName, setViewerLiveChatName] = useState<string>("");

  useEffect(() => {
    // Keep state in sync with localStorage as the user switches companions/brands.
    // Fallback to sessionStorage if localStorage is blocked (common in some iframe/privacy modes).
    try {
      if (typeof window === "undefined") return;

      let stored = "";
      try {
        stored = String((() => {
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
      } catch (e) {
        stored = "";
      }
      if (!stored) {
        try {
          stored = String(window.sessionStorage.getItem(liveChatUsernameStorageKey) || "").trim();
        } catch (e) {
          stored = "";
        }
      }

      setViewerLiveChatName(stored);
    } catch (e) {
      setViewerLiveChatName("");
    }
  }, [liveChatUsernameStorageKey]);

  const ensureViewerLiveChatName = useCallback((): string => {
    try {
      if (typeof window === "undefined") return "";
      const current = String(viewerLiveChatName || "").trim();
      if (current) return current;

      let stored = "";
      try {
        stored = String((() => {
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
      } catch (e) {
        stored = "";
      }
      if (!stored) {
        try {
          stored = String(window.sessionStorage.getItem(liveChatUsernameStorageKey) || "").trim();
        } catch (e) {
          stored = "";
        }
      }
      if (stored) {
        setViewerLiveChatName(stored);
        return stored;
      }

      // Prompt only when Viewer explicitly joins the live stream (Play).
      const raw = window.prompt("Choose a username to display during the live session:", "") || "";
      const cleaned = raw
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);

      if (!cleaned) return "";

      try {
        try {
        window.localStorage.setItem(liveChatUsernameStorageKey, cleaned);
      } catch (e) {
        try {
          window.sessionStorage.setItem(liveChatUsernameStorageKey, cleaned);
        } catch (e) {}
      }
      } catch (e) {
        try {
          window.sessionStorage.setItem(liveChatUsernameStorageKey, cleaned);
        } catch (e) {}
      }
      setViewerLiveChatName(cleaned);
      return cleaned;
    } catch (e) {
      return "";
    }
  }, [viewerLiveChatName, liveChatUsernameStorageKey]);


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

  
  const [companionMappingError, setCompanionMappingError] = useState<string>("");
useEffect(() => {
    let cancelled = false;

    async function load() {
      const brand = String(companyName || "").trim();
      const avatar = String(companionName || "").trim();

      // Strict: brand+avatar must be present (core brand defaults to Elaralo when rebrandingKey is empty).
      if (!brand || !avatar) {
        setCompanionMapping(null);
        setCompanionMappingError("Missing brand or avatar for companion mapping lookup.");
        return;
      }

      if (!API_BASE) {
        setCompanionMapping(null);
        setCompanionMappingError("API_BASE is not configured; cannot load companion mapping.");
        return;
      }

      try {
        const url = `${API_BASE}/mappings/companion?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(
          avatar
        )}`;
        const res = await fetch(url, { method: "GET" });

        // Backend is strict and may return 404; surface its error message.
        const json: any = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (!res.ok) {
          const detail = String(json?.detail || json?.message || "").trim();
          setCompanionMapping(null);
          setCompanionMappingError(
            detail || `Companion mapping request failed (${res.status} ${res.statusText}).`
          );
          return;
        }

        // Strict: mapping endpoint must return found=true
        if (!(json as any)?.found) {
          setCompanionMapping(null);
          setCompanionMappingError(`Companion mapping not found for brand='${brand}' avatar='${avatar}'.`);
          return;
        }

        setCompanionMapping(json as CompanionMappingRow);
        setCompanionMappingError("");
      } catch (e: any) {
        if (!cancelled) {
          setCompanionMapping(null);
          setCompanionMappingError(String(e?.message || e || "Failed to load companion mapping."));
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [API_BASE, companyName, companionName]);

  // Auto-join active LiveKit stream as a viewer (subscribe-only)
  // Read `?rebrandingKey=...` for direct testing (outside Wix).
  // Back-compat: also accept `?rebranding=BrandName`.
  // In production, Wix should pass { rebrandingKey: "..." } via postMessage.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const qKey = u.searchParams.get(REBRANDING_KEY_QUERY_PARAM);
      const qLegacy = u.searchParams.get(LEGACY_REBRANDING_QUERY_PARAM);
      const q = String(qKey || "").trim() || String(qLegacy || "").trim();
      if (q) setRebrandingKey(q);
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
        if (!p) return DEFAULT_AVATAR;

        // Covers both:
        // - "/companion/headshot/..."
        // - "/rebranding/<brand>/companion/headshot/..."
        if (p.includes(`${HEADSHOT_DIR}/`)) return prev;

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
        if (!p) return picked;

        // Covers both default + rebrand headshots.
        if (p.includes(`${HEADSHOT_DIR}/`)) return prev;

        if (p === DEFAULT_AVATAR) return picked;

        // If we were showing some other "-logo.*" asset, treat it as a company logo and swap it.
        if (p.includes("-logo.")) return picked;

        return prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [rebrandingName, rebrandingSlug]);



// ----------------------------
// Phase 1: Live Avatar (D-ID) + TTS (ElevenLabs -> Azure Blob)
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
  // LiveKit (replaces LegacyStream + Jitsi)
  const LIVEKIT_URL = useMemo(() => normalizeLivekitWsUrl(String((process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "")).trim()), [normalizeLivekitWsUrl]);
  const [livekitToken, setLivekitToken] = useState<string>("");
  const [livekitHlsUrl, setLivekitHlsUrl] = useState<string>("");
  const [livekitRoomName, setLivekitRoomName] = useState<string>("");
  const [livekitRole, setLivekitRole] = useState<"unknown" | "host" | "attendee" | "viewer">("unknown");
  const [livekitServerUrl, setLivekitServerUrl] = useState<string>(String(LIVEKIT_URL || "").trim());
  // LiveKit session state (replaces BeeStreamed/Jitsi session flags)
  const [sessionActive, setSessionActive] = useState<boolean>(false);
  const [sessionKind, setSessionKind] = useState<SessionKind>("");
  const [sessionRoom, setSessionRoom] = useState<string>("");
  // Treat "host" as the LiveKit host role (LegacyStream host semantics are deprecated).
  const isHost = livekitRole === "host";
  const livekitRoleKnown = livekitRole !== "unknown";
  const [livekitJoinRequestId, setLivekitJoinRequestId] = useState<string>("");

  const [livekitPending, setLivekitPending] = useState<Array<any>>([]);
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
    if (!sessionActive) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const resp = await fetch(`${API_BASE}/livekit/join_requests?brand=${encodeURIComponent(companyName)}&avatar=${encodeURIComponent(companionName)}`);
        const data: any = await resp.json().catch(() => ({}));
        if (!cancelled) setLivekitPending(Array.isArray(data?.requests) ? data.requests : []);
      } catch {
        if (!cancelled) setLivekitPending([]);
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
          if (!token) return;

          setLivekitToken(token);
          setConferenceJoined(true);
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

  const mappedHostMemberId = useMemo(() => {
    const v = (companionMapping as any)?.hostMemberId ?? (companionMapping as any)?.host_member_id ?? "";
    return String(v || "");
  }, [companionMapping]);

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

const phase1AvatarMedia = useMemo(() => getPhase1AvatarMedia(companionName), [companionName]);

const channelCap: ChannelCap = useMemo(() => {
  // IMPORTANT: communication is legacy and will be removed. Use channel_cap only.
  const capRaw = String((companionMapping as any)?.channel_cap ?? (companionMapping as any)?.channelCap ?? "")
    .trim()
    .toLowerCase();

  if (capRaw === "video") return "video";
  if (capRaw === "audio") return "audio";
  return "";
}, [companionMapping]);

const liveProvider: LiveProvider = useMemo(() => {
  // Strict mapping: DB values are Stream, D-ID, or NULL.
  // NOTE: "did" (no hyphen) is NOT accepted.
  const liveRaw = String(companionMapping?.live || "").trim().toLowerCase();

  if (liveRaw === "stream") return "stream";
  if (liveRaw === "d-id") return "d-id";

  // If channel_cap=Video but live is empty/invalid, treat as misconfigured.
  // We default to "d-id" as a safe runtime fallback, but we also surface an error via companionMappingError.
  return "d-id";
}, [companionMapping]);


// Strict validation: Video companions must have a Live provider (Stream or D-ID).
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

const liveEnabled = useMemo(() => {
  // Product requirement (Video Icon next to the microphone):
  // - Show when channel_cap === "Video" AND live is "Stream" or "D-ID"
  // - Hide otherwise
  const liveRaw = String(companionMapping?.live || "").trim().toLowerCase();
  const liveOk = liveRaw === "stream" || liveRaw === "d-id";
  return channelCap === "video" && liveOk;
}, [channelCap, companionMapping]);


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
const streamUiActive =
  liveProvider === "stream" &&
  (avatarStatus === "connecting" ||
    avatarStatus === "waiting" ||
    avatarStatus === "connected" ||
    avatarStatus === "reconnecting" ||
    Boolean(streamEventRef));

const showAvatarFrame =
  (liveProvider === "stream" && streamUiActive) ||
  (Boolean(phase1AvatarMedia) && liveProvider === "d-id" && avatarStatus !== "idle");

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
  // Always clean up iPhone audio boost routing first
  cleanupIphoneLiveAvatarAudio();

  // LegacyStream (Human companion) — stop the stream and clear the embed.
  if (streamEventRef) {
    const hostStopping = Boolean(streamCanStart);
    let stopSucceeded = false;

    try {
      // Only the host can stop the underlying LegacyStream event.
      // Viewers can close their local iframe without affecting the event.
      if (hostStopping) {
        const res = await fetch(`${API_BASE}/stream/livekit/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            memberId: memberIdRef.current || "",
            displayName: String(viewerLiveChatName || "").trim(),
            embedDomain,
          }),
        });

        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
        }
      }

      stopSucceeded = true;
    } catch (e) {
      const err = e as any;
      console.warn("LegacyStream stop_embed failed:", err);

      // Keep the host in-session so they can retry Stop (avoids a mismatch where the event is live but the UI is torn down).
      if (hostStopping) {
        setAvatarError(
          `Failed to end the live stream. ${err?.message ? String(err.message) : String(err)}`,
        );
        return;
      }
    } finally {
      // Always allow viewers to disconnect locally.
      // For the host, only tear down the embed if the stop call succeeded.
      if (!hostStopping || stopSucceeded) {
setStreamEventRef("");
        setStreamCanStart(false);
        setStreamNotice("");

        // Leaving the in-stream experience (Stop pressed).
        joinedStreamRef.current = false;
      }

      // Host stop -> mark global session inactive immediately (poll will also confirm)
      if (hostStopping && stopSucceeded) setSessionActive(false);
    }
  }

  try {
    const mgr = didAgentMgrRef.current;
    didAgentMgrRef.current = null;

    // Stop any remembered MediaStream (important if we were showing idle_video and vid.srcObject is null)
    const remembered = didSrcObjectRef.current;
    didSrcObjectRef.current = null;

    if (mgr) {
      await mgr.disconnect();
    }

    try {
      if (remembered && typeof remembered.getTracks === "function") {
        remembered.getTracks().forEach((t: any) => t?.stop?.());
      }
    } catch (e) {
      // ignore
    }

    const vid = avatarVideoRef.current;
    if (vid) {
      const srcObj = vid.srcObject as MediaStream | null;
      if (srcObj && typeof srcObj.getTracks === "function") {
        srcObj.getTracks().forEach((t) => t.stop());
      }
      vid.srcObject = null;

      // If we were displaying the presenter's idle_video, clear it too.
      try {
        vid.pause();
        vid.removeAttribute("src");
        (vid as any).src = "";
        vid.load?.();
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  } finally {
    setAvatarStatus("idle");
    setAvatarError(null);
  }
}, [cleanupIphoneLiveAvatarAudio, "", streamEventRef, streamCanStart, API_BASE, companyName, companionName]);

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

  // Clear any prior in-stream chat transcript (your chat/auth are handled internally).
  setMessages((prev) => prev.filter((m) => !m.meta?.liveChat));
  liveChatSeenIdsRef.current = new Set();
  liveChatSeenOrderRef.current = [];

  try {
    const embedDomain = typeof window !== "undefined" ? window.location.hostname : "";

    // Ask server to resolve room + determine host vs viewer.
        const displayNameForToken = isHost
      ? String(companionName || "Host").trim()
      : String(ensureViewerLiveChatName() || viewerLiveChatName || "").trim();

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

    setStreamNotice(
      sessionActive ? "Live stream is active. Connecting…" : "Waiting for host to start stream…"
    );
    setAvatarStatus("waiting");
    return;
  } catch (err: any) {
    console.error("LiveKit start failed:", err);
    setAvatarStatus("error");
    setAvatarError(`Live session failed to start. ${err?.message ? String(err.message) : String(err)}`);
    return;
  }
}

if (!phase1AvatarMedia) {
  setAvatarStatus("error");
  setAvatarError("Live Avatar is not enabled for this companion in Phase 1.");
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
      phase1AvatarMedia.didAgentId,
      {
      auth: { type: "key", clientKey: phase1AvatarMedia.didClientKey },
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
}, [phase1AvatarMedia, avatarStatus, liveProvider, streamUrl, companyName, companionName, reconnectLiveAvatar, ensureIphoneAudioContextUnlocked, applyIphoneLiveAvatarAudioBoost]);

useEffect(() => {
  // Stop when switching companions
  void stopLiveAvatar();
}, [companionKey]); // eslint-disable-line react-hooks/exhaustive-deps

const getTtsAudioUrl = useCallback(async (text: string, voiceId: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const res = await fetch(`${API_BASE}/tts/audio-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        session_id: sessionIdRef.current || "anon",
        voice_id: voiceId,
        brand: companyName,
        avatar: companionName,
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
}, []);

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

      await playLocalTtsUrl(audioUrl, hooks);
    },
    [getTtsAudioUrl, playLocalTtsUrl]
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
    if (!phase1AvatarMedia) {
      callDidNotSpeak();
      return;
    }

    const audioUrl = await getTtsAudioUrl(clean, phase1AvatarMedia.elevenVoiceId);
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
  [avatarStatus, phase1AvatarMedia, getTtsAudioUrl, reconnectLiveAvatar]
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
  const [loading, setLoading] = useState(false);
  const [showClearMessagesConfirm, setShowClearMessagesConfirm] = useState(false);
  const [showSaveSummaryConfirm, setShowSaveSummaryConfirm] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
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

  const [planName, setPlanName] = useState<PlanName>(null);

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


    // Lightweight viewer auto-refresh: if you are not the host, keep polling until the host creates/starts the event.
  // This avoids requiring manual page refresh for viewers waiting on the host.
  useEffect(() => {
    // Only poll while we are explicitly waiting and we don't yet have an embed URL.
    if (avatarStatus !== "waiting") return;
    if (streamEventRef) return;

    let cancelled = false;
    const intervalMs = 3000;

    const poll = () => {
      const embedDomain = (typeof window !== "undefined" && window.location) ? window.location.hostname : "";

      fetch(`${API_BASE}/stream/livekit/start_embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: companyName,
          avatar: companionName,
          memberId: memberIdRef.current || "",
          displayName: displayNameForToken,
          embedDomain,
        }),
      })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data: any) => {
          if (!data || cancelled) return;

          const roomName = String(data?.roomName || "").trim();
          const token = String(data?.token || "").trim();
          const isActive = Boolean(data?.sessionActive);

          if (token && roomName) {
            joinedStreamRef.current = true;
            setLivekitRole("viewer");
            setLivekitRoomName(roomName);
            setLivekitToken(token);
            setSessionActive(true);
            setSessionKind("stream");
            setSessionRoom(roomName);
            setStreamEventRef(roomName);
            setAvatarStatus("connected");
            setStreamNotice("");
            return;
          }

          if (data?.message) {
            setStreamNotice(String(data.message));
          } else {
            setStreamNotice(isActive ? "Live stream is active. Connecting…" : "Waiting for host to start stream…");
          }

        })
        .catch((_e) => {
          // Ignore transient failures; keep polling.
        });
    };

    // Kick once immediately, then interval.
    poll();
    const t = window.setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [avatarStatus, "", API_BASE, companyName, companionName, memberId]);

  const [loggedIn, setLoggedIn] = useState<boolean>(false);
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

// Jitsi (conference) embedding
const jitsiContainerRef = useRef<HTMLDivElement | null>(null);
const jitsiApiRef = useRef<any>(null);
const conferenceOptOutRef = useRef<boolean>(false);
const [jitsiError, setJitsiError] = useState<string>("");

// Track whether THIS client has actually joined the private (Jitsi) session.
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
      return String(streamEventRef || "").trim();
    };

    const eventRef = computeLiveChatEventRef();

    // IMPORTANT: this must be independent from the current UI mode (liveProvider).
    // Once a user has joined a live experience, they should remain connected to shared chat
    // until they explicitly press Stop (host) or opt-out (viewer, private session only).
    const inStreamUi =
      Boolean(sessionActive) &&
      kind !== "conference" &&
      Boolean(streamEventRef) &&
      !!String(streamEventRef || "").trim() &&
      !!eventRef;

    const inConferenceUi =
      Boolean(sessionActive) &&
      kind === "conference" &&
      !!eventRef &&
      (conferenceJoined || Boolean(jitsiApiRef.current));

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
      role === "host" ? String(companionName || "Host") : String(viewerLiveChatName || "").trim() || "Viewer";
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
        const payload = JSON.parse(evt.data);
        if (payload?.type === "history" && Array.isArray(payload.messages)) {
          for (const m of payload.messages) appendLiveChatMessage(m);
          return;
        }
        if (payload?.type === "message") {
          appendLiveChatMessage(payload.message || payload);
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
    viewerLiveChatName,
    appendLiveChatMessage,
    sessionKind,
    sessionRoom,
    companyName,
    conferenceJoined,
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
        eventRef = String(streamEventRef || "").trim();
      }

      if (!API_BASE || !eventRef) return;
      const clean = String(text || '').trim();
      if (!clean) return;

      const role = isHost ? 'host' : 'viewer';
      const name =
        role === 'host'
          ? (String(companionName || 'Host').trim() || 'Host')
          : (String(viewerLiveChatName || '').trim() || (memberIdForLiveChat ? `Viewer-${memberIdForLiveChat.slice(-4)}` : 'Viewer'));
      const payload = {
        type: 'chat',
        text: clean,
        clientMsgId: String(clientMsgId || '').trim(),
        ts: Date.now(),
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
        await fetch(`${API_BASE}/stream/livekit/livechat/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventRef,
            text: clean,
            memberId: memberIdForLiveChat,
            role,
            name,
            clientMsgId: payload.clientMsgId,
            ts: payload.ts,
          }),
        });
      } catch (e) {
        // ignore
      }
    },
    [API_BASE, streamEventRef, isHost, memberIdForLiveChat, companionName, viewerLiveChatName, sessionKind, sessionRoom, companyName],
  );

  const [showBroadcasterOverlay, setShowBroadcasterOverlay] = useState<boolean>(false);
  const [broadcasterOverlayUrl, setBroadcasterOverlayUrl] = useState<string>("");
  const [broadcastPreparing, setBroadcastPreparing] = useState<boolean>(false);
  const [broadcastError, setBroadcastError] = useState<string>("");


// LegacyStream "live session" gating (global per companion)
// - While the host is streaming, we must NOT generate AI responses for anyone.
// - We queue user messages locally and flush them once the host stops streaming.
const streamDeferredQueueRef = useRef<Array<{ text: string; state: SessionState; queuedAt: number; noticeIndex: number }>>([]);
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
// Jitsi (Conference) helpers
// ===============================
const sanitizeRoomToken = useCallback((raw: string, maxLen = 128) => {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
  const out = s.length ? s : "room";
  return out.slice(0, maxLen);
}, []);

const ensureJitsiExternalApiLoaded = useCallback(async (): Promise<void> => {
  if (typeof window === "undefined") return;
  if (window.JitsiMeetExternalAPI) return;

  const domain = String(process.env.NEXT_PUBLIC_JITSI_DOMAIN || "meet.jit.si").replace(/^https?:\/\//, "");
  const scriptUrl = `https://${domain}/external_api.js`;

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-jitsi-external-api="1"]');
    if (existing) {
      if (window.JitsiMeetExternalAPI) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Jitsi External API")));
      return;
    }

    const s = document.createElement("script");
    s.src = scriptUrl;
    s.async = true;
    s.dataset.jitsiExternalApi = "1";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Jitsi External API script"));
    document.head.appendChild(s);
  });
}, []);

const disposeJitsi = useCallback(() => {
  try {
    jitsiApiRef.current?.dispose?.();
  } catch {
    // ignore
  }
  jitsiApiRef.current = null;

  if (jitsiContainerRef.current) {
    jitsiContainerRef.current.innerHTML = "";
  }

  // Leaving the private session should immediately reflect in UI + chat gating.
  conferenceJoinedRef.current = false;
  setConferenceJoined(false);

  setJitsiError("");
}, []);

const stopConferenceSession = useCallback(async () => {
  // Viewers leaving the conference should not stop the host session.
  if (!isHost) {
    conferenceOptOutRef.current = true;
    setLivekitToken("");
    setAvatarStatus("idle");
    return;
  }

  // Optimistic close (prevents auto-rejoin while stop request is in-flight)
  conferenceOptOutRef.current = true;
  setLivekitToken("");
  setSessionActive(false);
  setSessionKind("");
  setSessionRoom("");
  setAvatarStatus("idle");

  try {
    await fetch(`${API_BASE}/conference/livekit/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand: companyName, avatar: companionName, memberId: memberId || "" }),
    });
  } catch {
    // best effort
  }
}, [API_BASE, companyName, companionName, disposeJitsi, isHost, memberId]);

const joinJitsiConference = useCallback(
  async (roomName: string) => {
    const room = String(roomName || "").trim();
    if (!room) return;

    // Respect explicit "leave" by viewers while the session is still active
    if (conferenceOptOutRef.current && !isHost) return;

    // Avoid recreating the iframe on every state poll
    if (jitsiApiRef.current) return;

    if (!jitsiContainerRef.current) {
      setJitsiError("Conference container not ready.");
      return;
    }

    setJitsiError("");
    setAvatarStatus("connecting");

    try {
      await ensureJitsiExternalApiLoaded();
      if (!window.JitsiMeetExternalAPI) {
        throw new Error("JitsiMeetExternalAPI is not available.");
      }

      // Clear any previous iframe
      jitsiContainerRef.current.innerHTML = "";

      const domain = String(process.env.NEXT_PUBLIC_JITSI_DOMAIN || "meet.jit.si").replace(/^https?:\/\//, "");
      // Use the same username state used for Shared Live Chat.
      // Host should present as the companion name (e.g., "Dulce") inside the Jitsi UI.
      const displayName = isHost
        ? (String(companionName || "Host").trim() || "Host")
        : (String(viewerLiveChatName || "").trim() || (memberId ? "Member" : "Guest"));
      const subject = `${companyName} • ${companionName}`.trim();

      const options: any = {
        roomName: room,
        parentNode: jitsiContainerRef.current,
        width: "100%",
        height: "100%",
        userInfo: { displayName },
        configOverwrite: {
          prejoinPageEnabled: false,
          disableDeepLinking: true,
          subject,
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          SHOW_POWERED_BY: false,
          DEFAULT_REMOTE_DISPLAY_NAME: "Guest",
          TOOLBAR_BUTTONS: [
            "microphone",
            "camera",
            "desktop",
            "fullscreen",
            "fodeviceselection",
            "hangup",
            "chat",
            "settings",
            "tileview",
          ],
        },
      };

      const api = new window.JitsiMeetExternalAPI(domain, options);
      jitsiApiRef.current = api;

      api.addListener?.("videoConferenceJoined", () => {
        conferenceJoinedRef.current = true;
        setConferenceJoined(true);
        setAvatarStatus("connected");
        try {
          if (subject) api.executeCommand?.("subject", subject);
        } catch {
          // ignore
        }
      });

      api.addListener?.("readyToClose", () => {
        // If the user hangs up, prevent auto-rejoin while the host session is still active.
        conferenceOptOutRef.current = true;

        conferenceJoinedRef.current = false;
        setConferenceJoined(false);

        disposeJitsi();
        setAvatarStatus("idle");

        // Host hanging up should end the session for viewers as well.
        if (isHost) {
          void stopConferenceSession();
        }
      });
    } catch (err: any) {
      const msg = err?.message || "Conference failed to start.";
      setJitsiError(msg);
      disposeJitsi();
      setAvatarStatus("idle");
    }
  },
  [
    companyName,
    companionName,
    disposeJitsi,
    ensureJitsiExternalApiLoaded,
    isHost,
    memberId,
    stopConferenceSession,
	  viewerLiveChatName,
  ]
);

  const startConferenceSession = useCallback(async () => {
    setAvatarError(null);

    // Viewers request to join a private session. The host must admit them.
    if (!isHost) {
      setStreamNotice(null);
      setAvatarStatus("waiting");

      // Reset any prior join attempt / token.
      setConferenceJoined(false);
      setLivekitJoinRequestId("");
      setLivekitToken("");
      setLivekitRole("viewer");

      // Mark intent so the "waiting to be admitted" overlay can render.
      setSessionKind("conference");

      const requestedRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
      if (requestedRoom) {
        setSessionRoom(requestedRoom);
        setLivekitRoomName(requestedRoom);
      }

      // Clear any prior live-chat transcript for a clean join.
      setMessages((prev) => prev.filter((m) => !m?.meta?.liveChat));
      liveChatSeenIdsRef.current = new Set();

      try {
        const resp = await fetch(`${API_BASE}/livekit/join_request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            roomName: requestedRoom,
            memberId: memberId || "",
            displayName: String(viewerLiveChatName || "Viewer").trim(),
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
      setLivekitRole("host");
      setLivekitToken(token);
      setConferenceJoined(true);
      setAvatarStatus("connected");
    } catch (err: any) {
      setAvatarError(err?.message || "Network error starting private session.");
      setAvatarStatus("idle");
    }
  }, [API_BASE, companyName, companionName, isHost, memberId, sanitizeRoomToken, viewerLiveChatName]);

// Keep refs to the latest state for async flush logic (avoids stale closures).
const messagesRef = useRef<Msg[]>([]);
useEffect(() => {
  messagesRef.current = messages;
}, [messages]);

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

  const goToUpgrade = useCallback(() => {
    const url = upgradeUrl;

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
  }, [upgradeUrl]);



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


        const nextActive = Boolean(data.sessionActive);
        const rawKind = String((data as any).sessionKind || "").trim().toLowerCase();
        const nextKind: SessionKind =
          rawKind === "conference" || rawKind === "stream" ? (rawKind as SessionKind) : nextActive ? "stream" : "";
        const nextRoom = String(
          (data as any).room ||
            (data as any).sessionRoom ||
            (data as any).roomName ||
            ""
        ).trim();

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

  // Conference auto-join: when the host starts a Jitsi conference, viewers should wait
  // until session_active is true, then the app embeds Jitsi in-page.
  useEffect(() => {
    if (!(sessionActive && sessionKind === "conference")) {
      if (jitsiApiRef.current) {
        disposeJitsi();
      }
      return;
    }

    if (conferenceOptOutRef.current) return;

    const fallbackRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
    const room = (sessionRoom || fallbackRoom).trim();

    // Ensure the avatar frame is visible

    void joinJitsiConference(room);
  }, [
    sessionActive,
    sessionKind,
    sessionRoom,
    companyName,
    companionName,
    sanitizeRoomToken,
    joinJitsiConference,
    disposeJitsi,
  ]);


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
    if (typeof window === "undefined") return "";
    const hint =
      " (If this page is embedded, ensure the embed/iframe allows microphone access.)";
    try {
      return window.self !== window.top ? hint : "";
    } catch (e) {
      return hint;
    }
  }, []);


  // Greeting once per browser session per companion
// Fix: if companionName arrives AFTER the initial greeting timer (e.g., slow Wix postMessage),
// we may have already inserted the default "Elara" greeting. If the user hasn't typed yet,
// replace the greeting so it matches the selected companion.
useEffect(() => {
  if (typeof window === "undefined") return;

  const desiredName =
    (companionName || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;

  const keyName = normalizeKeyForFile(desiredName);
  const greetKey = `${GREET_ONCE_KEY}:${keyName}`;

  const tmr = window.setTimeout(() => {
    const already = sessionStorage.getItem(greetKey) === "1";
    const greetingText = greetingFor(desiredName);

    const greetingMsg: Msg = {
      role: "assistant",
      content: greetingText,
    };

    setMessages((prev) => {
      // If no messages yet, insert greeting only if we elara't greeted this companion in this session.
      if (prev.length === 0) {
        return already ? prev : [greetingMsg];
      }

      // If the only existing message is a greeting for a different companion (and no user messages yet),
      // replace it so the name matches the current companion.
      if (prev.length === 1 && prev[0].role === "assistant") {
        const existing = String((prev[0] as any)?.content ?? "");
        const m = existing.match(/^Hi,\s*(.+?)\s+here\./i);
        const existingName = m?.[1]?.trim();
        if (existingName && existingName.toLowerCase() !== desiredName.toLowerCase()) {
          return [{ ...prev[0], content: greetingText }];
        }
      }

      return prev;
    });

    if (!already) sessionStorage.setItem(greetKey, "1");
  }, 150);

  return () => window.clearTimeout(tmr);
}, [companionName]);

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const msg =
      `The requested mode (${modeLabel}) isn't available on your current plan. ` +
      `Please upgrade here: ${upgradeUrl} or click the upgrade button below the text input box`;

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

      // loggedIn must come from Wix; do NOT infer from memberId.
      const incomingLoggedIn = (data as any).loggedIn;
      if (typeof incomingLoggedIn === "boolean") {
        setLoggedIn(incomingLoggedIn);
      } else {
        setLoggedIn(false);
      }

      const incomingPlan = normalizePlanName((data as any).planName);

      // Optional white-label brand handoff from Wix.
      // - Elaralo site should send: { rebrandingKey: "" }
      // - Rebranding sites should send the full RebrandingKey (pipe-delimited).
      //
      // IMPORTANT: This must never alter STT/TTS start/stop code paths.
      let rawRebrandingKey = "";

      if (
        "rebrandingKey" in (data as any) ||
        "rebranding_key" in (data as any) ||
        "RebrandingKey" in (data as any) ||
        "rebrandingkey" in (data as any)
      ) {
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
        rawRebrandingKey = rawRebrandingKey.trim();

        // Allow empty string to explicitly clear any previous rebranding state.
        setRebrandingKey(rawRebrandingKey);
      } else if ("rebranding" in (data as any)) {
        // Legacy support: some older Wix pages may still send { rebranding: "BrandName" }.
        rawRebrandingKey = typeof (data as any).rebranding === "string" ? String((data as any).rebranding).trim() : "";
        if (rawRebrandingKey) setRebrandingKey(rawRebrandingKey);
      }

      const rkParts = parseRebrandingKey(rawRebrandingKey);
      const rebrandSlugFromMessage = normalizeRebrandingSlug(rkParts?.rebranding || "");




      const incomingMemberId =
        typeof (data as any).memberId === "string"
          ? String((data as any).memberId).trim()
          : typeof (data as any).member_id === "string"
            ? String((data as any).member_id).trim()
            : "";
      setMemberId(incomingMemberId);

      // When RebrandingKey is present, use ElaraloPlanMap for capability gating
      // (Wix planName may be the rebrand site's plan names like "Supreme").
      const mappedPlanFromKey = normalizePlanName(String(rkParts?.elaraloPlanMap || ""));
      const hasEntitledPlan = Boolean((mappedPlanFromKey || incomingPlan).trim());
      const effectivePlan: PlanName = hasEntitledPlan ? (mappedPlanFromKey || incomingPlan) : "Trial";
      setPlanName(effectivePlan);

      // Display the rebranding site's plan label when provided (e.g., "Supreme"),
      // but only for logged-in members (Free Trial ignores plan labels by design).
      const planLabel = incomingMemberId ? String(rkParts?.plan || "").trim() : "";
      setPlanLabelOverride(planLabel);

      const incomingCompanion =
        typeof (data as any).companion === "string" ? (data as any).companion.trim() : "";
      const resolvedCompanionKey = incomingCompanion || "";
      const { baseKey } = splitCompanionKey(resolvedCompanionKey);

      if (resolvedCompanionKey) {
        setCompanionKeyRaw(resolvedCompanionKey);
        const parsed = parseCompanionMeta(baseKey || resolvedCompanionKey);
        setCompanionKey(parsed.key);
        setCompanionName(parsed.first || DEFAULT_COMPANION_NAME);

        // Keep session_state aligned with the selected companion so the backend can apply the correct persona.
        setSessionState((prev) => ({
          ...prev,
          companion: parsed.key,
          companionName: parsed.key,
          companion_name: parsed.key,
        }));
      } else {
        setCompanionKeyRaw("");
        setCompanionKey("");
        setCompanionName(DEFAULT_COMPANION_NAME);

        setSessionState((prev) => ({
          ...prev,
          companion: DEFAULT_COMPANION_NAME,
          companionName: DEFAULT_COMPANION_NAME,
          companion_name: DEFAULT_COMPANION_NAME,
        }));
      }

      const avatarCandidates = buildAvatarCandidates(baseKey || resolvedCompanionKey || DEFAULT_COMPANION_NAME, rebrandSlugFromMessage);
      pickFirstLoadableImage(avatarCandidates).then((picked) => setAvatarSrc(picked));

      // Brand-default starting mode:
      // - For DulceMoon (and any white-label that sends elaraloPlanMap), we start in the mode encoded in the key.
      // - Fallback: entitled plans default to Intimate, Trial/visitors default to Romantic.
      const desiredStartMode: Mode =
        modeFromElaraloPlanMap(rkParts?.elaraloPlanMap) || (hasEntitledPlan ? "intimate" : "romantic");

      const nextAllowed = allowedModesForPlan(effectivePlan);
      setAllowedModes(nextAllowed);

      setSessionState((prev) => {
        let nextMode: Mode = prev.mode;

        // If the previous mode is the default placeholder (Friend) or no longer allowed,
        // snap to the brand-default start mode (if allowed).
        if (nextAllowed.includes(desiredStartMode) && (!nextAllowed.includes(nextMode) || nextMode === "friend")) {
          nextMode = desiredStartMode;
        } else if (!nextAllowed.includes(nextMode)) {
          nextMode = "friend";
        }

        if (nextMode === prev.mode) return prev;
        return { ...prev, mode: nextMode, pending_consent: null };
      });

      // Mark handoff ready so the first audio-only TTS can deterministically use the selected companion voice.
      setHandoffReady(true);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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

// If the user is entitled (has a real Wix memberId + active plan), strip the trial controls
// from the rebranding key so backend quota comes from the mapped Elaralo plan.

// `loggedIn` is only available when the Wix parent posts it.
// For white-label, keep the full rebrandingKey intact so backend can apply minutes/mode/links overrides.
const rebrandingKeyForBackend = (rebrandingKey || "");

    const stateToSendWithCompanion: SessionState = {
  ...stateToSend,
  companion: companionForBackend,
  // Backward/forward compatibility with any backend expecting different field names
  companionName: companionForBackend,
  companion_name: companionForBackend,
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
};

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit,
        session_state: stateToSendWithCompanion,
        messages: trimMessagesForChat(nextMessages).map((m) => {
          let content = m.content || "";
          const att = m.meta?.attachment;
          if (att?.url) {
            const name = att.name || "attachment";
            content = `${content}${content ? "\n\n" : ""}Attachment: ${name}\n${att.url}`;
          }
          return { role: m.role, content };
        }),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatApiResponse;
  }

  async function callSaveChatSummary(nextMessages: Msg[], stateToSend: SessionState): Promise<{ ok: boolean; summary?: string; error_code?: string; error?: string; key?: string; saved_at?: string }> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const companionForBackend =
      (companionKey || "").trim() ||
      (companionName || DEFAULT_COMPANION_NAME).trim() ||
      DEFAULT_COMPANION_NAME;

    const effectivePlanForBackend = (memberId || "").trim() ? String(planName || "").trim() : "Trial";

    
// NOTE:
	// - `rebranding` (legacy) is not guaranteed to be present in this build.
	// - Use RebrandingKey as the single source of truth for brand identity.
	const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || DEFAULT_COMPANY_NAME).trim();
const brandKey = safeBrandKey(rawBrand);

// For visitors (no Wix memberId), generate a stable anon id so we can track freeMinutes usage.
const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

// If the user is entitled (has a real Wix memberId + active plan), strip the trial controls
// from the rebranding key so backend quota comes from the mapped Elaralo plan.
// For white-label, keep the full rebrandingKey intact so backend can apply minutes/mode/links overrides.
const rebrandingKeyForBackend = (rebrandingKey || "");

  const stateToSendWithCompanion: SessionState = {
      ...stateToSend,
      companion: companionForBackend,
      companionName: companionForBackend,
      companion_name: companionForBackend,
      planName: effectivePlanForBackend,
      plan_name: effectivePlanForBackend,
      plan: effectivePlanForBackend,
      memberId: (memberIdForBackend || "").trim(),
      member_id: (memberIdForBackend || "").trim(),

  // White-label handoff: pass RebrandingKey to backend so it can override Upgrade/PayGo URLs, minutes, etc.
  rebrandingKey: (rebrandingKeyForBackend || "").trim(),
  rebranding_key: (rebrandingKeyForBackend || "").trim(),
  RebrandingKey: (rebrandingKeyForBackend || "").trim(),
  // Legacy support: backend may still look at "rebranding" if RebrandingKey is absent
  rebranding: (rebranding || "").trim(),
};

    const res = await fetch(`${API_BASE}/chat/save-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        session_state: stateToSendWithCompanion,
        messages: nextMessages.map((m) => {
          let content = m.content || "";
          const att = m.meta?.attachment;
          if (att?.url) {
            const name = att.name || "attachment";
            content = `${content}${content ? "\n\n" : ""}Attachment: ${name}\n${att.url}`;
          }
          return { role: m.role, content };
        }),
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

    // Selecting Intimate (18+) requires explicit consent; trigger the consent overlay if not already consented.
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

    // Hard rule: no attachments during Shared Live streaming.
    if ((uploadsDisabled || hostInStreamUi || viewerInStreamUi) && hasAttachment) {
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
      // If we switch away from intimate while consent is pending, clear the pending flag
      const nextPending = detectedMode === "intimate" ? sessionState.pending_consent : null;
      nextState = { ...sessionState, mode: detectedMode, pending_consent: nextPending };

      // If user is switching away from intimate, also clear any explicit_blocked overlay state
      if (detectedMode !== "intimate") {
        setChatStatus("safe");
      }

      setSessionState(nextState);
    }

    // Build user message content:
    // If a [mode:*] token was present, we remove it from content (cleaned) to keep chat natural.
    
const outgoingText = (detectedMode ? cleaned : rawText).trim();
    // If the user sends an attachment without text, still create a stable message for the backend/UI.
    const finalUserContent = outgoingText || (hasAttachment ? "Sent an attachment." : "");

    // Build the user message.

    // Build the user message. During LegacyStream live sessions, this may also be
    // broadcast to the shared in-stream chat (without calling /chat).
    
let userMsg: Msg = { role: "user", content: finalUserContent };
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
        : (String(viewerLiveChatName || "").trim() ||
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
      }

      // Some backends return camelCase "sessionState" instead of snake_case "session_state"
      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      // Normalize & apply server session state WITHOUT using data.mode as pill mode
      if (serverSessionState) {
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

          // If the backend sent a mode (in session state OR top-level), normalize it so Romantic always highlights
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

      // Phase 1: Speak the assistant reply (if Live Avatar is connected).
      // When Live Avatar is active, we delay the assistant's text from appearing until
      // we are about to trigger the avatar speech.
      const replyText = String(data.reply || "");
      let assistantCommitted = false;
      const commitAssistantMessage = () => {
        if (assistantCommitted) return;
        assistantCommitted = true;
        setMessages((prev) => [...prev, { role: "assistant", content: replyText }]);

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
        avatarStatus === "connected" && !!phase1AvatarMedia && !!didAgentMgrRef.current;

      // Audio-only TTS is only played in hands-free STT mode (mic button enabled),
      // when Live Avatar is NOT speaking.
      const shouldUseLocalTts = !canLiveAvatarSpeak && sttEnabledRef.current;

      const speakPromise = (canLiveAvatarSpeak
        ? speakAssistantReply(replyText, hooks)
        : shouldUseLocalTts
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
      const userMsg: Msg = { role: "user", content: String(item?.text || "").trim() };
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

      // If this queued message came from an out-of-session user, we rendered a placeholder
      // notice bubble at noticeIndex. Replace it in-place so chat ordering stays coherent.
      const noticeIndex = Number((item as any)?.noticeIndex ?? -1);
      setMessages((prev) => {
        if (!Array.isArray(prev)) return prev as any;
        if (noticeIndex >= 0 && noticeIndex < prev.length) {
          const next = prev.slice();
          next[noticeIndex] = { role: "assistant", content: replyText };
          return next;
        }
        // Fallback: append if index missing/out-of-range (or in-session member).
        return [...prev, { role: "assistant", content: replyText }];
      });

      // Advance the backend history used for subsequent queued messages
      history = [...callMsgs, { role: "assistant", content: replyText }];

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
}, [callChat]);

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

  // Prefer backend STT for iOS **audio-only** mode (more stable than browser SpeechRecognition).
  // Keep Live Avatar mode on browser STT (it is already stable across devices).
  const useBackendStt = isIOS && backendSttAvailable && !liveAvatarActive && !isEmbedded;

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
        headers: { "Content-Type": contentType, Accept: "application/json" },
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
    [API_BASE, isIOS],
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());

      // Mic permission is granted once getUserMedia succeeds.
      micGrantedRef.current = true;
      setMicGranted(true);
      return true;
    } catch (e) {
      console.warn("Mic permission denied/unavailable:", e);
      setSttError(getEmbedHint());

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
  }, [getEmbedHint, isIOS, setBackendSttAvailable, useBackendStt]);

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
      rec.lang = "en-US";
    } catch (e) {
      // ignore
    }

    rec.onstart = () => {
      setSttRunning(true);
      setSttError(null);

      micGrantedRef.current = true;
      setMicGranted(true);
      // reset audio-capture fail window on successful start
      sttAudioCaptureFailsRef.current = 0;
      sttLastAudioCaptureAtRef.current = 0;
    };

    rec.onend = () => {
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

    rec.onerror = (event: any) => {
      const code = String(event?.error || "");

      if (code === "no-speech" || code === "aborted") {
        return;
      }

      if (code === "not-allowed" || code === "service-not-allowed") {
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        setSttEnabled(false);
        setSttRunning(false);
        clearSttSilenceTimer();
        clearSttRestartTimer();
        clearSttRecoverTimer();
        clearSttRecoverTimer();
        setSttError("Microphone permission was blocked." + getEmbedHint());
        try {
          rec.stop?.();
        } catch (e) {
          // ignore
        }
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
    // If Wix hasn't provided plan/companion yet, defer until the handoff arrives.
    if (mode === "audio" && !handoffReady) {
      pendingGreetingModeRef.current = "audio";
      return;
    }

    const name = (companionName || "").trim() || "Companion";
    const key = `ELARALO_GREET_SPOKEN:${name}`;

    // Already spoken this session?
    try {
      if (sessionStorage.getItem(key) === "1") return;
    } catch (e) {}

    // Prevent duplicates/races (e.g., Live Avatar connects right after mic-start).
    if (greetInFlightRef.current) return;
    greetInFlightRef.current = true;

    // IMPORTANT: do NOT prefix with "Name:"; the UI already labels the assistant bubble.
    // Keeping the spoken text free of the prefix prevents the avatar from reading its own name like a script cue.
    const greetText = `Hi, I'm ${name}. I'm here with you. How are you feeling today?`;
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
    companionMapping,
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

    // Live Avatar greeting must wait until the agent is fully connected.
    if (mode === "live") {
      if (avatarStatus !== "connected" || !didAgentMgrRef.current) return;
    }

    // Clear first so we don't re-enter if something throws.
    pendingGreetingModeRef.current = null;
    await speakGreetingIfNeeded(mode);
  }, [avatarStatus, speakGreetingIfNeeded]);

  // If the user started an audio-only experience before the Wix handoff arrived,
  // play the pending greeting once plan/companion information is available.
  useEffect(() => {
    if (!handoffReady) return;
    if (!pendingGreetingModeRef.current) return;
    void maybePlayPendingGreeting();
  }, [handoffReady, maybePlayPendingGreeting]);

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

    // Conference: Stop/leave Jitsi (host stops the session for everyone).
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
    if (liveProvider === "stream" && streamCanStart && (streamEventRef)) {
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

  // Save Chat Summary (with confirmation)
  const requestSaveChatSummary = useCallback(() => {
    // REQUIREMENT: behave like Clear Messages with respect to media stability.
    // We halt all communication immediately using the Stop button logic.
    // The user will manually choose what to resume after selecting Yes/No.
    // IMPORTANT: Unlike Clear, do NOT bump clearEpochRef or change loading state here;
    // doing so can interfere with subsequent reply speaking.

    try {
      stopHandsFreeSTT();
    } catch (e) {}

    // User gesture: re-assert boosted audio routing and nudge audio session back to playback mode.
    try {
      boostAllTtsVolumes();
    } catch (e) {}
    try {
      void nudgeAudioSession();
    } catch (e) {}

    // Prime the hidden VIDEO element on this user gesture so audio-only TTS remains healthy.
    try {
      primeLocalTtsAudio(true);
    } catch (e) {}
    try {
      void ensureIphoneAudioContextUnlocked();
    } catch (e) {}

    setShowSaveSummaryConfirm(true);
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

// Private session (Jitsi) stop rules.
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
                    viewerInStreamUi || (!sttEnabled && loading) || (liveAvatarActive && sttEnabled)}
        title="Audio"
        style={{
          width: 44,
          minWidth: 44,
          borderRadius: 10,
          border: "1px solid #111",
          background: sttEnabled ? "#b00020" : "#fff",
          color: sttEnabled ? "#fff" : "#111",
          cursor: (liveProvider === "stream" && streamCanStart && Boolean(streamEventRef) && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "not-allowed" : "pointer",
          opacity: (liveProvider === "stream" && streamCanStart && Boolean(streamEventRef) && (avatarStatus === "connected" || avatarStatus === "waiting")) ? 0.6 : 1,
          fontWeight: 700,
        }}
      >
        🎤
      </button>

      {liveProvider !== "stream" && (
        <button
          type="button"
          onClick={handleStopClick}
          disabled={!(sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference)}
          style={{
            border: "1px solid rgba(255,255,255,0.35)",
            background: "transparent",
            color: "#fff",
            width: 44,
            height: 44,
            borderRadius: 12,
            cursor: (sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference) ? "pointer" : "not-allowed",
            opacity: (sttEnabled || viewerCanStopStream || hostCanStopStream || viewerCanStopConference || hostCanStopConference) ? 1 : 0.45,
            fontWeight: 700,
          }}
        >
          ■
        </button>
      )}
</>
  );

  
  const visibleModePills = useMemo(() => {
    // Keep stable ordering regardless of allowedModes ordering.
    const ordered: Mode[] = ["friend", "romantic", "intimate"];
    return ordered.filter((m) => allowedModes.includes(m));
  }, [allowedModes]);

  const showUpgradePill = useMemo(() => {
    // Requirement: show Upgrade whenever Friend and/or Romantic pills are available,
    // except when Intimate (18+) is available (no further upgrade path).
    return !allowedModes.includes("intimate") && (allowedModes.includes("friend") || allowedModes.includes("romantic"));
}, [allowedModes]);


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

    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {!showModePicker ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>{!hideSetModeInStream ? (

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
            }}
          >
            Set Mode
          </button>
) : null}


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
                opacity: broadcastPreparing ? 0.75 : 1,
              }}
              disabled={broadcastPreparing}
              aria-pressed={showBroadcasterOverlay}
              title="Show/Hide Broadcast UI"
            >
              {broadcastPreparing ? "Broadcast…" : "Broadcast"}
            </button>
          ) : null}



          {(!rebrandingKey || String(rebrandingKey).trim() === "") && (
            <button
              type="button"
              onClick={() => {
                setSwitchCompanionFlash(true);
                window.setTimeout(() => {
                  goToMyElaralo();
                  setSwitchCompanionFlash(false);
                }, 120);
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #111",
                background: switchCompanionFlash ? "#111" : "#fff",
                color: switchCompanionFlash ? "#fff" : "#111",
                cursor: "pointer",
                fontWeight: 400,
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Switch Companion
            </button>
          )}
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
                }}
              >
                {MODE_LABELS[m]}
              </button>
            );
          })}

          {showUpgradePill ? (
            <button
              key="upgrade"
              onClick={() => {
                setShowModePicker(false);
                goToUpgrade();
              }}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: "#fff",
                color: "#111",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Upgrade
            </button>
          ) : null}

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

  return (
    <main onPointerDown={handleAnyUserGesture} onTouchStart={handleAnyUserGesture} onClick={handleAnyUserGesture} style={{ maxWidth: 880, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      {/* Hidden audio element for audio-only TTS (mic mode) */}
      <audio ref={localTtsAudioRef} style={{ display: "none" }} />
      {/* Hidden video element used on iOS to play audio-only TTS reliably (matches Live Avatar routing) */}
      <video
        ref={localTtsVideoRef}
        playsInline
        preload="auto"
        style={{ position: "fixed", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
      />
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

            {jitsiError ? (
              <div style={{ marginTop: 12, color: "#ffb4b4", fontSize: 12 }}>{jitsiError}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div aria-hidden onClick={secretDebugTap} style={{ width: 56, height: 56, borderRadius: "50%", overflow: "hidden" }}>
          <img
            // Prefer a companion headshot when available; otherwise show the current company logo (rebranded or default).
            src={((avatarSrc && avatarSrc !== DEFAULT_AVATAR) ? avatarSrc : companyLogoSrc) || DEFAULT_AVATAR}
            alt={companyName}
            style={{ width: "100%", height: "100%" }}
            onError={(e) => {
              // IMPORTANT: Persist the fallback in state to prevent flicker on subsequent renders.
              const fallback = (companyLogoSrc || DEFAULT_AVATAR);
              (e.currentTarget as HTMLImageElement).src = fallback;
              setAvatarSrc(fallback);
            }}
          />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{companyName}</h1>
          <div style={{ fontSize: 12, color: "#666" }}>
            Companion: <b>{companionName || DEFAULT_COMPANION_NAME}</b> • Plan:{" "}
            <b>{displayPlanLabel(planName, memberId, planLabelOverride)}</b>
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            Mode: <b>{MODE_LABELS[effectiveActiveMode]}</b>
            {chatStatus === "explicit_allowed" ? (
              <span style={{ marginLeft: 8, color: "#0a7a2f" }}>• Consent: Allowed</span>
            ) : chatStatus === "explicit_blocked" ? (
              <span style={{ marginLeft: 8, color: "#b00020" }}>• Consent: Required</span>
            ) : null}
          </div>
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
                  ● {hostInStreamUi ? "Hosting live session" : "Joined live session"}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
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

{liveEnabled ? (
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
      <button
        onClick={() => {
          // Stream provider: Play = join/start. It must NOT toggle to Pause.
          // Leaving the session is done exclusively via Stop.
          if (liveProvider === "stream") {
            if (viewerHasJoinedStream || (avatarStatus !== "idle" && avatarStatus !== "error")) return;

            // If a conference is active, Play joins it (no STT).
            if (sessionActive && sessionKind === "conference") {
              conferenceOptOutRef.current = false;

              const fallbackRoom = sanitizeRoomToken(`${companyName}-${companionName}`);
              const room = (sessionRoom || fallbackRoom).trim();
              void joinJitsiConference(room);
              return;
            }

            // Host-only: when idle, prompt for Stream vs Conference.
            if (isHost && !sessionActive) {
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
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid #111",
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
          <PlayIcon />
        ) : avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      {liveProvider === "stream" && ((isHost && sessionActive) || (!isHost && viewerHasJoinedStream)) ? (
        <button
          type="button"
          onClick={() => {
            void stopLiveAvatar();
          }}
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            border: "1px solid #ddd",
            background: "#fff",
            color: "#111",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            fontWeight: 700,
          }}
          aria-label={isHost ? "Stop live stream" : "Leave live stream"}
          title={isHost ? "Stop live stream" : "Leave live stream"}
        >
          <StopIcon />
        </button>
      ) : null}

      {/* When a Live Avatar is available, place mic/stop controls to the right of play/pause */}
      {sttControls}

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
          {String(viewerLiveChatName || "").trim() ? "Change username" : "Set username"}
        </button>
      ) : null}

      <div style={{ fontSize: 12, color: "#666" }}>
        Live Avatar: <b>{avatarStatus}</b>
        {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
      </div>
    </div>

    {/* Right-justified Mode controls */}
    {modePillControls}
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
                flex: liveProvider === "stream" && !isHost ? "2 1 0" : "0 0 360px",
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
                {liveProvider === "stream" && livekitToken ? (
                  <LiveKitRoom
                    token={livekitToken}
                    serverUrl={livekitServerUrl || LIVEKIT_URL}
                    connect={true}
                    audio={livekitRole !== "viewer"}
                    video={livekitRole !== "viewer"}
                    onConnected={() => {
                      // Host: once connected we treat the session as active.
                      if (livekitRole === "host") setSessionActive(true);
                      // Conference: track that we've joined the room.
                      if (sessionKind === "conference") setConferenceJoined(true);
                    }}
                    onDisconnected={() => {
                      setConferenceJoined(false);
                      setLivekitToken(null);
                      setLivekitRole(null);
                      // Viewer disconnect should not mark the session inactive globally;
                      // the status poller will reflect whether the host is still live.
                      if (isHost) setSessionActive(false);
                    }}
                    style={{ width: "100%", height: "100%" }}
                  >
                    {sessionKind === "stream" && livekitRole === "viewer" ? (
                      <LiveKitStreamViewerStage />
                    ) : (
                      <VideoConference
                        chatMessageFormatter={undefined as any}
                        onError={(e: any) => {
                          console.warn("LiveKit UI error", e);
                        }}
                      />
                    )}

                    {livekitRole === "host" && livekitPending.length > 0 ? (
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
                            {livekitPending.map((req) => (
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
                                    Deny
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
                                    Admit
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
                  livekitHlsUrl ? (
                    <LiveKitHlsPlayer src={livekitHlsUrl} />
                  ) : (
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
                        ? "Waiting for the broadcast…"
                        : isHost
                        ? "Press Play to start a session."
                        : "Host is offline."}
                    </div>
                  )
                ) : null}

                {avatarStatus !== "connected" ? (
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
                      flex: showAvatarFrame ? ((liveProvider === "stream" && Boolean(streamEventRef) && !streamCanStart) ? "1 1 0" : "2 1 0") : "1 1 0",
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
                      {messages.map((m, i) => {
                        const meta: any = (m as any).meta;
                        const displayName =
                          meta?.liveChat && meta?.name
                            ? String(meta.name)
                            : m.role === "assistant"
                            ? (companionName || DEFAULT_COMPANION_NAME)
                            : "You";

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
                      {loading ? <div style={{ color: "#666" }}>Thinking…</div> : null}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center", position: "sticky", bottom: 0, background: "#fff", paddingTop: 10, paddingBottom: 10, zIndex: 20, borderTop: "1px solid #eee" }}>
                      {/** Input line with mode pills moved to the right (layout-only). */}
                      <button
                            type="button"
                            onClick={requestSaveChatSummary}
                            title="Save"
                            aria-label="Save"
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 10,
                              border: "1px solid #bbb",
                              background: "#fff",
                              cursor: "pointer",
                              opacity: 1,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <SaveIcon size={18} />
                          </button>

                          <button
                            type="button"
                            onClick={requestClearMessages}
                            title="Clear"
                            aria-label="Delete"
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 10,
                              border: "1px solid #bbb",
                              background: "#fff",
                              cursor: "pointer",
                              opacity: 1,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <TrashIcon size={18} />
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
                        disabled={
                          loading ||
                          uploadingAttachment ||
                          uploadsDisabled ||
                          hostInStreamUi ||
                          viewerInStreamUi
                        }
                        title={
                          uploadsDisabled || hostInStreamUi || viewerInStreamUi
                            ? "Attachments are disabled during Shared Live streaming."
                            : "Attach a file"
                        }
                        className="rounded border border-gray-300 bg-white px-3 py-2 text-sm"
                        style={{ height: 44, minWidth: 44 }}
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
                            : "Type a message…"
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
                              connect={true}
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
                              {sessionKind === "stream" && livekitRole === "viewer" ? (
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



      {/* Save Chat Summary confirmation overlay */}
      {showSaveSummaryConfirm && (
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
              maxWidth: 560,
              width: "100%",
              boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Save chat summary?
            </div>
            <div style={{ fontSize: 14, color: "#333", lineHeight: 1.4 }}>
              Saving stores a server-side summary of this conversation for future reference across your devices.
              By selecting <b>Yes, save</b>, you authorize AI Elara to store chat summary data associated with your
              account for later use.
              <div style={{ marginTop: 8 }}>
                All audio, video, and mic listening have been stopped. You can resume manually using the controls
                after closing this dialog.
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button
                type="button"
                onClick={() => {
                  if (savingSummary) return;
                  setShowSaveSummaryConfirm(false);
                  // Maintain the same post-modal audio/TTS hardening used by Clear Messages.
                  try { boostAllTtsVolumes(); } catch (e) {}
                  void restoreVolumesAfterClearCancel();
                }}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #bbb",
                  background: "#fff",
                  cursor: savingSummary ? "not-allowed" : "pointer",
                  opacity: savingSummary ? 0.65 : 1,
                }}
              >
                No
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (savingSummary) return;
                  setSavingSummary(true);
                  const rawCompanionLabel = (
                     (companionName || "").trim() ||
                    (companionKey || "").trim() ||
                    DEFAULT_COMPANION_NAME
                  ).trim() || DEFAULT_COMPANION_NAME;

                  // For user-facing messages, show only the companion's first name (no demographics).
                  const companionForDisplay = (() => {
                    const s = rawCompanionLabel;
                    const afterNs = s.includes("::") ? (s.split("::").pop() || s) : s;
                    const base = (afterNs.split("-")[0] || "").trim();
                    return base || afterNs || DEFAULT_COMPANION_NAME;
                  })();
                  try {
                    const payloadMessages = messages.slice();
                    if (payloadMessages.length === 0) {
                      setMessages((prev) => [
                        ...prev,
                        { role: "assistant", content: "There is nothing to save yet." },
                      ]);
                      setShowSaveSummaryConfirm(false);
                      return;
                    }

                    const resp = await callSaveChatSummary(payloadMessages, sessionState);
                    if (resp?.ok) {
                      const keyHint = typeof resp?.key === "string" ? resp.key : "";
                      const persistHint = keyHint.startsWith("session::")
                        ? " (note: no memberId detected; memory will not persist across new sessions)"
                        : "";
                      setMessages((prev) => [
                        ...prev,
                        { role: "assistant", content: `Chat saved for ${companionForDisplay}.${persistHint}` },
                      ]);
                    } else {
                      setMessages((prev) => [
                        ...prev,
                        { role: "assistant", content: `Chat NOT saved for ${companionForDisplay}${resp?.error_code ? ` (reason: ${resp.error_code})` : ""}.` },
                      ]);
                    }
                  } catch (e) {
                    setMessages((prev) => [
                      ...prev,
                      { role: "assistant", content: `Save failed for ${companionForDisplay}: ${String(e?.message || e)}` },
                    ]);
                  } finally {
                    setSavingSummary(false);
                    setShowSaveSummaryConfirm(false);
                    // Maintain the same post-modal audio/TTS hardening used by Clear Messages.
                    try { boostAllTtsVolumes(); } catch (e) {}
                    void restoreVolumesAfterClearCancel();
                  }
                }}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: savingSummary ? "not-allowed" : "pointer",
                  opacity: savingSummary ? 0.7 : 1,
                }}
              >
                {savingSummary ? "Saving…" : "Yes, save"}
              </button>
            </div>
          </div>
        </div>
      )}

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
              To enable <b>Intimate (18+)</b> mode, please confirm you are 18+ and consent to an
              Intimate (18+) conversation.
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  // Ensure backend receives pending_consent + intimate mode
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
                  setSessionState((prev) => ({ ...prev, pending_consent: null, mode: "friend" }));
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