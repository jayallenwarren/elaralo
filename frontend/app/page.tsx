"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import elaraLogo from "../public/elaralo-logo.png";


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
type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

type Mode = "friend" | "romantic" | "intimate";

type LiveProvider = "did" | "stream";
type ChannelCap = "audio" | "video" | "";

type CompanionMappingRow = {
  found?: boolean;
  brand?: string;
  avatar?: string;
  communication?: string; // "Audio" | "Video"
  live?: string; // "D-ID" | "Stream"
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
  } catch {}
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
  } catch {
    // Some browsers/settings can block localStorage in a third-party iframe context.
    // Secondary: sessionStorage (sticky for the tab session).
    try {
      const ssKey = `ELARALO_SESSION_ANON_ID::${safeBrandKey(brand)}`;
      const existing = window.sessionStorage.getItem(ssKey);
      if (existing && existing.trim()) return `${ANON_ID_PREFIX}${existing.trim()}`;
      const id = generateAnonId();
      window.sessionStorage.setItem(ssKey, id);
      return `${ANON_ID_PREFIX}${id}`;
    } catch {
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
  } catch {
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
    } catch {
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
    } catch {
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
          } catch {
            // ignore per-origin parse issues
          }
        }
      }
    } catch {
      // ignore ancestorOrigins issues
    }

    return false;
  } catch {
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
    } catch {
      // Cross-origin access to window.top can throw; assume embedded.
      return true;
    }
  }, []);


  const sessionIdRef = useRef<string | null>(null);

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
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
    if (typeof window === "undefined") return;
    try {
      if (debugEnabled) window.localStorage.setItem(DEBUG_KEY, "1");
      else window.localStorage.removeItem(DEBUG_KEY);
    } catch {
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
          } catch {
            return String(a);
          }
        })
        .join(" ");
      const line = `[${ts}] ${level.toUpperCase()}: ${text}`;
      setDebugLogs((prev) => {
        const next = [...prev, line];
        return next.length > 250 ? next.slice(next.length - 250) : next;
      });
    } catch {
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
    } catch {
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
    } catch {
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
      g.gain.value = 0.02;
      osc.frequency.value = 40;
      osc.connect(g);
      g.connect(ctx.destination);
      const stopAt = ctx.currentTime + 0.12;
      osc.start();
      osc.stop(stopAt);

      window.setTimeout(() => {
        try { osc.disconnect(); } catch {}
        try { g.disconnect(); } catch {}
      }, 180);
    } catch {
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
        try { media.muted = false; media.volume = 1; } catch {}
        return;
      }

      try {
        // From here on, we only handle the non-iPhone Live Avatar <video> element.
        // (Audio-only TTS elements return early above to avoid WebAudio routing issues.)

        // If the underlying media element instance changed (common when Live Avatar is stopped/started),
        // we must recreate the MediaElementSourceNode. Source nodes are permanently bound to a single element.
        if (avatarVideoBoundElRef.current !== media) {
          try { avatarVideoMediaSrcRef.current?.disconnect(); } catch {}
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
          } catch {}
          try {
            gain!.connect(ctx.destination);
          } catch {}
          connectedRef.current = true;
        };
        // kind is narrowed to "avatar" here (audio/video returned early above).
        connectOnce(avatarVideoChainConnectedRef);

        gain.gain.value = TTS_GAIN;

        // Keep element volume at max so the gain node is the only limiter.
        try {
          media.muted = false;
          media.volume = 1;
        } catch {}
      } catch (e) {
        // If this fails (e.g., cross-origin media restrictions), we still keep media.volume at 1.
        try {
          media.muted = false;
          media.volume = 1;
        } catch {}
      }
    },
    [ensureTtsAudioContext, isIphone]
  );

  const boostAllTtsVolumes = useCallback(() => {
    try {
      // Local (audio-only) TTS elements intentionally NOT routed through WebAudio.
      // Live avatar video element (non-iPhone)
      applyTtsGainRouting(avatarVideoRef.current, "avatar");
    } catch {
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
      // For user messages we keep plain text.
      if (m.role !== "assistant") return m.content;

      // For assistant messages, we render PayGo/Upgrade URLs as friendly links.
      const stripScheme = (u: string) => (u || "").replace(/^https?:/i, "");

      const paygKey = rebrandingInfo?.payGoLink ? stripScheme(rebrandingInfo.payGoLink).toLowerCase() : "";
      const upgradeKey = rebrandingInfo?.upgradeLink ? stripScheme(rebrandingInfo.upgradeLink).toLowerCase() : "";

      const urlGlobal = /(https?:\/\/[^\s]+|\/\/[^\s]+)/g;
      const parts = (m.content || "").split(urlGlobal);

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
        if (paygKey && comparable === paygKey) label = "Pay as you Go";
        else if (upgradeKey && comparable === upgradeKey) label = "Upgrade";

        const href = urlRaw.startsWith("//") ? `https:${urlRaw}` : urlRaw;

        return (
          <React.Fragment key={idx}>
            <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
              {label}
            </a>
            {punct}
          </React.Fragment>
        );
      });
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

  // DB-driven companion mapping (brand+avatar), loaded from the API (sqlite preloaded at startup).
  const [companionMapping, setCompanionMapping] = useState<CompanionMappingRow | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const brand = String(companyName || "").trim();
      const avatar = String(companionName || "").trim();
      if (!brand || !avatar) {
        setCompanionMapping(null);
        return;
      }

      if (!API_BASE) {
        setCompanionMapping(null);
        return;
      }

      try {
        const url = `${API_BASE}/mappings/companion?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(
          avatar
        )}`;
        const res = await fetch(url, { method: "GET" });
        const json = (await res.json()) as CompanionMappingRow;
        if (cancelled) return;

        if (res.ok && (json as any)?.found) setCompanionMapping(json);
        else setCompanionMapping(null);
      } catch {
        if (!cancelled) setCompanionMapping(null);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [companyName, companionName]);

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
    } catch {
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

  // BeeStreamed (Human companion) embed state
  const [streamEmbedUrl, setStreamEmbedUrl] = useState<string>("");
  const [streamEventRef, setStreamEventRef] = useState<string>("");
  const [streamCanStart, setStreamCanStart] = useState<boolean>(false);
  const [streamNotice, setStreamNotice] = useState<string>("");

        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        const eventRef = String(data?.eventRef || "").trim();
        let embedUrl = String(data?.embedUrl || "").trim();
        if (embedUrl && embedUrl.startsWith("/")) embedUrl = `${API_BASE}${embedUrl}`;

        // Once the host creates the event_ref, the backend will begin returning embedUrl to viewers.
        if (embedUrl) {
          setStreamEventRef(eventRef);
          setStreamEmbedUrl(embedUrl);

          // Viewers can never "start", so we keep waiting state (and message) until the stream is live.
          // This is purely to allow the iframe to appear without requiring a hard refresh.
          setStreamCanStart(false);

          if (data?.message) {
            setStreamNotice(String(data.message));
          }
        } else if (data?.message) {
          setStreamNotice(String(data.message));
        }
      } catch {
        // Ignore transient failures; keep polling.
      }
    };

    // Kick once immediately, then interval.
    poll();
    const t = window.setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [avatarStatus, streamEmbedUrl, API_BASE, companyName, companionName, memberId]);




const phase1AvatarMedia = useMemo(() => getPhase1AvatarMedia(companionName), [companionName]);

const channelCap: ChannelCap = useMemo(() => {
  const commFromDb = String(companionMapping?.communication || "").trim().toLowerCase();
  if (commFromDb === "video") return "video";
  if (commFromDb === "audio") return "audio";
  return "";
}, [companionMapping]);

const liveProvider: LiveProvider = useMemo(() => {
  // Prefer database mapping when present.
  const liveFromDb = String(companionMapping?.live || "").trim().toLowerCase();
	  // Be tolerant of values like "Stream", "Streamed", "BeeStreamed", or custom labels that include
	  // these keywords (e.g., "Stream (BeeStreamed)").
	  if (liveFromDb.includes("stream")) return "stream";
	  if (liveFromDb.includes("d-id") || liveFromDb.includes("did") || liveFromDb.includes("d_id")) return "did";

  // Backward compatibility: allow companionKey flags (older Wix payloads / test URLs)
  const raw = String(companionKeyRaw || companionKey || "").trim();
  const { flags } = splitCompanionKey(raw);
  const v = String(flags["live"] || "").trim().toLowerCase();
  if (v === "stream" || v === "web" || v === "conference" || v === "video") return "stream";

  return "did";
}, [companionMapping, companionKeyRaw, companionKey]);

const streamUrl = useMemo(() => {
  const raw = String(companionKeyRaw || "").trim();
  const { flags } = splitCompanionKey(raw);
  return String(flags["streamurl"] || "").trim() || STREAM_URL;
}, [companionKeyRaw]);

const liveEnabled = useMemo(() => {
  // NOTE: The product requirement for showing the "video" control is driven by the
  // SQLite "Live" column (values like "D-ID" or "Stream").
  //
  // Some rows also have a "communication" column (audio/video). In prior iterations we
  // treated communication=audio as "no video" and hid the control — but that breaks the
  // intended behavior for human companions (Live=Stream) and D-ID avatars (Live=D-ID)
  // that may still be marked communication=audio.
  //
  // Therefore: if the mapping explicitly declares Live=Stream or Live=D-ID, we always
  // enable the control regardless of communication.
  const liveRaw = String(companionMapping?.live || "").trim().toLowerCase();
  const mappingSaysVideo =
    liveRaw.includes("stream") || liveRaw.includes("d-id") || liveRaw.includes("did");
  if (mappingSaysVideo) return true;

  // If we *only* have a channel cap (and no Live mapping), honor it.
  if (channelCap === "video") return true;
  if (channelCap === "audio") return false;

  // Final fallback: keep prior behavior when mapping is missing.
  return liveProvider === "stream" || Boolean(phase1AvatarMedia);
}, [companionMapping, channelCap, liveProvider, phase1AvatarMedia]);



  // UI layout
  const conversationHeight = 520;
  const showAvatarFrame = (liveProvider === "stream" && !!streamEmbedUrl) || (Boolean(phase1AvatarMedia) && avatarStatus !== "idle");

const cleanupIphoneLiveAvatarAudio = useCallback(() => {
  if (!didIphoneBoostActiveRef.current && !didIphoneAudioCtxRef.current) return;

  didIphoneBoostActiveRef.current = false;

  try {
    didIphoneAudioSrcRef.current?.disconnect();
  } catch {}
  try {
    didIphoneAudioGainRef.current?.disconnect();
  } catch {}

  didIphoneAudioSrcRef.current = null;
  didIphoneAudioGainRef.current = null;

  try {
    // Closing releases resources; we recreate on demand.
    didIphoneAudioCtxRef.current?.close?.();
  } catch {}
  didIphoneAudioCtxRef.current = null;

  // Restore video element audio defaults (in case we muted it for iPhone boost)
  const vid = avatarVideoRef.current;
  if (vid) {
    try {
      vid.muted = false;
      vid.volume = 1;
    } catch {}
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
  } catch {
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
      } catch {}
      try {
        didIphoneAudioGainRef.current?.disconnect();
      } catch {}

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
        } catch {}
      }
    } catch (e) {
      console.warn("iPhone Live Avatar audio boost failed:", e);
    }
  },
  [isIphone]
);




const stopLiveAvatar = useCallback(async () => {
  // Stop STT/TTS (same steps used by the Stop button).
  try { stopHandsFreeSTT(); } catch {}
  try { stopSpeechToText(); } catch {}
  // Always clean up iPhone audio boost routing first
  cleanupIphoneLiveAvatarAudio();

  // BeeStreamed (Human companion) — stop the stream and clear the embed.
  if (streamEmbedUrl || streamEventRef) {
    try {
      // Only the host can stop the underlying live stream.
      // Non-host viewers can still close the embed locally without affecting the session.
      if (streamCanStart) {
        const embedDomain = typeof window !== "undefined" ? window.location.hostname : "";
        await fetch(`${API_BASE}/stream/beestreamed/stop_embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            embedDomain,
            memberId: memberId || "",
            eventRef: streamEventRef || undefined,
          }),
        });
      }
    } catch (e) {
      console.warn("BeeStreamed stop_embed failed:", e);
    } finally {
      setStreamEmbedUrl("");
      setStreamEventRef("");
      setStreamCanStart(false);
      setStreamNotice("");
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
    } catch {
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
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  } finally {
    setAvatarStatus("idle");
    setAvatarError(null);
  }
}, [cleanupIphoneLiveAvatarAudio, streamEmbedUrl, streamEventRef, companyName, companionName]);

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
  // BeeStreamed (Human companion) — start/ensure the event on the API, then embed inside the page.
  setAvatarError(null);
  setAvatarStatus("connecting");

  try {
    const embedDomain = typeof window !== "undefined" ? window.location.hostname : "";

    // Ask the app server to:
    //  - resolve/create an event_ref for this (brand, avatar)
    //  - start the WebRTC stream for that event
    //  - return an embed URL
    const res = await fetch(`${API_BASE}/stream/beestreamed/start_embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand: companyName,
        avatar: companionName,
        embedDomain,
        memberId: memberId || "",
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
    }

    const eventRef = String(data?.eventRef || "").trim();

// IMPORTANT: Always use our internal wrapper so the experience stays within the iframe.
// The API may return a relative path like "/stream/beestreamed/embed/{eventRef}".
let embedUrl = String(data?.embedUrl || "").trim();
if (embedUrl && embedUrl.startsWith("/")) embedUrl = `${API_BASE}${embedUrl}`;

// If the host hasn't created the event yet, non-host users may legitimately have no embedUrl/eventRef.
const canStart = !!data?.canStart;
if (!embedUrl && eventRef) {
  // Fallback to wrapper path (never direct beestreamed.com) if API returned eventRef only.
  embedUrl = `${API_BASE}/stream/beestreamed/embed/${encodeURIComponent(eventRef)}`;
}
if (!embedUrl && canStart) {
  throw new Error("BeeStreamed did not return an embedUrl/eventRef.");
}
setStreamEventRef(eventRef);
    setStreamEmbedUrl(embedUrl);

    setStreamCanStart(canStart);

    if (!canStart) {
      setStreamNotice(
        `Waiting on ${companionName || "the host"} to start event`
      );
      setAvatarStatus("waiting");
    } else if (String(data?.status || "").trim() === "start_failed") {
      setStreamNotice("");
      setAvatarStatus("error");
      setAvatarError("Streaming failed to start. Please try again.");
    } else {
      setStreamNotice("");
      setAvatarStatus("connected");
    }
  } catch (err: any) {
    console.error("BeeStreamed start_embed failed:", err);
    setAvatarStatus("error");
    setAvatarError(
      `Streaming failed to start. ${err?.message ? String(err.message) : String(err)}`,
    );

    // Fallback: if a direct streamUrl exists, open it externally.
    if (streamUrl) {
      try {
        window.open(streamUrl, "_blank", "noopener,noreferrer");
      } catch (_e) {
        window.location.href = streamUrl;
      }
    }
  }
  return;
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
    } catch {}
    didAgentMgrRef.current = null;

    try {
      const existingStream = didSrcObjectRef.current;
      if (existingStream && typeof existingStream.getTracks === "function") {
        existingStream.getTracks().forEach((t: any) => t?.stop?.());
      }
    } catch {}
    didSrcObjectRef.current = null;
    if (avatarVideoRef.current) {
      try {
        const vid = avatarVideoRef.current;
        vid.srcObject = null;
        vid.pause();
        vid.removeAttribute("src");
        (vid as any).src = "";
        vid.load?.();
      } catch {
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
            } catch {
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
            } catch {}
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
              } catch {
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
            } catch {
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
  } catch (e: any) {
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
        } catch {}

        const p = m.play();
        Promise.resolve(p)
          .then(() => {
            markUnlocked();
            try {
              m.pause();
            } catch {}
            try {
              (m as any).currentTime = 0;
            } catch {}
          })
          .catch((e) => {
            console.warn("Failed to prime local TTS", {
            mediaTag: m.tagName,
              err: String(e),
              name: (e as any)?.name,
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
    } catch {}

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
              } catch {}
              finish();
            };

            try {
              rec.stop();
            } catch {
              finish();
            }

            // Safety if onend never arrives
            setTimeout(finish, 220);
          });
        } catch {
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
        } catch {}

        try {
        } catch {}

        if (useVideo) {
          try {
            const v = m as HTMLVideoElement;
            v.playsInline = true;
            v.setAttribute("playsinline", "true");
            v.setAttribute("webkit-playsinline", "true");
          } catch {}
        }

        try {
          m.muted = false;
          m.volume = 1;
        } catch {}

        // Local (audio-only) TTS stays on the hidden VIDEO element, but we do not
        // route it through WebAudio (can cause silence with non-CORS media).
        try { m.muted = false; m.volume = 1; } catch {}

        try {
          (m as any).preload = "auto";
        } catch {}

        try {
          m.src = finalUrl;
          try {
            (m as any).load?.();
          } catch {}
        } catch {}

        try {
          hooks?.onWillSpeak?.();
        } catch {}

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
              } catch {}
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
            } catch {
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
            } catch {}
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
            } catch {}

            // iOS Safari sometimes gets "stuck" if we leave the src attached.
            if (isIOS) {
              try {
                m.removeAttribute("src");
                (m as any).load?.();
              } catch {}
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
        } catch {}
        return;
      }

      // Only allow <audio> fallback if hidden-video TTS has been explicitly disabled.
      if (!forceHiddenVideo && audioEl) {
        const ok = await playOn(audioEl, false);
        if (ok) return;
      }

      try {
        hooks?.onDidNotSpeak?.();
      } catch {}
    },
    [isIOS, applyTtsGainRouting],
  );

  // Stop any in-progress local (audio-only) TTS playback immediately.
  // This is required so the Stop button can reliably interrupt audio-only conversations.
  const stopLocalTtsPlayback = useCallback(() => {
    try {
      localTtsStopFnRef.current?.();
    } catch {
      // ignore
    }
    localTtsStopFnRef.current = null;

    const a = localTtsAudioRef.current;
    if (a) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {}
      try {
        a.removeAttribute("src");
        (a as any).load?.();
      } catch {}
    }

    const v = localTtsVideoRef.current;
    if (v) {
      try {
        v.pause();
        v.currentTime = 0;
      } catch {}
      try {
        v.removeAttribute("src");
        (v as any).load?.();
      } catch {}
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
      } catch {}
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
      } catch {
        // ignore
      }
    };

    let willSpeakCalled = false;
    const callWillSpeakOnce = () => {
      if (willSpeakCalled) return;
      willSpeakCalled = true;
      try {
        hooks?.onWillSpeak?.();
      } catch {
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
        } catch {
          // ignore
        }

        let doneCalled = false;
        const done = (ms: number) => {
          if (doneCalled) return;
          doneCalled = true;
          try {
            a.onloadedmetadata = null as any;
            a.onerror = null as any;
          } catch {
            // ignore
          }
          // release resource
          try {
            a.src = "";
          } catch {
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
  const [memberId, setMemberId] = useState<string>("");


  // Lightweight viewer auto-refresh: if you're not the host, keep polling until the host creates/starts the event.
  // This avoids requiring manual page refresh for viewers waiting on the host.
  useEffect(() => {
    // Only poll while we are explicitly waiting and we don't yet have an embed URL.
    if (avatarStatus !== "waiting") return;
    if (streamEmbedUrl) return;

    let cancelled = false;
    const intervalMs = 3000;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/stream/beestreamed/start_embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: companyName,
            avatar: companionName,
            memberId: memberId || "",
            embedDomain: window?.location?.hostname || "",
          }),
        });
  const [loggedIn, setLoggedIn] = useState<boolean>(false);
  // True once we have received the Wix postMessage handoff (plan + companion).
  // Used to ensure the *first* audio-only TTS uses the selected companion voice (not the fallback).
  const [handoffReady, setHandoffReady] = useState<boolean>(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [setModeFlash, setSetModeFlash] = useState(false);
  const [switchCompanionFlash, setSwitchCompanionFlash] = useState(false);
  const [allowedModes, setAllowedModes] = useState<Mode[]>(["friend"]);

  const goToMyElaralo = useCallback(() => {
    const url = "https://www.elaralo.com/myelaralo";

    // If running inside an iframe, attempt to navigate the *top* browsing context
    // so we leave the embed and avoid “stacked headers”.
    try {
      if (window.top && window.top !== window.self) {
        window.top.location.href = url;
        return;
      }
    } catch {
      // Cross-origin access to window.top can throw.
    }

    // Alternate attempt that may still target the top browsing context.
    try {
      window.open(url, "_top");
      return;
    } catch {
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
    } catch {
      // Cross-origin access to window.top can throw.
    }

    // Alternate attempt that may still target the top browsing context.
    try {
      window.open(url, "_top");
      return;
    } catch {
      // ignore
    }

    // Fallback: navigate the current frame.
    window.location.href = url;
  }, [upgradeUrl]);


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
    } catch {
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
    function onMessage(event: MessageEvent) {
  if (!isAllowedOrigin(event.origin)) return;

  // Wix HTML components sometimes deliver the payload as a JSON string.
  // Accept both object and string forms.
  let data: any = (event as any).data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }

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
	const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || "core").trim();
const brandKey = safeBrandKey(rawBrand);

// For visitors (no Wix memberId), generate a stable anon id so we can track freeMinutes usage.
const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

// If the user is entitled (has a real Wix memberId + active plan), strip the trial controls
// from the rebranding key so backend quota comes from the mapped Elaralo plan.

// `loggedIn` is only available when the Wix parent posts it.
const hasEntitledPlan = !!((memberId || "").trim() && loggedIn === true && !!planName && planName !== "Trial");
const rebrandingKeyForBackend = hasEntitledPlan
  ? stripTrialControlsFromRebrandingKey(rebrandingKey || "")
  : (rebrandingKey || "");

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
        messages: trimMessagesForChat(nextMessages).map((m) => ({ role: m.role, content: m.content })),
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
	const rawBrand = (parseRebrandingKey(rebrandingKey || "")?.rebranding || "core").trim();
const brandKey = safeBrandKey(rawBrand);

// For visitors (no Wix memberId), generate a stable anon id so we can track freeMinutes usage.
const memberIdForBackend = (memberId || "").trim() || getOrCreateAnonMemberId(brandKey);

// If the user is entitled (has a real Wix memberId + active plan), strip the trial controls
// from the rebranding key so backend quota comes from the mapped Elaralo plan.
const hasEntitledPlan = !!((memberId || "").trim() && !!loggedIn && !!planName && planName !== "Trial");
const rebrandingKeyForBackend = hasEntitledPlan
  ? stripTrialControlsFromRebrandingKey(rebrandingKey || "")
  : (rebrandingKey || "");

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
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as any;
  }

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

  async function send(textOverride?: string, stateOverride?: Partial<SessionState>) {
    if (loading) return;

    const rawText = (textOverride ?? input).trim();
    if (!rawText) return;

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
    const outgoingText = detectedMode ? cleaned : rawText;

    const userMsg: Msg = { role: "user", content: outgoingText };
    const nextMessages: Msg[] = [...messages, userMsg];

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
    setLoading(true);

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      const data = await callChat(nextMessages, sendState);

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

      const voiceId = getElevenVoiceIdForAvatar(safeCompanionKey);

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
    } catch {
      // ignore
    }

    try {
      rec.abort?.();
    } catch {
      // ignore
    }
    try {
      rec.stop?.();
    } catch {
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
    avatarStatus === "connecting" || avatarStatus === "connected" || avatarStatus === "reconnecting";

  // Prefer backend STT for iOS **audio-only** mode (more stable than browser SpeechRecognition).
  // Keep Live Avatar mode on browser STT (it is already stable across devices).
  const useBackendStt = isIOS && backendSttAvailable && !liveAvatarActive && !isEmbedded;

  const cleanupBackendSttResources = useCallback(() => {
    try {
      if (backendSttRecorderRef.current && backendSttRecorderRef.current.state !== "inactive") {
        backendSttRecorderRef.current.stop();
      }
    } catch {}
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
        } catch {}
      });
      backendSttStreamRef.current = null;
    }

    if (backendSttAudioCtxRef.current) {
      try {
        backendSttAudioCtxRef.current.close();
      } catch {}
      backendSttAudioCtxRef.current = null;
    }

    backendSttHasSpokenRef.current = false;
    backendSttLastVoiceAtRef.current = 0;
  }, []);

  const abortBackendStt = useCallback(() => {
    try {
      backendSttAbortRef.current?.abort();
    } catch {}
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
        } catch {}
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
          } catch (e: any) {
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
      } catch {}

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch {
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
        } catch {}

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
            backendSttLastVoiceAtRef.current = now;
            backendSttHasSpokenRef.current = true;
          }

          const elapsed = now - startedAt;
          const silentFor = now - backendSttLastVoiceAtRef.current;

          if (elapsed >= maxRecordMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {}
            return;
          }

          if (backendSttHasSpokenRef.current && elapsed > minRecordMs && silentFor >= silenceMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {}
            return;
          }

          backendSttRafRef.current = requestAnimationFrame(tick);
        };

        backendSttRafRef.current = requestAnimationFrame(tick);
      } catch {
        // If VAD setup fails, we still record; hard-stop timer will end it.
      }

      backendSttHardStopTimerRef.current = window.setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
      }, 16000);

      try {
        recorder.start(250);
      } catch {
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
    } catch (e: any) {
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
    } catch {
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

      // Pause BEFORE we send so the assistant doesn't "talk to itself".
      pauseSpeechToText();

      sttFinalRef.current = "";
      sttInterimRef.current = "";
      setInput("");

      void sendRef.current(text);
    }, 2000);
  }, [getCurrentSttText, pauseSpeechToText]);

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
    } catch (e: any) {
      console.warn("Mic permission denied/unavailable:", e);
      setSttError(getEmbedHint());

      const name = e?.name || "";
      // If backend STT can't access the mic (common in some embedded contexts),
      // fall back to browser SpeechRecognition for this session.
      if (name === "NotAllowedError" || name === "SecurityError") {
        setBackendSttAvailable(false);
        try {
          sttRecRef.current?.abort?.();
        } catch {
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
    } catch {
      // ignore
    }

    try {
      rec.interimResults = true;
    } catch {
      // ignore
    }

    try {
      rec.lang = "en-US";
    } catch {
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
        } catch {
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
        } catch {
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
          } catch {
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
          } catch {
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
      } catch {
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
    } catch {}

    // Prevent duplicates/races (e.g., Live Avatar connects right after mic-start).
    if (greetInFlightRef.current) return;
    greetInFlightRef.current = true;

    // IMPORTANT: do NOT prefix with "Name:"; the UI already labels the assistant bubble.
    // Keeping the spoken text free of the prefix prevents the avatar from reading its own name like a script cue.
    const greetText = `Hi, I'm ${name}. I'm here with you. How are you feeling today?`;
    // Local audio-only greeting must always use the companion's ElevenLabs voice.
    // (Live avatar uses its own configured voice via the DID agent.)
    const safeCompanionKey = resolveCompanionForBackend({ companionKey, companionName });

      const voiceId = getElevenVoiceIdForAvatar(safeCompanionKey);

    // Belt & suspenders: avoid STT re-capturing the greeting audio.
    const prevIgnore = sttIgnoreUntilRef.current;
    sttIgnoreUntilRef.current = performance.now() + 60_000; // 60s

    try {
      try {
        await pauseSpeechToText();
      } catch {}

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
      } catch {}
    } catch (e) {
      // Allow retry later if something failed.
      try {
        sessionStorage.removeItem(key);
      } catch {}
      console.warn("Greeting playback failed:", e);
    } finally {
      sttIgnoreUntilRef.current = prevIgnore;
      greetInFlightRef.current = false;
      try {
        await resumeSpeechToText();
      } catch {}
    }
  },
  [companionName, handoffReady, pauseSpeechToText, resumeSpeechToText, speakAssistantReply, speakLocalTtsReply],
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
    try { boostAllTtsVolumes(); } catch {}
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
    // Disable STT/TTS for the host during BeeStreamed live sessions.
    if ((liveProvider === "stream" && streamCanStart && (avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting"))) return;
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
    } catch {}
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
    } catch {}

    // Re-assert boosted audio routing and nudge audio session on the same user gesture.
    try { boostAllTtsVolumes(); } catch {}
    try { void nudgeAudioSession(); } catch {}
    try { primeLocalTtsAudio(true); } catch {}
    try { void ensureIphoneAudioContextUnlocked(); } catch {}
  }, [stopHandsFreeSTT, boostAllTtsVolumes, nudgeAudioSession, primeLocalTtsAudio, ensureIphoneAudioContextUnlocked]);

  // Clear Messages (with confirmation)
  const requestClearMessages = useCallback(() => {
    // Stop all audio/video + STT immediately on click (even before the user confirms).
    // This is an overt user action and prevents the assistant from continuing to speak.
    clearEpochRef.current += 1;
    setLoading(false);

    try {
      stopHandsFreeSTT();
    } catch {
      // ignore
    }

    // User gesture: re-assert boosted audio routing and nudge audio session back to playback mode.
    try {
      boostAllTtsVolumes();
    } catch {}
    try {
      void nudgeAudioSession();
    } catch {}

    // Strong iOS recovery: prime the hidden VIDEO element on this user gesture so audio-only TTS
    // is not left in a silent/receiver route after the confirmation modal.
    try {
      primeLocalTtsAudio(true);
    } catch {}
    try {
      void ensureIphoneAudioContextUnlocked();
    } catch {}


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
    } catch {}

    // User gesture: re-assert boosted audio routing and nudge audio session back to playback mode.
    try {
      boostAllTtsVolumes();
    } catch {}
    try {
      void nudgeAudioSession();
    } catch {}

    // Prime the hidden VIDEO element on this user gesture so audio-only TTS remains healthy.
    try {
      primeLocalTtsAudio(true);
    } catch {}
    try {
      void ensureIphoneAudioContextUnlocked();
    } catch {}

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
    try { boostAllTtsVolumes(); } catch {}

    // iOS route recovery: nudge the audio session back to normal playback.
    try { await nudgeAudioSession(); } catch {}

    // Prime the hidden VIDEO element (required by your constraint) so the next audio-only
    // TTS playback is unlocked and uses the correct output route.
    try { primeLocalTtsAudio(true); } catch {}

    // If Live Avatar is used on iPhone, ensure its audio context is also unlocked.
    try { void ensureIphoneAudioContextUnlocked(); } catch {}

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
    } catch {}

    try {
      const a = localTtsAudioRef.current;
      if (a) {
        a.muted = false;
        a.volume = 1;
      }
    } catch {}

    try {
      const av = avatarVideoRef.current;
      if (av) {
        av.muted = false;
        av.volume = 1;
      }
    } catch {}
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
          } catch {}
          try {
            rec.abort?.();
          } catch {
            try {
              rec.stop?.();
            } catch {}
          }
        }
      } catch {}
    };
  }, []);

  // UI controls (layout-only): reused in multiple locations without changing logic.
  const sttControls = (
    <>
      <button
        type="button"
        onClick={toggleSpeechToText}
        disabled={((!sttEnabled && loading) || (liveAvatarActive && sttEnabled)) || (liveProvider === "stream" && streamCanStart && (avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting"))}
        title="Audio"
        style={{

          width: 44,
          minWidth: 44,
          borderRadius: 10,
          border: "1px solid #111",
          background: (liveProvider === "stream" && streamCanStart && (avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting")) ? "#f3f3f3" : (sttEnabled ? "#b00020" : "#fff"),
          color: sttEnabled ? "#fff" : "#111",
          cursor: (liveProvider === "stream" && streamCanStart && (avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting")) ? "not-allowed" : "pointer",
          opacity: (liveProvider === "stream" && streamCanStart && (avatarStatus === "connected" || avatarStatus === "connecting" || avatarStatus === "reconnecting" || avatarStatus === "waiting")) ? 0.6 : 1,
          fontWeight: 700,
        
        }}
      >
        🎤
      </button>

      <button
        type="button"
        onClick={handleStopClick}
        disabled={!sttEnabled}
        title="Stop"
        style={{
          width: 44,
          minWidth: 44,
          borderRadius: 10,
          border: "1px solid #111",
          background: "#fff",
          color: "#111",
          cursor: sttEnabled ? "pointer" : "not-allowed",
          opacity: sttEnabled ? 1 : 0.45,
          fontWeight: 700,
        }}
      >
        ■
      </button>
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

  const modePillControls = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {!showModePicker ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
          {(!rebrandingKey || rebrandingKey.trim() === "") && (



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
        </>
      )}
    </div>
  );

  return (
    <main style={{ maxWidth: 880, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      {/* Hidden audio element for audio-only TTS (mic mode) */}
      <audio ref={localTtsAudioRef} style={{ display: "none" }} />
      {/* Hidden video element used on iOS to play audio-only TTS reliably (matches Live Avatar routing) */}
      <video
        ref={localTtsVideoRef}
        playsInline
        preload="auto"
        style={{ position: "fixed", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
      />
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
        </div>
      </header>

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
          if (
            avatarStatus === "connected" ||
            avatarStatus === "connecting" ||
            avatarStatus === "reconnecting"
          ) {
            void stopLiveAvatar();
          } else {
            void (async () => {
              // Live Avatar requires microphone / STT. Start it automatically.
              // BeeStreamed host: disable any STT/TTS while streaming.
              if (liveProvider === "stream" && streamCanStart) {
                try { stopHandsFreeSTT(); } catch {}
                try { stopSpeechToText(); } catch {}
              }

              // If iOS audio-only backend STT is currently running, restart in browser STT for Live Avatar.
              if (sttEnabledRef.current && useBackendStt) {
                stopSpeechToText();
              }

              if (liveProvider !== "stream" && !sttEnabledRef.current) {
                await startSpeechToText({ forceBrowser: true, suppressGreeting: true });
              }

              // If mic permission was denied, don't start Live Avatar.
              if (liveProvider !== "stream" && !sttEnabledRef.current) return;

              await startLiveAvatar();
            })();
          }
        }}
        style={{
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid #111",
          background: "#fff",
          color: "#111",
          cursor: "pointer",
          fontWeight: 700,
        }}
        aria-label={
          avatarStatus === "connected" ||
          avatarStatus === "connecting" ||
          avatarStatus === "reconnecting"
            ? "Stop Live Avatar"
            : "Start Live Avatar"
        }
        title="Video"
      >
        {avatarStatus === "connected" ||
        avatarStatus === "connecting" ||
        avatarStatus === "reconnecting"
          ? <PauseIcon />
          : <PlayIcon />}
      </button>

      {/* When a Live Avatar is available, place mic/stop controls to the right of play/pause */}
      {sttControls}

      <div style={{ fontSize: 12, color: "#666" }}>
        Live Avatar: <b>{avatarStatus}</b>
        {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
      </div>
    </div>

    {/* Right-justified Mode controls */}
    {modePillControls}
  </section>
) : (
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
      {/* When no Live Avatar is available, show mic/stop controls in the Live Avatar button location */}
      {sttControls}

      <div style={{ fontSize: 12, color: "#666" }}>
        Live Avatar: <b>{avatarStatus}</b>
        {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
      </div>
    </div>

    {/* Right-justified Mode controls */}
    {modePillControls}
  </section>
)}



      {/* Conversation area (Avatar + Chat) */}
      <section
        style={{
          display: "flex",
          gap: 12,
          alignItems: "stretch",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        {showAvatarFrame ? (
          <div style={{ flex: "1 1 0", minWidth: 260, height: conversationHeight }}>
            <div
              style={{
                border: "1px solid #e5e5e5",
                borderRadius: 12,
                overflow: "hidden",
                background: "#000",
                height: "100%",
                position: "relative",
              }}
            >
                            {liveProvider === "stream" && streamEmbedUrl ? (
                <iframe
                  src={streamEmbedUrl}
                  title="Live Stream"
                  style={{ width: "100%", height: "100%", border: 0 }}
                  // Keep all navigation inside the frame (block popout/new-window behavior)
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                  referrerPolicy="no-referrer-when-downgrade"
                  allow="autoplay; fullscreen; picture-in-picture; microphone; camera"
                  allowFullScreen
                />
              ) : (
                <video
                  ref={avatarVideoRef}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  playsInline
                  autoPlay
                  muted={false}
                />
              )}
              {avatarStatus !== "connected" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 14,
                    background: "rgba(0,0,0,0.25)",
                    padding: 12,
                    textAlign: "center",
                  }}
                >
                  {avatarStatus === "connecting"
                    ? "Connecting…"
                    : avatarStatus === "reconnecting"
                    ? "Reconnecting…"
                    : avatarStatus === "waiting"
                    ? streamNotice || "Waiting for the host to start…"
                    : avatarStatus === "error"
                    ? "Avatar error"
                    : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          style={{
            flex: showAvatarFrame ? "2 1 0" : "1 1 0",
            minWidth: 280,
            height: conversationHeight,
            display: "flex",
            flexDirection: "column",
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
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 10,
                  whiteSpace: "pre-wrap",
                  color: m.role === "assistant" ? "#111" : "#333",
                }}
              >
                <b>{m.role === "assistant" ? companionName : "You"}:</b> {renderMsgContent(m)}
              </div>
            ))}
            {loading ? <div style={{ color: "#666" }}>Thinking…</div> : null}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
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
                background: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "#f3f3f3" : "#fff",
                cursor: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "not-allowed" : "pointer",
                opacity: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? 0.6 : 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              disabled={liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")}
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
                background: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "#f3f3f3" : "#fff",
                cursor: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? "not-allowed" : "pointer",
                opacity: (liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")) ? 0.6 : 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              disabled={liveProvider === "stream" && !streamCanStart && (avatarStatus === "connected" || avatarStatus === "waiting")}
              >
              <TrashIcon size={18} />
            </button>

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
              placeholder={sttEnabled ? "Listening…" : "Type a message…"}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #ddd",
              }}
            />

            <button
              onClick={() => send()}
              disabled={loading}
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
                  try { boostAllTtsVolumes(); } catch {}
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
                  } catch (e: any) {
                    setMessages((prev) => [
                      ...prev,
                      { role: "assistant", content: `Save failed for ${companionForDisplay}: ${String(e?.message || e)}` },
                    ]);
                  } finally {
                    setSavingSummary(false);
                    setShowSaveSummaryConfirm(false);
                    // Maintain the same post-modal audio/TTS hardening used by Clear Messages.
                    try { boostAllTtsVolumes(); } catch {}
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
                    try { boostAllTtsVolumes(); } catch {}
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
                  setMessages([]);
                  setInput("");
                  try { if (inputElRef.current) inputElRef.current.value = ""; } catch {}
                  setShowClearMessagesConfirm(false);
                  // User gesture: restore boosted routing so subsequent TTS isn't quiet.
                  try { boostAllTtsVolumes(); } catch {}
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
              onClick={() => {
                try {
                  const text = debugLogs.join("\n");
                  if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text);
                  } else {
                    // Fallback for older browsers
                    // eslint-disable-next-line no-alert
                    alert(text);
                  }
                } catch {}
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