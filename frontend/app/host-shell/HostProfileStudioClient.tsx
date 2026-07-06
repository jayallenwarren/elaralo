
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type HostOnboardingAsset = {
  asset_id?: string;
  session_id?: string;
  slot_key: string;
  slot_label?: string;
  required?: boolean;
  url?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
  width_px?: number;
  height_px?: number;
  duration_seconds?: number;
  validation_status?: string;
  validation_errors?: string[];
};

type HostOnboardingSession = {
  session_id: string;
  member_id: string;
  brand?: string;
  avatar?: string;
  host_display_name?: string;
  logged_in?: boolean;
  workflow_state?: string;
  publish_status?: string;
  limited_publish_allowed?: boolean;
  full_publish_ready?: boolean;
  approved_version_id?: string;
  three_d_opt_in?: boolean;
  basics?: Record<string, any>;
  derived?: Record<string, any>;
  review?: Record<string, any>;
  completion?: Record<string, any>;
  assets?: HostOnboardingAsset[];
};

type HostOnboardingReadiness = {
  basics_ok?: boolean;
  photos_ok?: boolean;
  missing_required_slots?: string[];
  review_ok?: boolean;
  voice_capture_ok?: boolean;
  voice_capture_required?: boolean;
  voice_capture_min_seconds?: number;
  voice_capture_asset_id?: string;
  voice_capture_blockers?: string[];
  limited_publish_allowed?: boolean;
  limited_publish_missing_sections?: string[];
  limited_publish_blockers?: string[];
  full_publish_ready?: boolean;
  full_publish_missing_sections?: string[];
  full_publish_skipped_sections?: string[];
};

type HostOnboardingStep = "welcome" | "basics" | "photos" | "review" | "completion" | "preview";

type HostOnboardingContext = {
  memberId: string;
  loggedIn: boolean;
  brand: string;
  avatar: string;
  hostDisplayName: string;
  email?: string;
  source?: string;
};

type EducationEntry = {
  id: string;
  degree: string;
  field_of_study: string;
  institution: string;
  graduation_year: string;
  notes: string;
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
const DEFAULT_COMPANY_NAME = "Elaralo";
const DEFAULT_COMPANION_NAME = "Elara";

const REQUIRED_SLOTS = [
  { key: "headshot_front", label: "Headshot (front)", required: true },
  { key: "full_body_front", label: "Full body (front)", required: true },
  { key: "three_quarter_body", label: "Three-quarter body", required: true },
  { key: "angle_left_45", label: "45-degree left", required: true },
  { key: "angle_right_45", label: "45-degree right", required: true },
] as const;

const OPTIONAL_SLOTS = [
  { key: "left_profile", label: "Left profile", required: false },
  { key: "right_profile", label: "Right profile", required: false },
  { key: "smiling_headshot", label: "Smiling headshot", required: false },
  { key: "neutral_headshot", label: "Neutral-expression headshot", required: false },
  { key: "extra_angle", label: "Extra angle", required: false },
] as const;

const VOICE_CAPTURE_SLOT = "voice_capture_30s";
const VOICE_CAPTURE_MIN_SECONDS = 30;
const VOICE_CAPTURE_TARGET_SECONDS = 60;
const VOICE_CAPTURE_SAFETY_MAX_SECONDS = 120;
const VOICE_CAPTURE_ACCEPT = "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm";

const RACE_OPTIONS = [
  "Black or African descent",
  "White",
  "Asian",
  "Middle Eastern or North African",
  "Native American or Alaska Native",
  "Native Hawaiian or Other Pacific Islander",
  "Multiracial",
  "Other",
] as const;

const ETHNICITY_BUCKETS = [
  "African / Afro-descendant",
  "Caribbean",
  "Central Asian",
  "East Asian",
  "European",
  "Latina / Latino / Latin American",
  "Middle Eastern",
  "North African",
  "North American",
  "Pacific Islander",
  "South Asian",
  "Southeast Asian",
  "Sub-Saharan African",
  "Other",
] as const;

const GENDER_OPTIONS = [
  "Female",
  "Male",
  "Non-binary",
  "Transgender woman",
  "Transgender man",
  "Prefer to self-describe",
  "Prefer not to say",
] as const;

const PHYSICAL_DESCRIPTION_PLACEHOLDER = "Physical description is intentionally left for host review and completion in this MVP.";

function normalizePhysicalDescriptionValue(raw: any): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.toLowerCase() === PHYSICAL_DESCRIPTION_PLACEHOLDER.toLowerCase()) return "";
  return text;
}

function createEducationEntry(seed?: Partial<EducationEntry>): EducationEntry {
  const fallbackId = `edu_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: String(seed?.id || fallbackId),
    degree: String(seed?.degree || ""),
    field_of_study: String(seed?.field_of_study || ""),
    institution: String(seed?.institution || ""),
    graduation_year: String(seed?.graduation_year || ""),
    notes: String(seed?.notes || ""),
  };
}

function educationEntryHasMeaningfulValue(entry: Partial<EducationEntry> | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  return [entry.degree, entry.field_of_study, entry.institution, entry.graduation_year, entry.notes].some((value) => String(value || "").trim().length > 0);
}

function normalizeEducationEntry(raw: any): EducationEntry | null {
  if (typeof raw === "string") {
    const text = String(raw || "").trim();
    if (!text) return null;
    return createEducationEntry({ notes: text });
  }
  if (!raw || typeof raw !== "object") return null;
  const entry = createEducationEntry({
    id: String((raw as any).id || ""),
    degree: String((raw as any).degree || ""),
    field_of_study: String((raw as any).field_of_study || (raw as any).field || (raw as any).major || ""),
    institution: String((raw as any).institution || (raw as any).school || (raw as any).university || ""),
    graduation_year: String((raw as any).graduation_year || (raw as any).year || ""),
    notes: String((raw as any).notes || (raw as any).summary || (raw as any).education || (raw as any).text || ""),
  });
  return educationEntryHasMeaningfulValue(entry) ? entry : null;
}

function normalizeEducationEntries(raw: any, legacyText?: string): EducationEntry[] {
  const out: EducationEntry[] = [];
  const push = (item: any) => {
    const entry = normalizeEducationEntry(item);
    if (entry) out.push(entry);
  };
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else if (raw && typeof raw === "object") {
    push(raw);
  } else if (typeof raw === "string" && raw.trim()) {
    const parts = raw
      .split(/\n+/)
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
    if (parts.length > 1) {
      parts.forEach((part) => push(part));
    } else {
      push(raw);
    }
  } else if (typeof legacyText === "string" && legacyText.trim()) {
    const parts = legacyText
      .split(/\n+/)
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
    if (parts.length > 1) {
      parts.forEach((part) => push(part));
    } else {
      push(legacyText);
    }
  }
  return out;
}

function formatEducationEntrySummary(entry: Partial<EducationEntry> | null | undefined): string {
  if (!entry || typeof entry !== "object") return "";
  const degree = String(entry.degree || "").trim();
  const field = String(entry.field_of_study || "").trim();
  const institution = String(entry.institution || "").trim();
  const graduationYear = String(entry.graduation_year || "").trim();
  const notes = String(entry.notes || "").trim();
  const lead = degree && field ? `${degree} in ${field}` : degree || field;
  const parts = [lead, institution, graduationYear ? `Class of ${graduationYear}` : ""].filter(Boolean);
  const base = parts.join(" — ");
  return notes ? (base ? `${base}. ${notes}` : notes) : base;
}

function formatEducationEntriesLegacyText(entries: EducationEntry[]): string {
  return (entries || [])
    .map((entry) => formatEducationEntrySummary(entry))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function prettifySectionLabel(label: string): string {
  const map: Record<string, string> = {
    education: "Education",
    career_summary: "Career summary",
    likes: "Likes",
    dislikes: "Dislikes",
    hobbies: "Hobbies",
    lifestyle: "Lifestyle",
    background_story: "Background story",
    core_values: "Core values",
    personal_motto: "Personal motto",
    physical_description: "Physical description",
  };
  const key = String(label || "").trim();
  return map[key] || key.replace(/_/g, " ").split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function dedupeLabels(values: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    const label = prettifySectionLabel(String(value || "").trim());
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function parseJsonMaybe(raw: any): any {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stepFromSession(session: HostOnboardingSession | null): HostOnboardingStep {
  if (!session) return "welcome";
  const state = String(session.workflow_state || "").trim().toLowerCase();
  if (state === "not_started") return "welcome";
  if (state === "in_progress_photos") return "photos";
  if (state === "awaiting_review") return "review";
  if (state === "in_progress_completion") return "completion";
  if (state === "awaiting_final_approval") return "preview";
  if (state === "approved" || state === "approved_with_later_edits_pending") return "preview";
  return Object.keys(session.basics || {}).length ? "photos" : "basics";
}

function commaList(raw: string): string[] {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function slotLabel(slotKey: string): string {
  if (slotKey === VOICE_CAPTURE_SLOT) return "Voice capture (minimum 30 seconds)";
  const found = [...REQUIRED_SLOTS, ...OPTIONAL_SLOTS].find((slot) => slot.key === slotKey);
  return found ? found.label : slotKey.replace(/_/g, " ");
}

const PUBLIC_GALLERY_SLOTS = [...REQUIRED_SLOTS, ...OPTIONAL_SLOTS].filter((slot) => slot.key !== "headshot_front");
const PUBLIC_GALLERY_SLOT_ORDER = Object.fromEntries(PUBLIC_GALLERY_SLOTS.map((slot, idx) => [slot.key, idx]));

function normalizeAssetLike(raw: any): HostOnboardingAsset | null {
  if (!raw || typeof raw !== "object") return null;
  const slotKey = String((raw as any).slot_key || "").trim();
  const url = String((raw as any).url || "").trim();
  if (!slotKey || !url) return null;
  return {
    asset_id: String((raw as any).asset_id || "").trim(),
    session_id: String((raw as any).session_id || "").trim(),
    slot_key: slotKey,
    slot_label: String((raw as any).slot_label || "").trim(),
    required: Boolean((raw as any).required),
    url,
    file_name: String((raw as any).file_name || "").trim(),
    content_type: String((raw as any).content_type || "").trim(),
    size_bytes: Number((raw as any).size_bytes || 0),
    width_px: Number((raw as any).width_px || 0),
    height_px: Number((raw as any).height_px || 0),
    duration_seconds: Number((raw as any).duration_seconds || 0),
    validation_status: String((raw as any).validation_status || "").trim(),
    validation_errors: Array.isArray((raw as any).validation_errors)
      ? (raw as any).validation_errors.map((item: any) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

function orderPublicGalleryAssets(list: HostOnboardingAsset[]): HostOnboardingAsset[] {
  return [...list].sort((a, b) => {
    const ao = Number((PUBLIC_GALLERY_SLOT_ORDER as any)[String(a?.slot_key || "")] ?? 999);
    const bo = Number((PUBLIC_GALLERY_SLOT_ORDER as any)[String(b?.slot_key || "")] ?? 999);
    if (ao !== bo) return ao - bo;
    return String(a?.file_name || a?.slot_key || "").localeCompare(String(b?.file_name || b?.slot_key || ""));
  });
}

function dedupeAssetsBySlot(list: HostOnboardingAsset[]): HostOnboardingAsset[] {
  const seen = new Set<string>();
  const out: HostOnboardingAsset[] = [];
  for (const asset of list || []) {
    const slotKey = String(asset?.slot_key || "").trim();
    if (!slotKey || seen.has(slotKey)) continue;
    seen.add(slotKey);
    out.push(asset);
  }
  return out;
}

function formatDurationSeconds(value: any): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 60) {
    const mins = Math.floor(n / 60);
    const secs = Math.round(n % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }
  return `${Math.round(n * 10) / 10}s`;
}

function guessAudioExtension(mimeType: string): string {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("mpeg") || mt.includes("mp3")) return ".mp3";
  if (mt.includes("wav")) return ".wav";
  if (mt.includes("aac")) return ".aac";
  if (mt.includes("ogg")) return ".ogg";
  if (mt.includes("mp4") || mt.includes("m4a")) return ".m4a";
  return ".webm";
}

async function measureAudioDurationSeconds(file: Blob): Promise<number> {
  if (typeof window === "undefined") return 0;
  const blobUrl = URL.createObjectURL(file);
  try {
    const duration = await new Promise<number>((resolve) => {
      const audio = document.createElement("audio");
      const cleanup = () => { try { audio.src = ""; } catch {} };
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        const d = Number(audio.duration || 0);
        cleanup();
        resolve(Number.isFinite(d) ? d : 0);
      };
      audio.onerror = () => {
        cleanup();
        resolve(0);
      };
      audio.src = blobUrl;
    });
    return duration;
  } finally {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }
}


function countWords(text: string): number {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function estimateSpeechSecondsFromText(text: string): number {
  const wc = countWords(text);
  if (!wc) return 0;
  return Math.max(30, Math.round((wc / 145) * 60));
}

function readableList(items: string[]): string {
  const vals = items.map((x) => String(x || "").trim()).filter(Boolean);
  if (!vals.length) return "";
  if (vals.length === 1) return vals[0];
  if (vals.length === 2) return `${vals[0]} and ${vals[1]}`;
  return `${vals.slice(0, -1).join(", ")}, and ${vals[vals.length - 1]}`;
}

function firstSentence(text: any, maxWords = 24): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const first = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  const words = first.split(/\s+/).filter(Boolean);
  const trimmed = words.length > maxWords ? `${words.slice(0, maxWords).join(" ").replace(/[,:;]+$/, "")}.` : first;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function ensureSentence(text: any): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function splitVoiceList(raw: any, maxItems = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const parts = Array.isArray(raw) ? raw : [raw];
  parts.forEach((value) => {
    String(value || "")
      .split(/[\n,;•]+/)
      .map((piece) => String(piece || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .forEach((piece) => {
        const key = piece.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(piece);
      });
  });
  return out.slice(0, maxItems);
}

function firstClauseWithoutMidSentenceCut(text: any, maxWords = 28): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const first = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  if (countWords(first) <= maxWords) return ensureSentence(first);
  const clauses = first
    .split(/\s*(?:;|—|–|,|\bwhile\b|\bbut\b)\s*/i)
    .map((part) => String(part || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let chosen = "";
  for (const clause of clauses) {
    const candidate = chosen ? `${chosen}, ${clause}` : clause;
    if (countWords(candidate) <= maxWords) {
      chosen = candidate;
      continue;
    }
    break;
  }
  if (chosen && countWords(chosen) >= 6) return ensureSentence(chosen);
  return ensureSentence(first);
}

function escapeRegexLiteral(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function convertNarrativeToFirstPerson(text: any, displayName: string, maxWords = 28): string {
  let out = firstClauseWithoutMidSentenceCut(text, maxWords);
  if (!out) return "";
  const name = String(displayName || "").trim();
  if (name) {
    const escapedName = escapeRegexLiteral(name);
    out = out.replace(new RegExp(`\b${escapedName}'s\b`, "gi"), "my");
    out = out.replace(new RegExp(`\b${escapedName}\b`, "gi"), "I");
  }
  out = out
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}'s\s+father's\s+family\b/, "My father's family")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}'s\s+mother's\s+family\b/, "My mother's family")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}'s\b/, "my")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+is\s+known\s+for\b/, "I am known for")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+combines\b/, "I combine")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+embodies\b/, "I embody")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+maintains\b/, "I maintain")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+values\b/, "I value")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+carries\b/, "I carry")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+approaches\b/, "I approach")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+remains\b/, "I remain")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+prefers\b/, "I prefer")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+enjoys\b/, "I enjoy")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+likes\b/, "I like")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+works\b/, "I work")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+grew\s+up\b/, "I grew up")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+was\b/, "I was")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+has\b/, "I have")
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+is\b/, "I am")
    .replace(/[Ss]he's/g, "I'm")
    .replace(/[Hh]e's/g, "I'm")
    .replace(/[Tt]hey're/g, "I'm")
    .replace(/[Ss]he is/g, "I am")
    .replace(/[Hh]e is/g, "I am")
    .replace(/[Tt]hey are/g, "I am")
    .replace(/[Ss]he was/g, "I was")
    .replace(/[Hh]e was/g, "I was")
    .replace(/[Tt]hey were/g, "I was")
    .replace(/[Ss]he has/g, "I have")
    .replace(/[Hh]e has/g, "I have")
    .replace(/[Tt]hey have/g, "I have")
    .replace(/[Ss]he/g, "I")
    .replace(/[Hh]e/g, "I")
    .replace(/[Tt]hey/g, "I")
    .replace(/[Hh]er/g, "my")
    .replace(/[Hh]is/g, "my")
    .replace(/[Tt]heir/g, "my")
    .replace(/[Hh]ers/g, "mine")
    .replace(/[Tt]heirs/g, "mine")
    .replace(/I combines/g, "I combine")
    .replace(/I embodies/g, "I embody")
    .replace(/I maintains/g, "I maintain")
    .replace(/I values/g, "I value")
    .replace(/I carries/g, "I carry")
    .replace(/I approaches/g, "I approach")
    .replace(/I remains/g, "I remain")
    .replace(/I prefers/g, "I prefer")
    .replace(/I enjoys/g, "I enjoy")
    .replace(/I likes/g, "I like")
    .replace(/I works/g, "I work")
    .replace(/I's/g, "my");
  return ensureSentence(out);
}

function formatEducationEntryForVoice(entry: any): string {
  const degree = String(entry?.degree || entry?.credential || entry?.program_name || "").trim();
  const field = String(entry?.field_of_study || entry?.focus || entry?.academic_focus || "").trim();
  const institution = String(entry?.institution || entry?.school || "").trim();
  const graduationYear = String(entry?.graduation_year || entry?.year || "").trim();
  let phrase = "";
  if (degree && field) {
    phrase = `${degree} in ${field}`;
  } else {
    phrase = degree || field || institution;
  }
  if (institution && !phrase.toLowerCase().includes(institution.toLowerCase())) {
    phrase += phrase ? ` from ${institution}` : institution;
  }
  if (graduationYear) {
    phrase += `${phrase ? ", " : ""}class of ${graduationYear}`;
  }
  return phrase.replace(/\s+/g, " ").trim();
}

function composeVoiceScript(sentences: string[], fillerSentences: string[], minWords = 130, maxWords = 175): string {
  const chosen: string[] = [];
  let total = 0;
  sentences
    .map((sentence) => ensureSentence(sentence))
    .filter(Boolean)
    .forEach((sentence, idx) => {
      const sentenceWords = countWords(sentence);
      const isEssential = idx < 4;
      if (isEssential || total + sentenceWords <= maxWords) {
        chosen.push(sentence);
        total += sentenceWords;
      }
    });
  for (const filler of fillerSentences.map((sentence) => ensureSentence(sentence)).filter(Boolean)) {
    if (total >= minWords) break;
    const fillerWords = countWords(filler);
    if (total + fillerWords > maxWords) continue;
    chosen.push(filler);
    total += fillerWords;
  }
  if (!chosen.length) return "";
  return chosen.join(" ").replace(/\s+/g, " ").trim();
}

function buildVoiceCaptureScriptFromProfile(args: {
  basics?: Record<string, any>;
  review?: Record<string, any>;
  completion?: Record<string, any>;
  publicProfile?: Record<string, any>;
  privateProfile?: Record<string, any>;
}): string {
  const basics = args.basics || {};
  const review = args.review || {};
  const completion = args.completion || {};
  const publicProfile = args.publicProfile || {};
  const privateProfile = args.privateProfile || {};

  const stageName = String(publicProfile.public_display_name || publicProfile.stage_name || basics.stage_name || basics.public_display_name || "this host").trim();
  const zodiac = String(publicProfile.zodiac_sign || review.zodiac_sign || "").trim();
  const physical = convertNarrativeToFirstPerson(publicProfile.physical_description || review.physical_description_draft || completion.physical_description, stageName, 28);
  const personality = convertNarrativeToFirstPerson(publicProfile.personality || review.personality_draft, stageName, 26);
  const family = convertNarrativeToFirstPerson(publicProfile.family_heritage || review.family_heritage_draft, stageName, 28);
  const educationEntries = Array.isArray(publicProfile.education_entries) && publicProfile.education_entries.length
    ? publicProfile.education_entries
    : Array.isArray(completion.education_entries) && completion.education_entries.length
      ? completion.education_entries
      : [];
  const educationLine = readableList(educationEntries.map((entry: any) => formatEducationEntryForVoice(entry)).filter(Boolean).slice(0, 2));
  const career = (publicProfile.career && typeof publicProfile.career === "object") ? publicProfile.career : {};
  const currentJobTitle = String(career.current_job_title || completion.current_job_title || "").trim();
  const currentCompany = String(career.current_company || completion.current_company || "").trim();
  const careerSummary = convertNarrativeToFirstPerson(career.career_summary || completion.career_summary, stageName, 24);
  const interests = readableList(splitVoiceList([completion.likes, completion.hobbies, publicProfile.likes, publicProfile.hobbies], 4));
  const lifestyle = convertNarrativeToFirstPerson(publicProfile.lifestyle || completion.lifestyle, stageName, 24);
  const background = convertNarrativeToFirstPerson(publicProfile.background_story || completion.background_story, stageName, 26);
  const coreValueList = splitVoiceList([publicProfile.core_values, completion.core_values], 6);
  const motto = String(publicProfile.personal_motto || completion.personal_motto || "").replace(/\s+/g, " ").trim();
  const birthCountry = String(privateProfile.birth_country || basics.birth_country || "").trim();
  const nationalities = Array.isArray(privateProfile.nationalities) ? privateProfile.nationalities.map((v: any) => String(v || "").trim()).filter(Boolean).slice(0, 2) : [];

  const primarySentences: string[] = [
    `Hello, my name is ${stageName}. Thank you for listening to my voice sample for the Connect Platform.`,
  ];
  if (personality) {
    primarySentences.push(personality);
  } else if (zodiac) {
    primarySentences.push(`I bring the thoughtful and intentional energy often associated with ${zodiac}.`);
  }
  if (physical) primarySentences.push(physical);
  if (educationLine) primarySentences.push(`My educational background includes ${educationLine}.`);
  if (currentJobTitle && currentCompany) {
    primarySentences.push(`Professionally, I work as ${currentJobTitle} at ${currentCompany}.`);
  } else if (currentJobTitle) {
    primarySentences.push(`Professionally, I work as ${currentJobTitle}.`);
  } else if (careerSummary) {
    primarySentences.push(careerSummary);
  }
  if (family) {
    primarySentences.push(family);
  } else if (background) {
    primarySentences.push(background);
  }
  if (birthCountry && nationalities.length) {
    primarySentences.push(`My background is rooted in ${birthCountry}, and my approved nationality profile includes ${readableList(nationalities)}.`);
  }
  if (interests) primarySentences.push(`In my personal time, I enjoy ${interests}.`);
  if (lifestyle) primarySentences.push(lifestyle);
  if (coreValueList.length) primarySentences.push(`My values are centered on ${readableList(coreValueList)}.`);
  if (motto) primarySentences.push(`A phrase that represents me well is: ${motto.replace(/[.!?]+$/, "")}.`);
  primarySentences.push("I want this sample to sound natural, confident, and consistent with the approved profile information that represents me on the platform.");
  primarySentences.push("Thank you for listening, and I hope this gives you a clear sense of my voice, presence, and personality.");

  const fillerSentences = [
    "I am reading this at a calm, conversational pace so you can hear my pronunciation, warmth, and natural rhythm clearly.",
    "I want this recording to feel polished and expressive while still sounding authentic to the way I would naturally introduce myself and speak in a real conversation.",
  ];

  return composeVoiceScript(primarySentences, fillerSentences, 130, 175);
}

function isAllowedWixOrigin(origin: string): boolean {
  const o = String(origin || "").trim().toLowerCase();
  if (!o) return false;
  if (o === window.location.origin.toLowerCase()) return true;
  return (
    o === "https://elaralo.com" ||
    o === "https://www.elaralo.com" ||
    /\.wixsite\.com$/.test(new URL(o).hostname) ||
    new URL(o).hostname === "editor.wix.com" ||
    new URL(o).hostname === "manage.wix.com"
  );
}

function queryContext(): Partial<HostOnboardingContext> {
  if (typeof window === "undefined") return {};
  const qs = new URLSearchParams(window.location.search || "");
  const loggedIn = qs.get("loggedIn") === "1" || qs.get("logged_in") === "1" || qs.get("loggedIn") === "true";
  return {
    memberId: String(qs.get("memberId") || qs.get("member_id") || "").trim(),
    loggedIn,
    brand: String(qs.get("brand") || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME,
    avatar: String(qs.get("avatar") || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME,
    hostDisplayName: String(qs.get("displayName") || qs.get("display_name") || qs.get("user_name") || "").trim(),
    email: String(qs.get("email") || "").trim(),
    source: "query",
  };
}

export default function HostProfileStudioClient() {
  const [context, setContext] = useState<HostOnboardingContext>(() => {
    const q = queryContext();
    return {
      memberId: String(q.memberId || ""),
      loggedIn: Boolean(q.loggedIn),
      brand: String(q.brand || DEFAULT_COMPANY_NAME),
      avatar: String(q.avatar || DEFAULT_COMPANION_NAME),
      hostDisplayName: String(q.hostDisplayName || ""),
      email: String(q.email || ""),
      source: String(q.source || "initial"),
    };
  });
  const [waitingForContext, setWaitingForContext] = useState<boolean>(() => !Boolean(queryContext().memberId));
  const trustedOriginRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      let data: any = parseJsonMaybe(event.data);
      if (!data || typeof data !== "object") return;
      const msgType = String((data as any).type || "").trim();
      if (msgType !== "HOST_ONBOARDING_CONTEXT" && msgType !== "MEMBER_PLAN") return;
      try {
        if (!trustedOriginRef.current) {
          if (!isAllowedWixOrigin(event.origin)) return;
          trustedOriginRef.current = event.origin;
        } else if (trustedOriginRef.current !== event.origin && event.origin !== window.location.origin) {
          return;
        }
      } catch {
        return;
      }
      const next: HostOnboardingContext = {
        memberId: String((data as any).memberId || (data as any).member_id || "").trim(),
        loggedIn: Boolean((data as any).loggedIn === true || (data as any).logged_in === true),
        brand: String((data as any).brand || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME,
        avatar: String((data as any).avatar || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME,
        hostDisplayName: String((data as any).hostDisplayName || (data as any).displayName || (data as any).display_name || (data as any).user_name || "").trim(),
        email: String((data as any).email || "").trim(),
        source: "postMessage",
      };
      if (!next.memberId) return;
      setContext(next);
      setWaitingForContext(false);
    }
    window.addEventListener("message", onMessage as any);
    try {
      const request = { type: "HOST_ONBOARDING_CONTEXT_REQUEST", href: window.location.href, embedded: window.self !== window.top };
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(request, "*");
      }
      if (window.top && window.top !== window.parent) {
        window.top.postMessage(request, "*");
      }
    } catch {}
    return () => window.removeEventListener("message", onMessage as any);
  }, []);

  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [step, setStep] = useState<HostOnboardingStep>("welcome");
  const [session, setSession] = useState<HostOnboardingSession | null>(null);
  const [readiness, setReadiness] = useState<HostOnboardingReadiness>({});
  const [previewData, setPreviewData] = useState<any>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string>("");
  const uploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const voiceUploadInputRef = useRef<HTMLInputElement | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<BlobPart[]>([]);
  const voiceStartedAtRef = useRef<number>(0);
  const voiceTickTimerRef = useRef<number | null>(null);
  const voiceStopTimerRef = useRef<number | null>(null);
  const [recordingVoice, setRecordingVoice] = useState<boolean>(false);
  const [voiceRecordingElapsed, setVoiceRecordingElapsed] = useState<number>(0);

  const [basicsForm, setBasicsForm] = useState<Record<string, any>>({
    legal_name: "",
    stage_name: "",
    public_display_name: "",
    gender_pick: "Female",
    gender_custom: "",
    birthdate: "",
    birth_city: "",
    birth_state_region: "",
    birth_country: "",
    race_primary: "",
    race_detail: "",
    ethnicity_bucket: "",
    ethnicity_detail: "",
  });
  const [threeDOptIn, setThreeDOptIn] = useState<boolean>(false);
  const [assetsBySlot, setAssetsBySlot] = useState<Record<string, HostOnboardingAsset>>({});
  const [reviewForm, setReviewForm] = useState<Record<string, any>>({
    age_years: "",
    zodiac_sign: "",
    nationalities_text: "",
    family_heritage_draft: "",
    personality_draft: "",
    physical_description_draft: "",
    astrological_narrative: "",
    astrological_strengths_text: "",
    astrological_challenges_text: "",
    quick_reference_public_name: "",
    quick_reference_age: "",
    quick_reference_zodiac: "",
    quick_reference_birth_location: "",
    quick_reference_race: "",
    quick_reference_ethnicity: "",
  });
  const [completionForm, setCompletionForm] = useState<Record<string, any>>({
    education_entries: [createEducationEntry()],
    current_job_title: "",
    current_company: "",
    career_summary: "",
    estimated_income: "",
    likes: "",
    dislikes: "",
    hobbies: "",
    lifestyle: "",
    background_story: "",
    core_values: "",
    personal_motto: "",
    physical_description: "",
    phonetic_pronunciation: "",
    list_in_companion_catalog: false,
    skipped_sections: {},
  });
  const [showCompletionPhysicalDescriptionEditor, setShowCompletionPhysicalDescriptionEditor] = useState<boolean>(false);
  const [catalogVisibilitySaving, setCatalogVisibilitySaving] = useState<boolean>(false);
  const [localProfileDirty, setLocalProfileDirty] = useState<boolean>(false);

  const hydrateFromSession = useCallback((payload: HostOnboardingSession | null, readinessIn?: HostOnboardingReadiness | null) => {
    setSession(payload);
    setReadiness(readinessIn || {});
    if (!payload) return;
    const basics = { ...(payload.basics || {}) };
    const derived = { ...(payload.derived || {}) };
    const review = { ...(payload.review || {}) };
    const completion = { ...(payload.completion || {}) };
    setBasicsForm((prev) => ({
      ...prev,
      legal_name: String(basics.legal_name || ""),
      stage_name: String(basics.stage_name || ""),
      public_display_name: String(basics.public_display_name || basics.stage_name || ""),
      gender_pick: String(basics.gender_pick || prev.gender_pick || "Female"),
      gender_custom: String(basics.gender_custom || ""),
      birthdate: String(basics.birthdate || ""),
      birth_city: String(basics.birth_city || ""),
      birth_state_region: String(basics.birth_state_region || ""),
      birth_country: String(basics.birth_country || ""),
      race_primary: String(basics.race_primary || ""),
      race_detail: String(basics.race_detail || ""),
      ethnicity_bucket: String(basics.ethnicity_bucket || ""),
      ethnicity_detail: String(basics.ethnicity_detail || ""),
    }));
    setThreeDOptIn(Boolean(payload.three_d_opt_in === true));
    const nextAssets: Record<string, HostOnboardingAsset> = {};
    (payload.assets || []).forEach((asset) => {
      if (asset && asset.slot_key) nextAssets[String(asset.slot_key)] = asset;
    });
    setAssetsBySlot(nextAssets);
    setReviewForm((prev) => ({
      ...prev,
      age_years: review.age_years ?? derived.age_years ?? "",
      zodiac_sign: String(review.zodiac_sign || derived.zodiac_sign || ""),
      nationalities_text: Array.isArray(review.nationalities)
        ? review.nationalities.join(", ")
        : Array.isArray(derived.nationalities)
          ? derived.nationalities.join(", ")
          : "",
      family_heritage_draft: String(review.family_heritage_draft || derived.family_heritage_draft || ""),
      personality_draft: String(review.personality_draft || derived.personality_draft || ""),
      physical_description_draft: normalizePhysicalDescriptionValue(review.physical_description_draft || derived.physical_description_draft || ""),
      astrological_narrative: String(
        ((review.astrological_profile || {}).narrative) ||
          ((derived.astrological_profile || {}).narrative) ||
          "",
      ),
      astrological_strengths_text: Array.isArray((review.astrological_profile || {}).strengths)
        ? (review.astrological_profile || {}).strengths.join(", ")
        : Array.isArray((derived.astrological_profile || {}).strengths)
          ? (derived.astrological_profile || {}).strengths.join(", ")
          : "",
      astrological_challenges_text: Array.isArray((review.astrological_profile || {}).challenges)
        ? (review.astrological_profile || {}).challenges.join(", ")
        : Array.isArray((derived.astrological_profile || {}).challenges)
          ? (derived.astrological_profile || {}).challenges.join(", ")
          : "",
      quick_reference_public_name: String(
        ((review.quick_reference || {}).public_name) || ((derived.quick_reference || {}).public_name) || basics.stage_name || "",
      ),
      quick_reference_age: String(((review.quick_reference || {}).age) ?? ((derived.quick_reference || {}).age) ?? ""),
      quick_reference_zodiac: String(
        ((review.quick_reference || {}).zodiac_sign) || ((derived.quick_reference || {}).zodiac_sign) || derived.zodiac_sign || "",
      ),
      quick_reference_birth_location: String(
        ((review.quick_reference || {}).birth_location) || ((derived.quick_reference || {}).birth_location) || "",
      ),
      quick_reference_race: String(((review.quick_reference || {}).race) || ((derived.quick_reference || {}).race) || basics.race_primary || ""),
      quick_reference_ethnicity: String(((review.quick_reference || {}).ethnicity) || ((derived.quick_reference || {}).ethnicity) || basics.ethnicity_detail || ""),
    }));
    const hydratedCompletionPhysicalDescription = normalizePhysicalDescriptionValue(completion.physical_description || "");
    const hydratedReviewPhysicalDescription = normalizePhysicalDescriptionValue(review.physical_description_draft || derived.physical_description_draft || "");
    const hydratedEducationEntries = normalizeEducationEntries(completion.education_entries, completion.education);
    setCompletionForm((prev) => ({
      ...prev,
      education_entries: hydratedEducationEntries.length ? hydratedEducationEntries : [createEducationEntry()],
      current_job_title: String(completion.current_job_title || ""),
      current_company: String(completion.current_company || ""),
      career_summary: String(completion.career_summary || ""),
      estimated_income: String(completion.estimated_income || ""),
      likes: String(completion.likes || ""),
      dislikes: String(completion.dislikes || ""),
      hobbies: String(completion.hobbies || ""),
      lifestyle: String(completion.lifestyle || ""),
      background_story: String(completion.background_story || ""),
      core_values: String(completion.core_values || ""),
      personal_motto: String(completion.personal_motto || ""),
      physical_description: hydratedCompletionPhysicalDescription,
      phonetic_pronunciation: String(
        completion.phonetic_pronunciation ||
          completion.phonetic_pronunciation_of_first_name ||
          completion.phonetic_spelling ||
          completion.phonetic ||
          "",
      ),
      list_in_companion_catalog: Boolean(
        completion.list_in_companion_catalog ??
          completion.listInCompanionCatalog ??
          completion.catalog_visible ??
          completion.catalogVisible ??
          completion.show_in_companion_catalog ??
          completion.showInCompanionCatalog ??
          false,
      ),
      skipped_sections: typeof completion.skipped_sections === "object" && completion.skipped_sections ? completion.skipped_sections : {},
    }));
    setShowCompletionPhysicalDescriptionEditor(Boolean(hydratedCompletionPhysicalDescription) || !Boolean(hydratedReviewPhysicalDescription));
    setStep(stepFromSession(payload));
  }, []);

  useEffect(() => {
    return () => {
      try { voiceRecorderRef.current?.stop(); } catch {}
      voiceRecorderRef.current = null;
      try { voiceStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      voiceStreamRef.current = null;
      if (voiceTickTimerRef.current !== null) {
        window.clearInterval(voiceTickTimerRef.current);
        voiceTickTimerRef.current = null;
      }
      if (voiceStopTimerRef.current !== null) {
        window.clearTimeout(voiceStopTimerRef.current);
        voiceStopTimerRef.current = null;
      }
    };
  }, []);

  const startOrResumeSession = useCallback(async () => {
    if (!API_BASE) {
      setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
      setLoading(false);
      return;
    }
    if (!context.loggedIn || !context.memberId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: context.memberId,
          brand: context.brand,
          avatar: context.avatar,
          loggedIn: true,
          hostDisplayName: context.hostDisplayName,
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) {
        throw new Error(String(data?.detail || data?.message || `HTTP ${res.status}`));
      }
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
    } catch (err: any) {
      setError(String(err?.message || "Unable to start Host Onboarding."));
    } finally {
      setLoading(false);
    }
  }, [context, hydrateFromSession]);

  useEffect(() => {
    if (!context.memberId || !context.loggedIn) {
      setLoading(false);
      return;
    }
    void startOrResumeSession();
  }, [context.memberId, context.loggedIn, startOrResumeSession]);

  const requiredPhotoMissing = useMemo(() => {
    return REQUIRED_SLOTS.filter((slot) => !assetsBySlot[slot.key]?.url).map((slot) => slot.label);
  }, [assetsBySlot]);

  const saveBasics = useCallback(async () => {
    if (!session?.session_id) return;
    const missing = [
      ["Legal name", basicsForm.legal_name],
      ["Stage/public name", basicsForm.stage_name],
      ["Birthdate", basicsForm.birthdate],
      ["Birth city", basicsForm.birth_city],
      ["Birth state/region", basicsForm.birth_state_region],
      ["Birth country", basicsForm.birth_country],
      ["Race", basicsForm.race_primary],
      ["Ethnicity bucket", basicsForm.ethnicity_bucket],
    ].filter(([, v]) => !String(v || "").trim());
    if (missing.length) {
      setError(`Complete the required basics fields before continuing: ${missing.map(([label]) => label).join(", ")}.`);
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/basics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId, basics: basicsForm }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setStep("photos");
      setNotice("Basics saved.");
    } catch (err: any) {
      setError(String(err?.message || "Unable to save basics."));
    } finally {
      setSaving(false);
    }
  }, [basicsForm, context.memberId, hydrateFromSession, session?.session_id]);

  const savePhotosConfig = useCallback(async (nextValue: boolean) => {
    if (!session?.session_id) return;
    setThreeDOptIn(nextValue);
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/photos-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId, threeDOptIn: nextValue }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (res.ok && data?.session) {
        hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      }
    } catch {
      // ignore best-effort toggle sync
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  const openSlotPicker = useCallback((slotKey: string) => {
    const node = uploadInputRefs.current[slotKey];
    if (node) {
      try { node.click(); } catch {}
    }
  }, []);

  const handleUploadForSlot = useCallback(async (slotKey: string, file: File | null) => {
    if (!session?.session_id || !file) return;
    setUploadingSlot(slotKey);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/files/upload`, {
        method: "POST",
        headers: {
          "Content-Type": String(file.type || "application/octet-stream"),
          "X-Session-Id": session.session_id,
          "X-Member-Id": context.memberId,
          "X-Slot-Key": slotKey,
          "X-Filename": String(file.name || `${slotKey}.jpg`),
        },
        body: file,
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setNotice(`${slotLabel(slotKey)} uploaded.`);
    } catch (err: any) {
      setError(String(err?.message || `Unable to upload ${slotLabel(slotKey)}.`));
    } finally {
      setUploadingSlot("");
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  const handleUploadVoiceCapture = useCallback(async (fileLike: File | Blob | null, preferredName?: string, preferredDurationSeconds?: number) => {
    if (!session?.session_id || !fileLike) return;
    const blob = fileLike;
    const measuredDuration = Number(preferredDurationSeconds || 0) > 0
      ? Number(preferredDurationSeconds || 0)
      : await measureAudioDurationSeconds(blob);
    const mimeType = String((blob as any)?.type || "audio/webm") || "audio/webm";
    const fileName = preferredName || `voice-capture${guessAudioExtension(mimeType)}`;
    const uploadFile = blob instanceof File ? blob : new File([blob], fileName, { type: mimeType });
    setUploadingSlot(VOICE_CAPTURE_SLOT);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/files/upload`, {
        method: "POST",
        headers: {
          "Content-Type": String(uploadFile.type || mimeType || "application/octet-stream"),
          "X-Session-Id": session.session_id,
          "X-Member-Id": context.memberId,
          "X-Slot-Key": VOICE_CAPTURE_SLOT,
          "X-Filename": String(uploadFile.name || fileName),
          "X-Duration-Seconds": String(Number(measuredDuration || 0)),
        },
        body: uploadFile,
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setNotice("Voice capture uploaded.");
    } catch (err: any) {
      setError(String(err?.message || "Unable to upload the voice capture."));
    } finally {
      setUploadingSlot("");
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  const stopVoiceCapture = useCallback(() => {
    try { voiceRecorderRef.current?.stop(); } catch {}
  }, []);

  const startVoiceCapture = useCallback(async () => {
    if (recordingVoice) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice capture is not supported in this browser. Upload a recorded audio file instead.");
      return;
    }
    setError("");
    setNotice("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
      const chosenMime = mimeCandidates.find((mime) => {
        try {
          return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime);
        } catch {
          return false;
        }
      }) || "audio/webm";
      const recorder = new MediaRecorder(stream, chosenMime ? { mimeType: chosenMime } as MediaRecorderOptions : undefined);
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      voiceStartedAtRef.current = Date.now();
      setVoiceRecordingElapsed(0);
      setRecordingVoice(true);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecordingVoice(false);
        setError("Voice capture failed. Please try again or upload a file instead.");
      };
      recorder.onstop = async () => {
        const elapsed = (Date.now() - voiceStartedAtRef.current) / 1000;
        setRecordingVoice(false);
        setVoiceRecordingElapsed(elapsed);
        if (voiceTickTimerRef.current !== null) {
          window.clearInterval(voiceTickTimerRef.current);
          voiceTickTimerRef.current = null;
        }
        if (voiceStopTimerRef.current !== null) {
          window.clearTimeout(voiceStopTimerRef.current);
          voiceStopTimerRef.current = null;
        }
        try { voiceStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
        voiceStreamRef.current = null;
        const mimeType = String(recorder.mimeType || chosenMime || "audio/webm");
        const blob = new Blob(voiceChunksRef.current, { type: mimeType });
        voiceChunksRef.current = [];
        voiceRecorderRef.current = null;
        if (!blob.size) {
          setError("Voice capture was empty. Please try again.");
          return;
        }
        await handleUploadVoiceCapture(blob, `voice-capture${guessAudioExtension(mimeType)}`, elapsed);
      };
      recorder.start();
      voiceTickTimerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - voiceStartedAtRef.current) / 1000;
        setVoiceRecordingElapsed(elapsed);
      }, 250);
      voiceStopTimerRef.current = window.setTimeout(() => {
        try { recorder.stop(); } catch {}
      }, VOICE_CAPTURE_SAFETY_MAX_SECONDS * 1000);
    } catch (err: any) {
      setRecordingVoice(false);
      setError(String(err?.message || "Unable to start voice capture."));
      try { voiceStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      voiceStreamRef.current = null;
    }
  }, [handleUploadVoiceCapture, recordingVoice]);

  const runDerivation = useCallback(async () => {
    if (!session?.session_id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/derive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setStep("review");
      setNotice("Derived draft generated. Please review and edit any field before acceptance.");
    } catch (err: any) {
      setError(String(err?.message || "Unable to generate derived draft."));
    } finally {
      setSaving(false);
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  const saveReview = useCallback(async () => {
    if (!session?.session_id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const reviewPayload = {
        age_years: reviewForm.age_years ? Number(reviewForm.age_years) : null,
        zodiac_sign: reviewForm.zodiac_sign,
        nationalities: commaList(reviewForm.nationalities_text),
        family_heritage_draft: reviewForm.family_heritage_draft,
        personality_draft: reviewForm.personality_draft,
        physical_description_draft: reviewForm.physical_description_draft,
        astrological_profile: {
          sign: reviewForm.zodiac_sign,
          strengths: commaList(reviewForm.astrological_strengths_text),
          challenges: commaList(reviewForm.astrological_challenges_text),
          narrative: reviewForm.astrological_narrative,
        },
        quick_reference: {
          public_name: reviewForm.quick_reference_public_name,
          age: reviewForm.quick_reference_age ? Number(reviewForm.quick_reference_age) : null,
          zodiac_sign: reviewForm.quick_reference_zodiac,
          birth_location: reviewForm.quick_reference_birth_location,
          race: reviewForm.quick_reference_race,
          ethnicity: reviewForm.quick_reference_ethnicity,
        },
      };
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId, review: reviewPayload }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setStep("completion");
      setNotice("Derived review accepted. Complete or intentionally skip the remaining profile sections.");
    } catch (err: any) {
      setError(String(err?.message || "Unable to save review changes."));
    } finally {
      setSaving(false);
    }
  }, [context.memberId, hydrateFromSession, reviewForm, session?.session_id]);

  const saveCatalogVisibilityPreference = useCallback(async (nextVisible: boolean) => {
    // Keep the catalog-listing toggle as a lightweight preference update.
    // It should not navigate the iframe, submit the completion form, or move steps.
    if (!context.memberId) {
      setError("Unable to save catalog visibility because member context is missing.");
      return;
    }
    setCatalogVisibilitySaving(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/catalog-visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: context.memberId,
          brand: context.brand,
          avatar: context.avatar,
          sessionId: session?.session_id || "",
          visible: Boolean(nextVisible),
          list_in_companion_catalog: Boolean(nextVisible),
          catalog_visible: Boolean(nextVisible),
          show_in_companion_catalog: Boolean(nextVisible),
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || data?.ok === false) throw new Error(String(data?.detail || data?.message || `HTTP ${res.status}`));
      setNotice(
        data?.mapping_missing
          ? "Catalog visibility preference saved. The public catalog row will be updated after this Host profile is exported."
          : Boolean(nextVisible)
            ? "Your Host profile will be listed in the Companion catalog."
            : "Your Host profile is hidden from the Companion catalog."
      );
    } catch (err: any) {
      setCompletionForm((p) => ({ ...p, list_in_companion_catalog: !Boolean(nextVisible) }));
      setError(String(err?.message || "Unable to save catalog visibility."));
    } finally {
      setCatalogVisibilitySaving(false);
    }
  }, [context.avatar, context.brand, context.memberId, session?.session_id]);

  const handleCatalogVisibilityChange = useCallback((nextVisible: boolean) => {
    setCompletionForm((p) => ({
      ...p,
      list_in_companion_catalog: Boolean(nextVisible),
      catalog_visible: Boolean(nextVisible),
      show_in_companion_catalog: Boolean(nextVisible),
    }));
    void saveCatalogVisibilityPreference(Boolean(nextVisible));
  }, [saveCatalogVisibilityPreference]);

  const saveCompletion = useCallback(async () => {
    if (!session?.session_id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const educationEntries = (Array.isArray(completionForm.education_entries) ? completionForm.education_entries : [])
        .map((entry: any) => normalizeEducationEntry(entry))
        .filter((entry: EducationEntry | null): entry is EducationEntry => Boolean(entry));
      const phoneticPronunciation = String(completionForm.phonetic_pronunciation || "").trim();
      const completionPayload = {
        ...completionForm,
        phonetic_pronunciation: phoneticPronunciation,
        phonetic_pronunciation_of_first_name: phoneticPronunciation,
        list_in_companion_catalog: Boolean(completionForm.list_in_companion_catalog),
        catalog_visible: Boolean(completionForm.list_in_companion_catalog),
        show_in_companion_catalog: Boolean(completionForm.list_in_companion_catalog),
        education_entries: educationEntries.map(({ id, ...rest }) => rest),
        education: formatEducationEntriesLegacyText(educationEntries),
      };
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId, completion: completionPayload }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setStep("preview");
      setNotice("Completion step saved.");
    } catch (err: any) {
      setError(String(err?.message || "Unable to save completion step."));
    } finally {
      setSaving(false);
    }
  }, [completionForm, context.memberId, hydrateFromSession, session?.session_id]);

  const loadPreview = useCallback(async () => {
    if (!session?.session_id) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.preview) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      setPreviewData(data.preview);
      if (data?.session) {
        hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      }
    } catch (err: any) {
      setError(String(err?.message || "Unable to load final preview."));
    } finally {
      setSaving(false);
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  const handleReplacePublicGalleryAsset = useCallback(async (slotKey: string, file: File | null) => {
    if (!file) return;
    await handleUploadForSlot(slotKey, file);
    if (session?.session_id) {
      await loadPreview();
    }
  }, [handleUploadForSlot, loadPreview, session?.session_id]);

  const approveProfile = useCallback(async (scope: "limited" | "full") => {
    if (!session?.session_id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/host-onboarding/session/${session.session_id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: context.memberId, publishScope: scope }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.session) throw new Error(String(data?.detail || `HTTP ${res.status}`));
      hydrateFromSession(data.session as HostOnboardingSession, (data?.readiness || {}) as HostOnboardingReadiness);
      setPreviewData(data.preview || null);
      if (scope === "full") setLocalProfileDirty(false);
      setNotice(scope === "full" ? "Full profile approved." : "Limited profile approved.");
      setStep("preview");
    } catch (err: any) {
      setError(String(err?.message || "Unable to approve profile."));
    } finally {
      setSaving(false);
    }
  }, [context.memberId, hydrateFromSession, session?.session_id]);

  useEffect(() => {
    if (step === "preview" && session?.session_id) {
      void loadPreview();
    }
  }, [loadPreview, session?.session_id, step]);

  const updateEducationEntry = useCallback((entryId: string, field: keyof Omit<EducationEntry, "id">, value: string) => {
    setCompletionForm((prev) => ({
      ...prev,
      education_entries: (Array.isArray(prev.education_entries) ? prev.education_entries : [createEducationEntry()]).map((entry: EducationEntry) =>
        String(entry.id) === String(entryId) ? { ...entry, [field]: value } : entry,
      ),
    }));
  }, []);

  const addEducationEntry = useCallback(() => {
    setCompletionForm((prev) => ({
      ...prev,
      education_entries: [...(Array.isArray(prev.education_entries) ? prev.education_entries : []), createEducationEntry()],
    }));
  }, []);

  const removeEducationEntry = useCallback((entryId: string) => {
    setCompletionForm((prev) => {
      const current = Array.isArray(prev.education_entries) ? prev.education_entries : [];
      const filtered = current.filter((entry: EducationEntry) => String(entry.id) !== String(entryId));
      return {
        ...prev,
        education_entries: filtered.length ? filtered : [createEducationEntry()],
      };
    });
  }, []);

  const moveEducationEntry = useCallback((entryId: string, direction: -1 | 1) => {
    setCompletionForm((prev) => {
      const current = Array.isArray(prev.education_entries) ? [...prev.education_entries] : [];
      const index = current.findIndex((entry: EducationEntry) => String(entry.id) === String(entryId));
      if (index < 0) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return prev;
      const next = [...current];
      const temp = next[index];
      next[index] = next[nextIndex];
      next[nextIndex] = temp;
      return {
        ...prev,
        education_entries: next,
      };
    });
  }, []);

  const updateCompletionSkip = useCallback((key: string, checked: boolean) => {
    setCompletionForm((prev) => ({
      ...prev,
      skipped_sections: {
        ...(typeof prev.skipped_sections === "object" && prev.skipped_sections ? prev.skipped_sections : {}),
        [key]: checked,
      },
    }));
  }, []);

  const cardStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 18,
    background: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
    padding: 18,
    position: "relative",
    zIndex: 0,
    isolation: "isolate",
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.16)",
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    background: "#fff",
    position: "relative",
    zIndex: 2,
    pointerEvents: "auto",
    WebkitUserSelect: "text",
    userSelect: "text",
    touchAction: "manipulation",
  };
  const textareaStyle: React.CSSProperties = {
    ...inputStyle,
    minHeight: 132,
    resize: "vertical",
  };
  const buttonStyle: React.CSSProperties = {
    borderRadius: 12,
    padding: "12px 16px",
    border: "1px solid #111827",
    background: "#111827",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    position: "relative",
    zIndex: 2,
    pointerEvents: "auto",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  };
  const secondaryButtonStyle: React.CSSProperties = {
    borderRadius: 12,
    padding: "12px 16px",
    border: "1px solid rgba(0,0,0,0.16)",
    background: "white",
    color: "#111827",
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    position: "relative",
    zIndex: 2,
    pointerEvents: "auto",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  };
  const checkboxStyle: React.CSSProperties = {
    width: 18,
    height: 18,
    minWidth: 18,
    marginTop: 2,
    position: "relative",
    zIndex: 3,
    pointerEvents: "auto",
    cursor: "pointer",
    touchAction: "manipulation",
  };

  const renderLabeledInput = (label: string, value: any, onChange: (next: string) => void, placeholder: string, extra?: React.ReactNode) => (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontWeight: 700 }}>{label}</span>
      <input value={String(value || "")} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} onClick={(e) => e.currentTarget.focus()} />
      {extra}
    </label>
  );

  const renderTextareaField = (label: string, value: any, onChange: (next: string) => void, placeholder: string, skipKey?: string) => (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        {skipKey ? (
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, color: "#555" }}>
            <input
              type="checkbox"
              checked={Boolean((completionForm.skipped_sections || {})[skipKey])}
              onChange={(e) => updateCompletionSkip(skipKey, e.target.checked)}
              style={checkboxStyle}
            />
            Skip for now (limited publish only)
          </label>
        ) : null}
      </div>
      <textarea value={String(value || "")} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={textareaStyle} onClick={(e) => e.currentTarget.focus()} />
    </div>
  );

  const stepItems: Array<{ key: HostOnboardingStep; label: string }> = [
    { key: "welcome", label: "Welcome" },
    { key: "basics", label: "Basics" },
    { key: "photos", label: "Photos" },
    { key: "review", label: "Review" },
    { key: "completion", label: "Complete" },
    { key: "preview", label: "Preview" },
  ];
  const currentStepIndex = Math.max(0, stepItems.findIndex((item) => item.key === step));
  const reviewPhysicalDescriptionAccepted = Boolean(normalizePhysicalDescriptionValue(reviewForm.physical_description_draft));
  const completionPhysicalDescriptionValue = normalizePhysicalDescriptionValue(completionForm.physical_description);
  const shouldShowCompletionPhysicalDescription = Boolean(showCompletionPhysicalDescriptionEditor || completionPhysicalDescriptionValue || !reviewPhysicalDescriptionAccepted);
  const fullPublishMissingSections = useMemo(
    () => dedupeLabels(Array.isArray(readiness.full_publish_missing_sections) ? readiness.full_publish_missing_sections : []),
    [readiness.full_publish_missing_sections],
  );
  const limitedPublishMissingSections = useMemo(
    () => dedupeLabels(Array.isArray(readiness.limited_publish_missing_sections) ? readiness.limited_publish_missing_sections : []),
    [readiness.limited_publish_missing_sections],
  );
  const voiceCaptureBlockers = useMemo(
    () => dedupeLabels(Array.isArray(readiness.voice_capture_blockers) ? readiness.voice_capture_blockers : []),
    [readiness.voice_capture_blockers],
  );

  const privateProfile = previewData?.private_profile || {};
  const publicProfile = previewData?.public_profile || {};
  const publicPage = previewData?.public_page || {};
  const completionEducationEntries: EducationEntry[] = Array.isArray(completionForm.education_entries) && completionForm.education_entries.length
    ? completionForm.education_entries
    : [createEducationEntry()];
  const publicSummaryHref = useMemo(() => {
    const member = String(session?.member_id || context.memberId || "").trim();
    return member ? `/summary-public?memberId=${encodeURIComponent(member)}` : "";
  }, [context.memberId, session?.member_id]);
  const publicGalleryCount = Array.isArray(publicPage?.gallery_assets)
    ? publicPage.gallery_assets.length
    : Array.isArray(publicProfile?.gallery_assets)
      ? publicProfile.gallery_assets.length
      : 0;
  const sessionAssetMap = useMemo(() => {
    const out: Record<string, HostOnboardingAsset> = {};
    for (const asset of Array.isArray(session?.assets) ? session.assets : []) {
      const normalized = normalizeAssetLike(asset);
      if (!normalized) continue;
      out[String(normalized.slot_key)] = normalized;
    }
    return out;
  }, [session?.assets]);
  const previewGalleryAssets = useMemo(() => {
    const raw = Array.isArray(publicPage?.gallery_assets)
      ? publicPage.gallery_assets
      : Array.isArray(publicProfile?.gallery_assets)
        ? publicProfile.gallery_assets
        : [];
    return orderPublicGalleryAssets(dedupeAssetsBySlot(raw.map(normalizeAssetLike).filter(Boolean) as HostOnboardingAsset[]));
  }, [publicPage?.gallery_assets, publicProfile?.gallery_assets]);
  const publicGalleryAssetsForEditor = useMemo(() => {
    const fromSession = PUBLIC_GALLERY_SLOTS
      .map((slot) => sessionAssetMap[slot.key])
      .filter(Boolean) as HostOnboardingAsset[];
    const fallback = previewGalleryAssets.filter((asset) => !sessionAssetMap[String(asset.slot_key || "")]);
    return orderPublicGalleryAssets(dedupeAssetsBySlot([...fromSession, ...fallback]));
  }, [previewGalleryAssets, sessionAssetMap]);
  const publicGalleryMissingSlots = useMemo(
    () => PUBLIC_GALLERY_SLOTS.filter((slot) => !sessionAssetMap[slot.key]),
    [sessionAssetMap],
  );

  const voiceCaptureAsset = useMemo(() => sessionAssetMap[VOICE_CAPTURE_SLOT] || null, [sessionAssetMap]);
  const voiceCaptureGuidance = previewData?.voice_capture_guidance || {};
  const voiceCaptureScript = useMemo(() => {
    const guided = String((voiceCaptureGuidance as any)?.script || "").trim();
    if (guided) return guided;
    return buildVoiceCaptureScriptFromProfile({
      basics: basicsForm,
      review: reviewForm,
      completion: completionForm,
      publicProfile,
      privateProfile,
    });
  }, [voiceCaptureGuidance, basicsForm, reviewForm, completionForm, publicProfile, privateProfile]);
  const voiceCaptureScriptWordCount = useMemo(() => countWords(voiceCaptureScript), [voiceCaptureScript]);
  const voiceCaptureScriptEstimatedSeconds = useMemo(() => {
    const hinted = Number((voiceCaptureGuidance as any)?.estimated_seconds || 0);
    return hinted > 0 ? hinted : estimateSpeechSecondsFromText(voiceCaptureScript);
  }, [voiceCaptureGuidance, voiceCaptureScript]);
  const voiceCaptureMinSeconds = Number((voiceCaptureGuidance as any)?.minimum_seconds || readiness.voice_capture_min_seconds || VOICE_CAPTURE_MIN_SECONDS) || VOICE_CAPTURE_MIN_SECONDS;
  const voiceCaptureTargetSeconds = Number((voiceCaptureGuidance as any)?.target_seconds || VOICE_CAPTURE_TARGET_SECONDS) || VOICE_CAPTURE_TARGET_SECONDS;
  const voiceCaptureMeetsMinimum = Number(voiceCaptureAsset?.duration_seconds || 0) >= voiceCaptureMinSeconds && String(voiceCaptureAsset?.validation_status || "").toLowerCase() === "accepted";


  const embedded = typeof window !== "undefined" ? (() => {
    try { return window.self !== window.top; } catch { return true; }
  })() : false;


  const markLocalProfileDirty = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const tagName = String(target?.tagName || "").toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") {
      setLocalProfileDirty(true);
    }
  }, []);

  const fullProfileApprovalIsCurrent = useMemo(() => {
    const approvedVersionId = String(session?.approved_version_id || "").trim();
    if (!approvedVersionId || localProfileDirty) return false;
    const workflowState = String(session?.workflow_state || "").trim().toLowerCase();
    const publishStatus = String(session?.publish_status || "").trim().toLowerCase();
    const hasPendingEdits = workflowState.includes("pending") || publishStatus.includes("pending");
    return Boolean(readiness.full_publish_ready) && !hasPendingEdits;
  }, [localProfileDirty, readiness.full_publish_ready, session?.approved_version_id, session?.publish_status, session?.workflow_state]);

  const fullProfileApprovalButtonLabel = fullProfileApprovalIsCurrent
    ? "✓ Profile approved"
    : saving
      ? "Saving…"
      : "Approve full profile";

  const handleApproveLimitedClick = useCallback(() => {
    if (saving) return;
    if (!Boolean(readiness.limited_publish_allowed)) {
      const missing = limitedPublishMissingSections.length
        ? limitedPublishMissingSections
        : ["Basics", "required photos", "derived review", `Voice capture (minimum ${voiceCaptureMinSeconds} seconds)`];
      const voiceDetails = voiceCaptureBlockers.length ? ` ${voiceCaptureBlockers.join(" ")}` : "";
      setNotice("");
      setError(`Approve Limited Profile requires: ${missing.join(", ")}.${voiceDetails}`);
      if (!voiceCaptureMeetsMinimum || missing.some((item) => String(item || "").toLowerCase().includes("voice"))) {
        setStep("completion");
      } else if (missing.some((item) => String(item || "").toLowerCase().includes("photo"))) {
        setStep("photos");
      } else if (missing.some((item) => String(item || "").toLowerCase().includes("review"))) {
        setStep("review");
      } else {
        setStep("basics");
      }
      return;
    }
    void approveProfile("limited");
  }, [approveProfile, limitedPublishMissingSections, readiness.limited_publish_allowed, saving, voiceCaptureBlockers, voiceCaptureMeetsMinimum, voiceCaptureMinSeconds]);

  const handleApproveFullClick = useCallback(() => {
    if (saving || fullProfileApprovalIsCurrent) return;
    if (!Boolean(readiness.full_publish_ready)) {
      const missing = dedupeLabels([...limitedPublishMissingSections, ...fullPublishMissingSections]);
      const voiceDetails = voiceCaptureBlockers.length ? ` ${voiceCaptureBlockers.join(" ")}` : "";
      setNotice("");
      setError(
        missing.length
          ? `Approve Full Profile requires these requirements to be completed and not skipped: ${missing.join(", ")}.${voiceDetails}`
          : "Approve Full Profile requires all profile requirements, including a validated voice capture, to be completed and not skipped.",
      );
      setStep("completion");
      return;
    }
    void approveProfile("full");
  }, [approveProfile, fullProfileApprovalIsCurrent, fullPublishMissingSections, limitedPublishMissingSections, readiness.full_publish_ready, saving, voiceCaptureBlockers]);

  if (waitingForContext && embedded && !context.memberId) {
    return (
      <main style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={cardStyle}>
          <h1 style={{ marginTop: 0 }}>Host Profile Studio</h1>
          <p style={{ color: "#444", lineHeight: 1.6 }}>
            Waiting for host context from the Elaralo master site…
          </p>
        </div>
      </main>
    );
  }

  if (!context.loggedIn || !context.memberId) {
    return (
      <main style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={cardStyle}>
          <h1 style={{ marginTop: 0 }}>Host Profile Studio</h1>
          <p style={{ color: "#444", lineHeight: 1.6 }}>
            Host Onboarding requires a logged-in host member session. Open this page from the Elaralo member area after sign-in.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{ maxWidth: 1120, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui", color: "#111827" }}
      onInputCapture={markLocalProfileDirty}
      onChangeCapture={markLocalProfileDirty}
    >
      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ ...cardStyle, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#6b7280" }}>
                Host Onboarding / Host Profile Studio
              </div>
              <h1 style={{ margin: "4px 0 0 0", fontSize: 30 }}>Build your Host Human Companion Profile</h1>
              <div style={{ marginTop: 6, color: "#4b5563", fontSize: 14 }}>
                {context.brand} • {context.avatar} • English-only intake for this iteration
              </div>
            </div>
            <div style={{ textAlign: "right", minWidth: 220 }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Host session</div>
              <div style={{ fontWeight: 700 }}>{context.hostDisplayName || context.memberId}</div>
              <div style={{ marginTop: 4, fontSize: 13, color: "#6b7280" }}>
                Publish: {String(session?.publish_status || "draft")}
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
            {stepItems.map((item, idx) => {
              const active = idx === currentStepIndex;
              const done = idx < currentStepIndex;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setStep(item.key)}
                  style={{
                    borderRadius: 14,
                    border: active ? "1px solid #111827" : "1px solid rgba(0,0,0,0.12)",
                    background: active ? "#111827" : done ? "rgba(17,24,39,0.06)" : "#fff",
                    color: active ? "#fff" : "#111827",
                    padding: "10px 12px",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {idx + 1}. {item.label}
                </button>
              );
            })}
          </div>
          {error ? <div style={{ color: "#b91c1c", fontWeight: 600 }}>{error}</div> : null}
          {notice ? <div style={{ color: "#065f46", fontWeight: 600 }}>{notice}</div> : null}
        </div>

        {loading ? (
          <div style={cardStyle}>Loading Host Onboarding…</div>
        ) : step === "welcome" ? (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Welcome and requirements</h2>
            <p style={{ margin: 0, lineHeight: 1.6, color: "#374151" }}>
              This staged workflow starts with the minimum structured information needed to derive an initial Host Human Companion Profile, then lets you review, correct, and complete the remaining sections before publishing an approved version.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              <div style={cardStyle}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>You will provide</div>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: "#4b5563" }}>
                  <li>Legal name (private only)</li>
                  <li>Stage/public name (public by default)</li>
                  <li>Gender, birthdate, birth city, birth state/region, birth country</li>
                  <li>Prescriptive race and ethnicity values in English</li>
                  <li>At least 5 reference photos</li>
                </ul>
              </div>
              <div style={cardStyle}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>The system will derive</div>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: "#4b5563" }}>
                  <li>Age</li>
                  <li>Astrological sign</li>
                  <li>Nationality suggestion from birth country</li>
                  <li>Draft quick reference summary</li>
                  <li>Draft astrological, family heritage, and personality sections</li>
                </ul>
              </div>
              <div style={cardStyle}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Important rules</div>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: "#4b5563" }}>
                  <li>Legal name remains private.</li>
                  <li>Stage/public name is used everywhere public by default.</li>
                  <li>Race, ethnicity, and nationality are never inferred from photos.</li>
                  <li>3D character photo usage only applies if you opt in at the photo step.</li>
                </ul>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setStep("basics")}>Start basics</button>
            </div>
          </div>
        ) : step === "basics" ? (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Minimal intake</h2>
            <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
              Enter the minimum structured information required to derive your initial profile. All entries must be in English for this version.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
              {renderLabeledInput("Legal name (private only)", basicsForm.legal_name, (v) => setBasicsForm((p) => ({ ...p, legal_name: v })), "Example: Alicia Johnson")}
              {renderLabeledInput("Stage/public name", basicsForm.stage_name, (v) => setBasicsForm((p) => ({ ...p, stage_name: v, public_display_name: p.public_display_name || v })), "Example: Dulce Moon")}
              {renderLabeledInput("Public display name", basicsForm.public_display_name, (v) => setBasicsForm((p) => ({ ...p, public_display_name: v })), "Defaults to the stage/public name")}
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Gender (hybrid)</span>
                <select value={String(basicsForm.gender_pick || "Female")} onChange={(e) => setBasicsForm((p) => ({ ...p, gender_pick: e.target.value }))} style={inputStyle}>
                  {GENDER_OPTIONS.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
                </select>
                {String(basicsForm.gender_pick || "") === "Prefer to self-describe" ? (
                  <input value={String(basicsForm.gender_custom || "")} onChange={(e) => setBasicsForm((p) => ({ ...p, gender_custom: e.target.value }))} placeholder="Enter your preferred English description" style={inputStyle} />
                ) : null}
              </label>
              {renderLabeledInput("Birthdate", basicsForm.birthdate, (v) => setBasicsForm((p) => ({ ...p, birthdate: v })), "YYYY-MM-DD")}
              {renderLabeledInput("Birth city", basicsForm.birth_city, (v) => setBasicsForm((p) => ({ ...p, birth_city: v })), "Example: London")}
              {renderLabeledInput("Birth state / region", basicsForm.birth_state_region, (v) => setBasicsForm((p) => ({ ...p, birth_state_region: v })), "Example: England or South Carolina")}
              {renderLabeledInput("Birth country", basicsForm.birth_country, (v) => setBasicsForm((p) => ({ ...p, birth_country: v })), "Example: United Kingdom")}
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Race (prescriptive for consistency)</span>
                <select value={String(basicsForm.race_primary || "")} onChange={(e) => setBasicsForm((p) => ({ ...p, race_primary: e.target.value }))} style={inputStyle}>
                  <option value="">Select race</option>
                  {RACE_OPTIONS.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
                </select>
                <div style={{ fontSize: 12, color: "#6b7280" }}>Example: Black or African descent</div>
              </label>
              {renderLabeledInput("Race detail (optional)", basicsForm.race_detail, (v) => setBasicsForm((p) => ({ ...p, race_detail: v })), "Example: Black / African American")}
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Ethnicity bucket (prescriptive for consistency)</span>
                <select value={String(basicsForm.ethnicity_bucket || "")} onChange={(e) => setBasicsForm((p) => ({ ...p, ethnicity_bucket: e.target.value }))} style={inputStyle}>
                  <option value="">Select ethnicity bucket</option>
                  {ETHNICITY_BUCKETS.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
                </select>
                <div style={{ fontSize: 12, color: "#6b7280" }}>Example: Caribbean</div>
              </label>
              {renderLabeledInput("Ethnicity detail", basicsForm.ethnicity_detail, (v) => setBasicsForm((p) => ({ ...p, ethnicity_detail: v })), "Example: Afro-Caribbean")}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("welcome")}>Back</button>
              <button type="button" style={buttonStyle} onClick={() => void saveBasics()} disabled={saving}>{saving ? "Saving…" : "Save basics and continue"}</button>
            </div>
          </div>
        ) : step === "photos" ? (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Required photo upload</h2>
            <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
              Upload at least five photos in English-labeled slots. One person only, no heavy filters, plain or low-distraction background preferred, and face unobstructed.
            </div>
            <label style={{ display: "inline-flex", gap: 10, alignItems: "flex-start", padding: 12, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 14, background: "rgba(17,24,39,0.03)", cursor: "pointer", position: "relative", zIndex: 2, pointerEvents: "auto", touchAction: "manipulation" }}>
              <input type="checkbox" checked={threeDOptIn} onChange={(e) => void savePhotosConfig(e.target.checked)} style={checkboxStyle} />
              <span style={{ lineHeight: 1.6 }}>
                Host confirms these photos may be used later for 3D character generation only if host opts in to this service.
              </span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {[...REQUIRED_SLOTS, ...OPTIONAL_SLOTS].map((slot) => {
                const asset = assetsBySlot[slot.key];
                const errors = Array.isArray(asset?.validation_errors) ? asset?.validation_errors : [];
                return (
                  <div key={slot.key} style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 16, padding: 14, display: "grid", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>{slot.label}</div>
                        <div style={{ fontSize: 12, color: slot.required ? "#991b1b" : "#6b7280" }}>{slot.required ? "Required" : "Optional"}</div>
                      </div>
                      <button type="button" style={secondaryButtonStyle} onClick={() => openSlotPicker(slot.key)} disabled={uploadingSlot === slot.key}>
                        {uploadingSlot === slot.key ? "Uploading…" : asset?.url ? "Replace" : "Upload"}
                      </button>
                    </div>
                    <input
                      ref={(node) => { uploadInputRefs.current[slot.key] = node; }}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp,image/heic,image/heif"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files && e.target.files.length ? e.target.files[0] : null;
                        try { e.target.value = ""; } catch {}
                        void handleUploadForSlot(slot.key, file);
                      }}
                    />
                    {asset?.url ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        <img src={String(asset.url)} alt={slot.label} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)" }} />
                        <div style={{ fontSize: 12, color: "#4b5563" }}>
                          {asset.file_name || "Uploaded"}
                          {asset.width_px && asset.height_px ? ` • ${asset.width_px}x${asset.height_px}` : ""}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: asset.validation_status === "accepted" ? "#065f46" : "#92400e" }}>
                          {asset.validation_status === "accepted" ? "Accepted" : "Needs review"}
                        </div>
                        {errors.length ? <div style={{ fontSize: 12, color: "#92400e" }}>{errors.join(" ")}</div> : null}
                      </div>
                    ) : (
                      <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                        {slot.required ? "Required slot." : "Optional slot."}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {requiredPhotoMissing.length ? (
              <div style={{ color: "#92400e", fontWeight: 600 }}>
                Missing required photo slots: {requiredPhotoMissing.join(", ")}
              </div>
            ) : (
              <div style={{ color: "#065f46", fontWeight: 600 }}>All required photo slots are present.</div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("basics")}>Back</button>
              <button type="button" style={buttonStyle} onClick={() => void runDerivation()} disabled={saving || requiredPhotoMissing.length > 0}>
                {saving ? "Generating…" : "Generate derived draft"}
              </button>
            </div>
          </div>
        ) : step === "review" ? (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Derived review and correction</h2>
            <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
              Review everything tagged as derived or AI-drafted. Nationality starts as a suggestion from birth country and can be edited into a multi-nationality list.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              {renderLabeledInput("Age", reviewForm.age_years, (v) => setReviewForm((p) => ({ ...p, age_years: v })), "Derived age")}
              {renderLabeledInput("Astrological sign", reviewForm.zodiac_sign, (v) => setReviewForm((p) => ({ ...p, zodiac_sign: v })), "Derived sign")}
              {renderLabeledInput("Nationalities (comma-separated)", reviewForm.nationalities_text, (v) => setReviewForm((p) => ({ ...p, nationalities_text: v })), "Example: American, Jamaican")}
              {renderLabeledInput("Quick reference public name", reviewForm.quick_reference_public_name, (v) => setReviewForm((p) => ({ ...p, quick_reference_public_name: v })), "Derived from stage/public name")}
              {renderLabeledInput("Quick reference age", reviewForm.quick_reference_age, (v) => setReviewForm((p) => ({ ...p, quick_reference_age: v })), "Derived age")}
              {renderLabeledInput("Quick reference zodiac", reviewForm.quick_reference_zodiac, (v) => setReviewForm((p) => ({ ...p, quick_reference_zodiac: v })), "Derived sign")}
              {renderLabeledInput("Quick reference birth location", reviewForm.quick_reference_birth_location, (v) => setReviewForm((p) => ({ ...p, quick_reference_birth_location: v })), "Derived birth location")}
              {renderLabeledInput("Quick reference race", reviewForm.quick_reference_race, (v) => setReviewForm((p) => ({ ...p, quick_reference_race: v })), "Derived race summary")}
              {renderLabeledInput("Quick reference ethnicity", reviewForm.quick_reference_ethnicity, (v) => setReviewForm((p) => ({ ...p, quick_reference_ethnicity: v })), "Derived ethnicity summary")}
            </div>
            {renderTextareaField("Astrological profile narrative", reviewForm.astrological_narrative, (v) => setReviewForm((p) => ({ ...p, astrological_narrative: v })), "Review and edit the astrological narrative draft")}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              {renderLabeledInput("Astrological strengths (comma-separated)", reviewForm.astrological_strengths_text, (v) => setReviewForm((p) => ({ ...p, astrological_strengths_text: v })), "Example: Analytical, Strategic, Organized")}
              {renderLabeledInput("Astrological challenges (comma-separated)", reviewForm.astrological_challenges_text, (v) => setReviewForm((p) => ({ ...p, astrological_challenges_text: v })), "Example: Perfectionistic, Self-critical")}
            </div>
            {renderTextareaField("Family heritage draft", reviewForm.family_heritage_draft, (v) => setReviewForm((p) => ({ ...p, family_heritage_draft: v })), "Review and edit the family heritage draft")}
            {renderTextareaField("Personality draft", reviewForm.personality_draft, (v) => setReviewForm((p) => ({ ...p, personality_draft: v })), "Review and edit the personality draft")}
            {reviewPhysicalDescriptionAccepted ? (
              renderTextareaField(
                "Physical description draft",
                reviewForm.physical_description_draft,
                (v) => setReviewForm((p) => ({ ...p, physical_description_draft: v })),
                "Review and edit the physical description draft",
              )
            ) : (
              <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                Physical description is not being shown at the Review step because there is no meaningful system draft to inspect. You can complete it in the Complete step instead.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("photos")}>Back</button>
              <button type="button" style={buttonStyle} onClick={() => void saveReview()} disabled={saving}>{saving ? "Saving…" : "Accept derived review and continue"}</button>
            </div>
          </div>
        ) : step === "completion" ? (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Progressive completion</h2>
            <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
              Complete the remaining profile sections or intentionally skip them for a limited publish. Estimated income is private and will be derived from the current job title if left blank.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
              <div style={{ display: "grid", gap: 12, gridColumn: "1 / -1" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Education</div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    Add one entry per degree, certification, or program. Use multiple entries if applicable.
                  </div>
                </div>
                <button type="button" style={secondaryButtonStyle} onClick={addEducationEntry}>Add education</button>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {completionEducationEntries.map((entry, idx) => (
                  <div key={entry.id || idx} style={{ ...cardStyle, padding: 14, display: "grid", gap: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700 }}>Education {idx + 1}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" style={secondaryButtonStyle} onClick={() => moveEducationEntry(String(entry.id), -1)} disabled={idx === 0}>↑</button>
                        <button type="button" style={secondaryButtonStyle} onClick={() => moveEducationEntry(String(entry.id), 1)} disabled={idx === completionEducationEntries.length - 1}>↓</button>
                        <button type="button" style={secondaryButtonStyle} onClick={() => removeEducationEntry(String(entry.id))}>Remove</button>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                      {renderLabeledInput("Degree", entry.degree, (v) => updateEducationEntry(String(entry.id), "degree", v), "Example: Master of Business Administration")}
                      {renderLabeledInput("Field of study", entry.field_of_study, (v) => updateEducationEntry(String(entry.id), "field_of_study", v), "Example: Luxury Brand Management")}
                      {renderLabeledInput("Institution", entry.institution, (v) => updateEducationEntry(String(entry.id), "institution", v), "Example: Northwestern University")}
                      {renderLabeledInput("Graduation year", entry.graduation_year, (v) => updateEducationEntry(String(entry.id), "graduation_year", v), "Example: 2022")}
                    </div>
                    {renderTextareaField("Education notes", entry.notes, (v) => updateEducationEntry(String(entry.id), "notes", v), "Optional notes, honors, academic focus, or supporting detail")}
                  </div>
                ))}
              </div>
            </div>
              {renderLabeledInput("Current job title", completionForm.current_job_title, (v) => setCompletionForm((p) => ({ ...p, current_job_title: v })), "Example: Vice President of Brand Strategy")}
              {renderLabeledInput("Current company", completionForm.current_company, (v) => setCompletionForm((p) => ({ ...p, current_company: v })), "Example: Aurelia International Luxury Group")}
              {renderLabeledInput("Estimated income (private)", completionForm.estimated_income, (v) => setCompletionForm((p) => ({ ...p, estimated_income: v })), "Auto-derived from job title if left blank")}
            </div>
            {renderTextareaField("Career summary", completionForm.career_summary, (v) => setCompletionForm((p) => ({ ...p, career_summary: v })), "Describe the current position, responsibilities, and achievements", "career_summary")}
            {renderTextareaField("Likes", completionForm.likes, (v) => setCompletionForm((p) => ({ ...p, likes: v })), "Example: international travel, fine dining, leadership development", "likes")}
            {renderTextareaField("Dislikes", completionForm.dislikes, (v) => setCompletionForm((p) => ({ ...p, dislikes: v })), "Example: dishonesty, poor communication, missed deadlines", "dislikes")}
            {renderTextareaField("Hobbies", completionForm.hobbies, (v) => setCompletionForm((p) => ({ ...p, hobbies: v })), "Example: pilates, photography, traveling", "hobbies")}
            {renderTextareaField("Lifestyle", completionForm.lifestyle, (v) => setCompletionForm((p) => ({ ...p, lifestyle: v })), "Describe the host's daily rhythm, habits, and priorities", "lifestyle")}
            {renderTextareaField("Background story", completionForm.background_story, (v) => setCompletionForm((p) => ({ ...p, background_story: v })), "Tell the origin story in English", "background_story")}
            {renderTextareaField("Core values", completionForm.core_values, (v) => setCompletionForm((p) => ({ ...p, core_values: v })), "Example: excellence, integrity, discipline", "core_values")}
            {renderTextareaField("Personal motto", completionForm.personal_motto, (v) => setCompletionForm((p) => ({ ...p, personal_motto: v })), "Example: Lead with elegance and intention.", "personal_motto")}
            {shouldShowCompletionPhysicalDescription ? (
              renderTextareaField(
                "Physical description",
                completionForm.physical_description,
                (v) => setCompletionForm((p) => ({ ...p, physical_description: v })),
                "Describe the host's visual presentation in a respectful, factual way",
                "physical_description",
              )
            ) : (
              <div style={{ display: "grid", gap: 8, padding: 14, border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, background: "rgba(17,24,39,0.03)" }}>
                <div style={{ fontWeight: 700 }}>Physical description</div>
                <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
                  Physical description was already reviewed earlier, so it is collapsed here. Expand it only if you want to replace that reviewed text during completion.
                </div>
                <div>
                  <button type="button" style={secondaryButtonStyle} onClick={() => setShowCompletionPhysicalDescriptionEditor(true)}>
                    Edit physical description here
                  </button>
                </div>
              </div>
            )}
            {renderLabeledInput(
              "Phonetic spelling of first name (optional)",
              completionForm.phonetic_pronunciation,
              (v) => setCompletionForm((p) => ({ ...p, phonetic_pronunciation: v })),
              "Example: ser-ah",
              <span style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                Optional. Use this only when the host's first name should be pronounced differently from its spelling. If left blank, Elaralo will not derive a phonetic value from the first name.
              </span>,
            )}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: 14, border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, background: "rgba(17,24,39,0.03)" }}>
              <input
                type="checkbox"
                checked={Boolean(completionForm.list_in_companion_catalog)}
                disabled={catalogVisibilitySaving}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => handleCatalogVisibilityChange(e.currentTarget.checked)}
                style={{ ...checkboxStyle, marginTop: 3 }}
                aria-label="List my Host profile in the Companion catalog"
              />
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ fontWeight: 800 }}>List my Host profile in the Companion catalog</span>
                <span style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
                  Optional and off by default. When unchecked, your Human Companion remains available to you for management/testing, but ordinary members and visitors will not see it on the Companion page.
                </span>
                {catalogVisibilitySaving ? <span style={{ fontSize: 12, color: "#6b7280" }}>Saving catalog visibility…</span> : null}
              </span>
            </div>
            <div style={{ ...cardStyle, padding: 16, display: "grid", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Voice capture (minimum 30 seconds)</div>
                  <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
                    Record or upload a voice sample that is at least {voiceCaptureMinSeconds} seconds long. The guided script below is written to run about {voiceCaptureTargetSeconds} seconds at a natural pace. This clip is required for limited and full profile approval and is exported with the approved Elaralo companion assets.
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  {recordingVoice ? `Recording… ${formatDurationSeconds(voiceRecordingElapsed) || "0.0s"}` : voiceCaptureAsset?.duration_seconds ? `Current capture: ${formatDurationSeconds(voiceCaptureAsset.duration_seconds)}` : "No voice capture uploaded yet"}
                </div>
              </div>
              <div style={{ display: "grid", gap: 10, padding: 14, border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, background: "rgba(17,24,39,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Guided 60-second voice script</div>
                    <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
                      This script is built from the host information already approved or currently saved in the session.
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    ~{voiceCaptureScriptEstimatedSeconds}s • {voiceCaptureScriptWordCount} words
                  </div>
                </div>
                <textarea
                  readOnly
                  value={voiceCaptureScript}
                  style={{ ...textareaStyle, minHeight: 180, background: "#fff" }}
                  onClick={(e) => e.currentTarget.focus()}
                />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={secondaryButtonStyle}
                    onClick={async () => {
                      try {
                        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                          await navigator.clipboard.writeText(voiceCaptureScript);
                          setNotice("Voice script copied.");
                          setError("");
                        }
                      } catch (err: any) {
                        setError(String(err?.message || "Unable to copy the voice script."));
                      }
                    }}
                  >
                    Copy script
                  </button>
                  <button type="button" style={secondaryButtonStyle} onClick={() => void loadPreview()} disabled={saving}>
                    {saving ? "Refreshing…" : "Refresh script from approved info"}
                  </button>
                </div>
              </div>
              {voiceCaptureAsset?.url ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <audio controls src={voiceCaptureAsset.url} style={{ width: "100%" }} />
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: "#4b5563" }}>
                    <span><b>File:</b> {String(voiceCaptureAsset.file_name || "voice-capture")}</span>
                    {voiceCaptureAsset.duration_seconds ? <span><b>Duration:</b> {formatDurationSeconds(voiceCaptureAsset.duration_seconds)}</span> : null}
                    {voiceCaptureAsset.validation_status ? <span><b>Status:</b> {voiceCaptureAsset.validation_status}</span> : null}
                    {voiceCaptureMeetsMinimum ? <span style={{ color: "#065f46", fontWeight: 700 }}>Meets publish minimum</span> : null}
                  </div>
                  {Array.isArray(voiceCaptureAsset.validation_errors) && voiceCaptureAsset.validation_errors.length ? (
                    <div style={{ color: "#b91c1c", fontSize: 13 }}>
                      {voiceCaptureAsset.validation_errors.join(" ")}
                    </div>
                  ) : null}
                  {!voiceCaptureMeetsMinimum ? (
                    <div style={{ color: "#92400e", fontSize: 13, lineHeight: 1.6 }}>
                      Limited and full profile approval require one accepted voice capture that is at least {voiceCaptureMinSeconds} seconds long.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                  Upload or record one accepted voice clip that is at least {voiceCaptureMinSeconds} seconds long before approving either a limited or full profile.
                </div>
              )}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={() => void startVoiceCapture()} disabled={recordingVoice || uploadingSlot === VOICE_CAPTURE_SLOT}>
                  {recordingVoice ? "Recording…" : "Start guided recording"}
                </button>
                <button type="button" style={secondaryButtonStyle} onClick={() => stopVoiceCapture()} disabled={!recordingVoice}>
                  Stop recording
                </button>
                <button type="button" style={secondaryButtonStyle} onClick={() => { try { voiceUploadInputRef.current?.click(); } catch {} }} disabled={uploadingSlot === VOICE_CAPTURE_SLOT}>
                  {uploadingSlot === VOICE_CAPTURE_SLOT ? "Uploading…" : "Upload recorded file"}
                </button>
                <input
                  ref={voiceUploadInputRef}
                  type="file"
                  accept={VOICE_CAPTURE_ACCEPT}
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] || null;
                    if (file) void handleUploadVoiceCapture(file, file.name);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
                Recording continues until you stop it or until the 2-minute safety stop is reached. Aim to read the full script naturally; 30 seconds is the minimum accepted duration.
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("review")}>Back</button>
              <button type="button" style={buttonStyle} onClick={() => void saveCompletion()} disabled={saving}>{saving ? "Saving…" : "Save completion and continue"}</button>
            </div>
          </div>
        ) : (
          <div style={{ ...cardStyle, display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0 }}>Final preview and approval</h2>
            <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
              Review the compiled profile. Legal/private information is separated from the public/persona profile, and you can jump back to update any section before approval.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => void loadPreview()} disabled={saving}>{saving ? "Refreshing…" : "Refresh preview"}</button>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("basics")}>Edit basics</button>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("photos")}>Edit photos</button>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("review")}>Edit derived review</button>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("completion")}>Edit completion</button>
              <button
                type="button"
                style={fullProfileApprovalIsCurrent ? { ...secondaryButtonStyle, cursor: "default", opacity: 0.8 } : buttonStyle}
                onClick={handleApproveFullClick}
                disabled={saving || fullProfileApprovalIsCurrent}
                title={fullProfileApprovalIsCurrent ? "The current full profile is already approved. Edit any field to re-enable approval." : "Approve the full profile from the preview section."}
              >
                {fullProfileApprovalButtonLabel}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
              <div style={cardStyle}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Private profile</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "#374151" }}>
{JSON.stringify(privateProfile, null, 2)}
                </pre>
              </div>
              <div style={cardStyle}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Public profile</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "#374151" }}>
{JSON.stringify(publicProfile, null, 2)}
                </pre>
              </div>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ color: Boolean(readiness.limited_publish_allowed) ? "#065f46" : "#92400e", fontWeight: 700 }}>
                Limited publish: {Boolean(readiness.limited_publish_allowed) ? "Ready" : "Not ready"}
              </div>
              {!Boolean(readiness.limited_publish_allowed) && limitedPublishMissingSections.length ? (
                <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.6 }}>
                  Remaining requirements for limited publish: {limitedPublishMissingSections.join(", ")}.
                  {voiceCaptureBlockers.length ? ` ${voiceCaptureBlockers.join(" ")}` : ""}
                </div>
              ) : null}
              <div style={{ color: Boolean(readiness.full_publish_ready) ? "#065f46" : "#92400e", fontWeight: 700 }}>
                Full publish: {Boolean(readiness.full_publish_ready) ? "Ready" : "Complete all later sections without skipping any of them"}
              </div>
              {!Boolean(readiness.full_publish_ready) && fullPublishMissingSections.length ? (
                <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.6 }}>
                  Remaining sections for full publish: {fullPublishMissingSections.join(", ")}.
                </div>
              ) : null}
            </div>
            <div style={{ ...cardStyle, padding: 16, display: "grid", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Public Page</div>
                  <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
                    The public page uses the approved public profile and a gallery made from every uploaded picture except the primary headshot. Replace or update any gallery image here, then approve again to publish the refreshed version.
                  </div>
                </div>
                {publicSummaryHref ? (
                  <a href={publicSummaryHref} target="_blank" rel="noreferrer" style={{ ...secondaryButtonStyle, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                    Open summary public page
                  </a>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                  Public gallery images currently selected: {publicGalleryAssetsForEditor.length}. The headshot remains the primary public portrait and is not included in this gallery.
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                  Uploaded changes are saved to the current onboarding session immediately. Re-approve the profile when you are ready for the Summary Public Page to reflect the latest gallery.
                </div>
              </div>
              {publicGalleryAssetsForEditor.length ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                  {publicGalleryAssetsForEditor.map((asset) => {
                    const slotKey = String(asset.slot_key || "").trim();
                    return (
                      <div key={slotKey || String(asset.asset_id || "")} style={{ display: "grid", gap: 10, padding: 12, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 14, background: "#fff" }}>
                        {asset.url ? (
                          <img src={asset.url} alt={String(asset.file_name || slotLabel(slotKey))} style={{ width: "100%", aspectRatio: "4 / 5", objectFit: "cover", borderRadius: 14, border: "1px solid rgba(0,0,0,0.08)" }} />
                        ) : (
                          <div style={{ width: "100%", aspectRatio: "4 / 5", borderRadius: 14, border: "1px dashed rgba(0,0,0,0.18)", display: "grid", placeItems: "center", color: "#6b7280", background: "rgba(17,24,39,0.02)" }}>
                            {slotLabel(slotKey)} pending
                          </div>
                        )}
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 700 }}>{String(asset.slot_label || slotLabel(slotKey))}</div>
                          {asset.file_name ? <div style={{ fontSize: 13, color: "#4b5563" }}>{asset.file_name}</div> : null}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" style={secondaryButtonStyle} onClick={() => openSlotPicker(slotKey)} disabled={uploadingSlot === slotKey || saving}>
                            {uploadingSlot === slotKey ? "Uploading…" : "Replace / update photo"}
                          </button>
                          <input
                            ref={(node) => { uploadInputRefs.current[slotKey] = node; }}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={(e) => {
                              const file = e.currentTarget.files && e.currentTarget.files[0] ? e.currentTarget.files[0] : null;
                              void handleReplacePublicGalleryAsset(slotKey, file);
                              e.currentTarget.value = "";
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                  No public gallery photos are available yet. Upload non-headshot photo slots to build the public gallery section.
                </div>
              )}
              {publicGalleryMissingSlots.length ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ fontWeight: 700 }}>Add more gallery photos</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {publicGalleryMissingSlots.map((slot) => (
                      <React.Fragment key={slot.key}>
                        <button type="button" style={secondaryButtonStyle} onClick={() => openSlotPicker(slot.key)} disabled={uploadingSlot === slot.key || saving}>
                          {uploadingSlot === slot.key ? `Uploading ${slot.label}…` : `Add ${slot.label}`}
                        </button>
                        <input
                          ref={(node) => { uploadInputRefs.current[slot.key] = node; }}
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const file = e.currentTarget.files && e.currentTarget.files[0] ? e.currentTarget.files[0] : null;
                            void handleReplacePublicGalleryAsset(slot.key, file);
                            e.currentTarget.value = "";
                          }}
                        />
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ) : null}
              {session?.approved_version_id ? (
                <div style={{ color: "#065f46", fontWeight: 700 }}>
                  Active approved version: {session.approved_version_id}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setStep("completion")}>Back</button>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" style={secondaryButtonStyle} onClick={handleApproveLimitedClick} disabled={saving}>
                  {saving ? "Saving…" : "Approve limited profile"}
                </button>
                <button
                  type="button"
                  style={fullProfileApprovalIsCurrent ? { ...secondaryButtonStyle, cursor: "default", opacity: 0.8 } : buttonStyle}
                  onClick={handleApproveFullClick}
                  disabled={saving || fullProfileApprovalIsCurrent}
                  title={fullProfileApprovalIsCurrent ? "The current full profile is already approved. Edit any field to re-enable approval." : "Approve the full profile."}
                >
                  {fullProfileApprovalButtonLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
