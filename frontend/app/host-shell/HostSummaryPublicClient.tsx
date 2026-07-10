"use client";

import React, { useEffect, useMemo, useState } from "react";

type PublicAsset = {
  asset_id?: string;
  slot_key?: string;
  file_name?: string;
  url?: string;
  content_type?: string;
  width_px?: number;
  height_px?: number;
  validation_status?: string;
};

type PublicEducationEntry = {
  entry_id?: string;
  degree?: string;
  field_of_study?: string;
  institution?: string;
  graduation_year?: string;
  focus?: string;
  notes?: string;
};

type PublicVersionPayload = {
  ok?: boolean;
  version?: {
    version_id?: string;
    session_id?: string;
    member_id?: string;
    version_no?: number;
    publish_scope?: string;
    approved_epoch?: number;
  } | null;
  public_profile?: Record<string, any>;
  public_page?: Record<string, any>;
  detail?: string;
  message?: string;
};

const DEFAULT_AVATAR = "/elaralo-logo.png";
const HEADSHOT_DIR = "/companion/headshot";
const REBRANDING_PUBLIC_DIR = "/rebranding";
const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");

function safeText(value: any): string {
  return String(value ?? "").trim();
}

function queryParam(name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return safeText(new URLSearchParams(window.location.search || "").get(name));
  } catch {
    return "";
  }
}

function firstQueryParam(names: string[]): string {
  for (const name of names) {
    const value = queryParam(name);
    if (value) return value;
  }
  return "";
}

function booleanFromLooseString(value: any): boolean | null {
  const v = safeText(value).toLowerCase();
  if (!v) return null;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

function buildSummaryCompanionListReturnUrl(brand: string, memberId?: string, displayName?: string): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL("/my-elaralo", window.location.origin);
    url.searchParams.set("brand", safeText(brand) || "Elaralo");
    url.searchParams.set("forceSelector", "1");
    url.searchParams.set("showCompanionList", "1");
    url.searchParams.set("returningFromConnect", "1");
    const mid = safeText(memberId);
    if (mid) {
      url.searchParams.set("memberId", mid);
      url.searchParams.set("member_id", mid);
    }
    const name = safeText(displayName);
    if (name) {
      url.searchParams.set("displayName", name);
      url.searchParams.set("userName", name);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function listFromLooseValue(value: any): string[] {
  if (Array.isArray(value)) return value.map((x) => safeText(x)).filter(Boolean);
  const text = safeText(value);
  return text
    ? text
        .split(/\n|,|•/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

function formatApprovedDate(epoch: any): string {
  const value = Number(epoch || 0);
  if (!value) return "";
  try {
    return new Date(value * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function educationLine(entry: PublicEducationEntry): string {
  const degreeAndField = [safeText(entry.degree), safeText(entry.field_of_study)].filter(Boolean).join(" in ");
  const left = [degreeAndField, safeText(entry.institution)].filter(Boolean).join(" — ");
  const withYear = safeText(entry.graduation_year)
    ? left
      ? `${left} (${safeText(entry.graduation_year)})`
      : safeText(entry.graduation_year)
    : left;
  const extra = safeText((entry as any).focus || entry.notes);
  return extra ? (withYear ? `${withYear}. ${extra}` : extra) : withYear;
}

function normalizeRebrandingSlug(rawBrand: string): string {
  const raw = String(rawBrand || "").trim();
  if (!raw) return "";
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

function stripExt(s: string) {
  let out = String(s || "").trim().split("?", 1)[0].split("#", 1)[0];
  while (true) {
    const next = out.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTrailingUuid(raw: string): string {
  const s = String(raw || "").trim();
  return s.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
}

function normalizeKeyForFile(raw: string) {
  return String(raw || "").trim().replace(/\s+/g, "-");
}

function titleCaseToken(token: string): string {
  const lower = String(token || "").toLowerCase();
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

function buildAvatarCandidates(companionKeyOrName: string, brand?: string) {
  const raw = stripExt(String(companionKeyOrName || "").split("/").pop() || "");
  if (!raw) return [DEFAULT_AVATAR];

  const baseInputs = Array.from(new Set([raw, stripTrailingUuid(raw)].map((v) => String(v || "").trim()).filter(Boolean)));
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

  const slug = normalizeRebrandingSlug(brand || "");
  const slugEnc = slug ? encodeURIComponent(slug) : "";
  const exts = ["jpeg", "JPEG", "jpg", "JPG", "png", "PNG", "webp", "WEBP"] as const;
  const candidates: string[] = [];

  for (const enc of encVariants) {
    if (slugEnc && slug !== "elaralo") {
      const rebrandBase = joinUrlPrefix(APP_BASE_PATH, `${REBRANDING_PUBLIC_DIR}/${slugEnc}${HEADSHOT_DIR}/${enc}`);
      candidates.push(rebrandBase);
      for (const ext of exts) candidates.push(`${rebrandBase}.${ext}`);
    }
    const base = joinUrlPrefix(APP_BASE_PATH, `${HEADSHOT_DIR}/${enc}`);
    candidates.push(base);
    for (const ext of exts) candidates.push(`${base}.${ext}`);
  }
  candidates.push(DEFAULT_AVATAR);
  return candidates;
}

function pickFirstLoadableImage(urls: string[]): Promise<string> {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) return resolve(DEFAULT_AVATAR);
      const url = urls[i++];
      if (url === DEFAULT_AVATAR) return resolve(DEFAULT_AVATAR);
      const img = new Image();
      img.onload = () => resolve(url);
      img.onerror = () => tryNext();
      img.src = url;
    };
    tryNext();
  });
}

function firstNameFromDisplayName(value: string): string {
  const text = safeText(value).replace(/\s+/g, " ");
  if (!text) return "Companion";
  return text.split(" ")[0] || text;
}

function firstNameOrBlank(value: any): string {
  const text = safeText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.split(" ")[0] || text;
}

function publicGalleryLabel(asset: PublicAsset): string {
  const label = safeText((asset as any).slot_label) || slotLabel(safeText(asset.slot_key));
  return label || "Gallery image";
}

function isDefaultOrLogoHeadshot(url: string): boolean {
  const text = safeText(url).toLowerCase();
  if (!text) return true;
  return text.endsWith("/elaralo-logo.png") || text === "elaralo-logo.png" || text === DEFAULT_AVATAR.toLowerCase();
}

function resolveButtonUrl(configuredUrl: string, fallbackPath: string): URL | null {
  if (typeof window === "undefined") return null;
  const raw = safeText(configuredUrl);
  try {
    if (raw) return new URL(raw, window.location.origin);
    return new URL(fallbackPath || "/", window.location.origin);
  } catch {
    try {
      return new URL("/", window.location.origin);
    } catch {
      return null;
    }
  }
}

function compactApprovedDate(epoch: any): string {
  const value = Number(epoch || 0);
  if (!value) return "";
  try {
    return new Date(value * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function displayLine(label: string, value: any): { label: string; value: string } | null {
  const v = safeText(value);
  if (!v) return null;
  return { label, value: v };
}

export default function HostSummaryPublicClient() {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [payload, setPayload] = useState<PublicVersionPayload | null>(null);
  const [resolvedHeadshot, setResolvedHeadshot] = useState<string>("");

  const versionId = queryParam("versionId") || queryParam("version_id");
  const memberId = queryParam("memberId") || queryParam("member_id");
  const brand = queryParam("brand") || queryParam("brandId") || "Elaralo";
  const avatar = queryParam("avatar") || queryParam("companion") || queryParam("companionKey") || queryParam("companion_key");
  const headshot = queryParam("headshot") || queryParam("headshotFile") || queryParam("headshot_file");
  const summaryReturnToCompanions = firstQueryParam(["returnToCompanions", "return_to_companions", "showCompanionListButton", "show_companion_list_button"]);
  const summaryCompanionCount = firstQueryParam(["selectableCompanionCount", "selectable_companion_count", "companionCount", "companion_count"]);
  const summaryCompanionListUrl = firstQueryParam(["companionListUrl", "companion_list_url", "returnUrl", "return_url"]);
  const summaryLoggedIn = firstQueryParam(["loggedIn", "logged_in"]);
  const summaryDisplayName = firstQueryParam(["displayName", "display_name", "userName", "user_name"]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (!versionId && !memberId && !avatar && !headshot) {
        setError("A public summary link requires versionId, memberId, avatar, or headshot in the URL.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const qs = new URLSearchParams();
        if (memberId) qs.set("memberId", memberId);
        if (versionId) qs.set("versionId", versionId);
        if (brand) qs.set("brand", brand);
        if (avatar) qs.set("avatar", avatar);
        if (headshot) qs.set("headshot", headshot);

        const res = await fetch(`${API_BASE}/host-onboarding/public/summary?${qs.toString()}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const data = (await res.json().catch(() => ({} as any))) as PublicVersionPayload;
        if (!res.ok || !data?.public_profile) {
          throw new Error(String(data?.detail || data?.message || `HTTP ${res.status}`));
        }
        if (cancelled) return;
        setPayload(data);
      } catch (err: any) {
        if (cancelled) return;
        setError(String(err?.message || "Unable to load the public summary page."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [avatar, brand, headshot, memberId, versionId]);

  const publicProfile = payload?.public_profile || {};
  const publicPage = payload?.public_page || {};
  const isAiCompanionCard = useMemo(() => {
    const cardType = safeText(publicPage.card_type || publicProfile.summary_mode || publicProfile.card_type).toLowerCase();
    const companionType = safeText(publicProfile.companion_type || publicPage.companion_type).toLowerCase();
    return cardType === "ai_companion" || cardType === "ai_companion_card" || companionType === "ai";
  }, [publicPage.card_type, publicPage.companion_type, publicProfile.card_type, publicProfile.companion_type, publicProfile.summary_mode]);

  const directHeadshotUrl = safeText(publicPage.headshot_asset?.url || publicProfile.headshot_asset?.url || "");
  const avatarKey = safeText(publicProfile.avatar || avatar || headshot || publicPage.headshot_asset?.file_name || publicProfile.headshot_asset?.file_name || "");

  useEffect(() => {
    let cancelled = false;
    async function resolveImage() {
      if (!isAiCompanionCard) {
        setResolvedHeadshot("");
        return;
      }
      if (directHeadshotUrl) {
        setResolvedHeadshot(directHeadshotUrl);
        return;
      }
      if (!avatarKey) {
        setResolvedHeadshot("");
        return;
      }
      const picked = await pickFirstLoadableImage(buildAvatarCandidates(avatarKey, brand));
      if (!cancelled) setResolvedHeadshot(picked && picked !== DEFAULT_AVATAR ? picked : "");
    }
    void resolveImage();
    return () => {
      cancelled = true;
    };
  }, [avatarKey, brand, directHeadshotUrl, isAiCompanionCard]);

  const headshotUrl = isAiCompanionCard ? (resolvedHeadshot || directHeadshotUrl) : directHeadshotUrl;
  const galleryAssets = useMemo(
    () =>
      (
        Array.isArray(publicPage.gallery_assets)
          ? publicPage.gallery_assets
          : Array.isArray(publicProfile.gallery_assets)
            ? publicProfile.gallery_assets
            : []
      ).filter((asset: any) => safeText(asset?.url)),
    [publicPage.gallery_assets, publicProfile.gallery_assets],
  ) as PublicAsset[];

  const educationEntries = useMemo(() => {
    const raw = Array.isArray(publicPage.education_entries)
      ? publicPage.education_entries
      : Array.isArray(publicProfile.education_entries)
        ? publicProfile.education_entries
        : [];
    const normalized = raw.map((entry: any) => educationLine(entry || {})).filter(Boolean);
    if (normalized.length) return normalized;
    return listFromLooseValue(publicPage.education_text || publicProfile.education);
  }, [publicPage.education_entries, publicPage.education_text, publicProfile.education, publicProfile.education_entries]);

  const quickReference = (publicProfile.quick_reference_summary || {}) as Record<string, any>;
  const approvedLabel = formatApprovedDate(payload?.version?.approved_epoch);
  const approvedMobileLabel = compactApprovedDate(payload?.version?.approved_epoch);
  const companionDisplayName = safeText(publicProfile.public_display_name || publicProfile.stage_name || publicProfile.avatar || avatar || "Companion profile");
  const companionFirstName = firstNameFromDisplayName(companionDisplayName);
  const companionTypeValue = safeText(publicProfile.companion_type || publicPage.companion_type || (isAiCompanionCard ? "AI" : "Human"));
  const mappingAvatar = safeText(
    publicProfile.mapping_avatar ||
      publicProfile.mappingAvatar ||
      publicPage.mapping_avatar ||
      publicPage.mappingAvatar ||
      publicProfile.avatar ||
      publicPage.avatar ||
      avatar ||
      companionFirstName,
  );
  const companionKey = safeText(
    publicProfile.companion_key ||
      publicProfile.companionKey ||
      publicPage.companion_key ||
      publicPage.companionKey ||
      avatar ||
      mappingAvatar,
  );
  const configuredConnectUrl = safeText((process.env.NEXT_PUBLIC_CONNECT_URL as any) || (process.env.NEXT_PUBLIC_CONNECT_BASE_URL as any));
  const connectHref = useMemo(() => {
    const url = resolveButtonUrl(configuredConnectUrl, "/");
    if (!url) return "";
    const resolvedBrand = safeText(brand) || "Elaralo";
    const displayName = companionDisplayName;
    const lookupAvatar = mappingAvatar || companionKey || companionFirstName;
    const key = companionKey || lookupAvatar;

    url.searchParams.set("source", "summary-public");
    url.searchParams.set("loggedIn", "0");
    url.searchParams.set("logged_in", "0");
    url.searchParams.set("brand", resolvedBrand);
    url.searchParams.set("rebranding", resolvedBrand);
    if (lookupAvatar) {
      url.searchParams.set("avatar", lookupAvatar);
      url.searchParams.set("avatarName", lookupAvatar);
      url.searchParams.set("avatar_name", lookupAvatar);
      url.searchParams.set("mappingAvatar", lookupAvatar);
      url.searchParams.set("mapping_avatar", lookupAvatar);
      url.searchParams.set("sqlAvatar", lookupAvatar);
      url.searchParams.set("sql_avatar", lookupAvatar);
      url.searchParams.set("companion", lookupAvatar);
      url.searchParams.set("companionName", lookupAvatar);
      url.searchParams.set("companion_name", lookupAvatar);
    }
    if (key) {
      url.searchParams.set("companionKey", key);
      url.searchParams.set("companion_key", key);
    }
    if (displayName) {
      url.searchParams.set("companionDisplayName", displayName);
      url.searchParams.set("companion_display_name", displayName);
    }
    if (companionTypeValue) url.searchParams.set("companionType", companionTypeValue);
    if (headshotUrl && !isDefaultOrLogoHeadshot(headshotUrl)) {
      url.searchParams.set("headshotUrl", headshotUrl);
      url.searchParams.set("headshot_url", headshotUrl);
      url.searchParams.set("imageUrl", headshotUrl);
      url.searchParams.set("image_url", headshotUrl);
      url.searchParams.set("photoUrl", headshotUrl);
      url.searchParams.set("photo_url", headshotUrl);
    }

    const parsedCompanionCount = Math.max(0, Number.parseInt(summaryCompanionCount || "0", 10) || 0);
    const shouldEnableSwap =
      booleanFromLooseString(summaryReturnToCompanions) === true ||
      parsedCompanionCount > 1 ||
      Boolean(summaryCompanionListUrl) ||
      normalizeRebrandingSlug(resolvedBrand) === "elaralo";
    if (shouldEnableSwap) {
      const count = Math.max(parsedCompanionCount, 2);
      const returnUrl = summaryCompanionListUrl || buildSummaryCompanionListReturnUrl(resolvedBrand, memberId, summaryDisplayName || displayName);
      url.searchParams.set("returnToCompanions", "1");
      url.searchParams.set("return_to_companions", "1");
      url.searchParams.set("companionCount", String(count));
      url.searchParams.set("companion_count", String(count));
      url.searchParams.set("selectableCompanionCount", String(count));
      url.searchParams.set("selectable_companion_count", String(count));
      if (returnUrl) {
        url.searchParams.set("companionListUrl", returnUrl);
        url.searchParams.set("companion_list_url", returnUrl);
      }
      if (summaryLoggedIn) {
        url.searchParams.set("loggedIn", summaryLoggedIn);
        url.searchParams.set("logged_in", summaryLoggedIn);
      }
      if (memberId) {
        url.searchParams.set("memberId", memberId);
        url.searchParams.set("member_id", memberId);
      }
      const viewerName = summaryDisplayName || displayName;
      if (viewerName) {
        url.searchParams.set("displayName", viewerName);
        url.searchParams.set("userName", viewerName);
      }
    }
    return url.toString();
  }, [brand, companionDisplayName, companionFirstName, companionKey, companionTypeValue, configuredConnectUrl, headshotUrl, mappingAvatar, memberId, summaryCompanionCount, summaryCompanionListUrl, summaryDisplayName, summaryLoggedIn, summaryReturnToCompanions]);

  const connectLabel = `Connect with ${companionFirstName}`;

  const sectionStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.1)",
    borderRadius: 18,
    background: "#fff",
    padding: 20,
    boxShadow: "0 8px 22px rgba(0,0,0,0.05)",
  };

  const chips = [
    safeText(publicProfile.gender),
    safeText(publicProfile.ethnicity),
    safeText(publicProfile.generation),
  ].filter(Boolean);

  const publicNameValue =
    safeText(quickReference.public_name || publicProfile.public_display_name || publicProfile.stage_name || companionDisplayName) ||
    companionDisplayName;
  const hostProfileRealNameSource = safeText(
    publicProfile.real_first_name ||
      publicProfile.realFirstName ||
      publicProfile.real_name ||
      publicProfile.realName ||
      publicPage.real_first_name ||
      publicPage.realFirstName ||
      publicPage.real_name ||
      publicPage.realName ||
      publicProfile.host_real_name_private ||
      publicProfile.hostRealNamePrivate ||
      publicProfile.private_profile?.legal_name ||
      publicProfile.privateProfile?.legalName ||
      publicProfile.private_identity?.legal_name ||
      publicProfile.privateIdentity?.legalName ||
      publicProfile.ai_profile?.host_real_name_private ||
      publicProfile.aiProfile?.hostRealNamePrivate ||
      publicProfile.ai_profile?.private_identity?.legal_name ||
      publicProfile.aiProfile?.privateIdentity?.legalName ||
      publicProfile.first_name ||
      publicProfile.firstName ||
      quickReference.real_first_name ||
      quickReference.realFirstName ||
      quickReference.real_name ||
      quickReference.realName ||
      "",
  );
  const realFirstNameValue = firstNameOrBlank(hostProfileRealNameSource) || companionFirstName;

  const quickSummaryItems = [
    displayLine("Public name", publicNameValue),
    displayLine("Real name", realFirstNameValue),
    displayLine("Birth location", quickReference.birth_location),
    displayLine("Ethnicity", quickReference.ethnicity),
    displayLine("Race", quickReference.race),
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  const publicSummaryCss = `
    .hsp-main { max-width: 1180px; margin: 24px auto 48px; padding: 0 16px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
    .hsp-stack { display: grid; gap: 18px; }
    .hsp-section { border: 1px solid rgba(0,0,0,0.1); border-radius: 18px; background: #fff; padding: 20px; box-shadow: 0 8px 22px rgba(0,0,0,0.05); }
    .hsp-eyebrow { font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; }
    .hsp-hero-grid { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 28px; align-items: start; }
    .hsp-media-column, .hsp-detail { display: grid; gap: 16px; align-content: start; }
    .hsp-photo { width: 100%; max-width: 340px; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 22px; border: 1px solid rgba(0,0,0,0.08); display: block; }
    .hsp-photo-placeholder { width: 100%; max-width: 340px; aspect-ratio: 4 / 5; border-radius: 22px; border: 1px dashed rgba(0,0,0,0.18); display: grid; place-items: center; color: #6b7280; background: #f8fafc; }
    .hsp-title { margin: 0; font-size: clamp(42px, 7vw, 74px); line-height: .98; letter-spacing: -0.04em; }
    .hsp-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .hsp-chip { padding: 8px 12px; border-radius: 999px; background: rgba(17,24,39,0.06); font-size: 14px; color: #374151; }
    .hsp-cta { display: inline-flex; align-items: center; justify-content: center; width: fit-content; min-height: 46px; padding: 12px 18px; border-radius: 999px; background: #111827; color: #fff; text-decoration: none; font-weight: 800; box-shadow: 0 10px 22px rgba(17,24,39,0.18); }
    .hsp-cta:hover { background: #0f172a; }
    .hsp-summary-card, .hsp-quote-card, .hsp-gallery-card { border: 1px solid rgba(17,24,39,0.08); border-radius: 16px; background: rgba(17,24,39,0.025); padding: 16px; }
    .hsp-summary-title { font-weight: 800; font-size: 20px; margin: 0 0 12px; }
    .hsp-summary-list { display: grid; gap: 10px; }
    .hsp-summary-item { display: grid; gap: 3px; line-height: 1.45; color: #374151; }
    .hsp-summary-label { font-size: 13px; font-weight: 800; color: #111827; }
    .hsp-motto-card { border: 1px solid rgba(17,24,39,0.08); border-radius: 16px; background: rgba(17,24,39,0.025); padding: 16px; text-align: left; }
    .hsp-motto-title { font-weight: 800; font-size: 20px; margin: 0 0 12px; color: #111827; text-align: left; }
    .hsp-quote-card { margin: 0; padding: 0 0 0 18px; border-left: 5px solid #111827; color: #374151; font-size: 17px; line-height: 1.55; text-align: left; }
    .hsp-gallery-title { font-weight: 800; font-size: 20px; margin: 0 0 12px; }
    .hsp-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 12px; }
    .hsp-gallery-thumb { margin: 0; min-width: 0; display: block; }
    .hsp-gallery-frame { width: 100%; aspect-ratio: 4 / 5; border-radius: 14px; overflow: hidden; background: #eef2f7; border: 1px solid rgba(17,24,39,0.08); }
    .hsp-gallery-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .hsp-mobile-only { display: none; }
    .hsp-desktop-only { display: block; }
    .hsp-under-photo { display: grid; gap: 16px; }
    .hsp-sticky-cta { display: none; }
    @media (max-width: 760px) {
      .hsp-main { margin: 14px auto 96px; padding: 0 14px; }
      .hsp-section { padding: 18px; border-radius: 20px; box-shadow: 0 10px 28px rgba(15,23,42,0.06); }
      .hsp-eyebrow { padding-top: max(8px, env(safe-area-inset-top)); }
      .hsp-hero-grid { grid-template-columns: 1fr; gap: 18px; }
      .hsp-media-column, .hsp-detail { gap: 14px; }
      .hsp-photo, .hsp-photo-placeholder { max-width: none; width: 100%; aspect-ratio: 4 / 5; border-radius: 22px; }
      .hsp-desktop-only { display: none; }
      .hsp-mobile-only { display: grid; gap: 14px; }
      .hsp-title { font-size: clamp(40px, 14vw, 60px); line-height: 1; }
      .hsp-chip { font-size: 13px; padding: 7px 11px; }
      .hsp-cta { width: 100%; min-height: 50px; }
      .hsp-summary-title { font-size: 19px; }
      .hsp-summary-card, .hsp-motto-card, .hsp-gallery-card { padding: 15px; border-radius: 16px; }
      .hsp-quote-card { font-size: 16px; }
      .hsp-gallery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hsp-sticky-cta { display: block; position: fixed; z-index: 50; left: 0; right: 0; bottom: 0; padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); background: rgba(255,255,255,0.94); backdrop-filter: blur(12px); border-top: 1px solid rgba(17,24,39,0.1); box-shadow: 0 -10px 26px rgba(15,23,42,0.08); }
      .hsp-sticky-cta .hsp-cta { width: 100%; }
    }
  `;

  if (loading) {
    return (
      <main style={{ maxWidth: 1120, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={sectionStyle}>Loading {isAiCompanionCard ? "companion card" : "public summary"}…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ maxWidth: 1120, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={sectionStyle}>
          <h1 style={{ marginTop: 0 }}>{isAiCompanionCard ? "Companion Card" : "Summary Public Page"}</h1>
          <div style={{ color: "#b91c1c", lineHeight: 1.6 }}>{error}</div>
        </div>
      </main>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: publicSummaryCss }} />
      <main className="hsp-main">
        <div className="hsp-stack">
          <section className="hsp-section hsp-stack">
            <div className="hsp-eyebrow">{isAiCompanionCard ? "Companion Card" : "Summary Public Page"}</div>
            <div className="hsp-hero-grid">
              <div className="hsp-media-column">
                {headshotUrl ? (
                  <img
                    src={headshotUrl}
                    alt={safeText(publicProfile.public_display_name || publicProfile.stage_name || "Companion headshot")}
                    className="hsp-photo"
                  />
                ) : (
                  <div className="hsp-photo-placeholder">No headshot available</div>
                )}

                <div className="hsp-under-photo hsp-desktop-only">
                  {isAiCompanionCard ? null : quickSummaryItems.length ? (
                    <div className="hsp-summary-card">
                      <h2 className="hsp-summary-title">Quick Summary</h2>
                      <div className="hsp-summary-list">
                        {quickSummaryItems.map((item) => (
                          <div key={`desktop-${item.label}-${item.value}`} className="hsp-summary-item">
                            <span className="hsp-summary-label">{item.label}</span>
                            <span>{item.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                </div>
              </div>

              <div className="hsp-detail">
                <h1 className="hsp-title">{companionDisplayName}</h1>

                <div className="hsp-chip-row">
                  {chips.map((chip) => (
                    <span key={chip} className="hsp-chip">{chip}</span>
                  ))}
                  {approvedMobileLabel ? <span className="hsp-chip">Approved {approvedMobileLabel}</span> : null}
                </div>

                {connectHref ? (
                  <a href={connectHref} className="hsp-cta" aria-label={connectLabel}>
                    {connectLabel}
                  </a>
                ) : null}

                {!isAiCompanionCard ? (
                  <div className="hsp-mobile-only">
                    {quickSummaryItems.length ? (
                      <div className="hsp-summary-card">
                        <h2 className="hsp-summary-title">Quick Summary</h2>
                        <div className="hsp-summary-list">
                          {quickSummaryItems.map((item) => (
                            <div key={`mobile-${item.label}-${item.value}`} className="hsp-summary-item">
                              <span className="hsp-summary-label">{item.label}</span>
                              <span>{item.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {safeText(publicProfile.personal_motto) ? (
                      <div className="hsp-motto-card">
                        <h2 className="hsp-motto-title">Motto</h2>
                        <blockquote className="hsp-quote-card">
                          “{safeText(publicProfile.personal_motto)}”
                        </blockquote>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {isAiCompanionCard ? (
                  <div className="hsp-summary-card">
                    <h2 className="hsp-summary-title">Companion Details</h2>
                    <div className="hsp-summary-list">
                      {safeText(publicProfile.gender) ? <div className="hsp-summary-item"><span className="hsp-summary-label">Gender</span><span>{safeText(publicProfile.gender)}</span></div> : null}
                      {safeText(publicProfile.ethnicity) ? <div className="hsp-summary-item"><span className="hsp-summary-label">Ethnicity</span><span>{safeText(publicProfile.ethnicity)}</span></div> : null}
                      {safeText(publicProfile.generation) ? <div className="hsp-summary-item"><span className="hsp-summary-label">Generation</span><span>{safeText(publicProfile.generation)}</span></div> : null}
                    </div>
                  </div>
                ) : galleryAssets.length ? (
                  <div className="hsp-gallery-card">
                    <h2 className="hsp-gallery-title">Public Gallery</h2>
                    <div className="hsp-gallery-grid">
                      {galleryAssets.map((asset, idx) => (
                        <figure key={`${safeText(asset.asset_id || asset.url || idx)}`} className="hsp-gallery-thumb">
                          <div className="hsp-gallery-frame">
                            <img src={safeText(asset.url)} alt={publicGalleryLabel(asset)} />
                          </div>
                        </figure>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!isAiCompanionCard && safeText(publicProfile.personal_motto) ? (
                  <div className="hsp-motto-card hsp-desktop-only">
                    <h2 className="hsp-motto-title">Motto</h2>
                    <blockquote className="hsp-quote-card">
                      “{safeText(publicProfile.personal_motto)}”
                    </blockquote>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          {!isAiCompanionCard && safeText(publicProfile.physical_description) ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Physical Description</h2>
              <div style={{ color: "#374151", lineHeight: 1.75 }}>{safeText(publicProfile.physical_description)}</div>
            </section>
          ) : null}

          {!isAiCompanionCard && safeText(publicProfile.personality) ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Personality</h2>
              <div style={{ color: "#374151", lineHeight: 1.75 }}>{safeText(publicProfile.personality)}</div>
            </section>
          ) : null}

          {!isAiCompanionCard && educationEntries.length ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Education</h2>
              <div style={{ display: "grid", gap: 10 }}>
                {educationEntries.map((line, idx) => (
                  <div key={`${line}-${idx}`} style={{ color: "#374151", lineHeight: 1.7 }}>{line}</div>
                ))}
              </div>
            </section>
          ) : null}

          {!isAiCompanionCard && (safeText(publicProfile.career?.current_job_title) || safeText(publicProfile.career?.career_summary)) ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Career</h2>
              <div style={{ display: "grid", gap: 8, color: "#374151", lineHeight: 1.7 }}>
                {safeText(publicProfile.career?.current_job_title) ? <div><b>Current position:</b> {safeText(publicProfile.career?.current_job_title)}</div> : null}
                {safeText(publicProfile.career?.current_company) ? <div><b>Company:</b> {safeText(publicProfile.career?.current_company)}</div> : null}
                {safeText(publicProfile.career?.career_summary) ? <div>{safeText(publicProfile.career?.career_summary)}</div> : null}
              </div>
            </section>
          ) : null}

          {!isAiCompanionCard && (safeText(publicProfile.likes) || safeText(publicProfile.hobbies) || safeText(publicProfile.lifestyle) || safeText(publicProfile.background_story) || safeText(publicProfile.core_values)) ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Profile Highlights</h2>
              <div style={{ display: "grid", gap: 12, color: "#374151", lineHeight: 1.75 }}>
                {safeText(publicProfile.likes) ? <div><b>Likes:</b> {safeText(publicProfile.likes)}</div> : null}
                {safeText(publicProfile.hobbies) ? <div><b>Hobbies:</b> {safeText(publicProfile.hobbies)}</div> : null}
                {safeText(publicProfile.lifestyle) ? <div><b>Lifestyle:</b> {safeText(publicProfile.lifestyle)}</div> : null}
                {safeText(publicProfile.background_story) ? <div><b>Background:</b> {safeText(publicProfile.background_story)}</div> : null}
                {safeText(publicProfile.core_values) ? <div><b>Core values:</b> {safeText(publicProfile.core_values)}</div> : null}
              </div>
            </section>
          ) : null}

          {isAiCompanionCard && galleryAssets.length ? (
            <section style={sectionStyle}>
              <h2 style={{ marginTop: 0 }}>Additional Photos</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                {galleryAssets.map((asset, idx) => (
                  <figure key={`${safeText(asset.asset_id || asset.url || idx)}`} style={{ margin: 0, display: "grid", gap: 8 }}>
                    <img src={safeText(asset.url)} alt={slotLabel(safeText(asset.slot_key))} style={{ width: "100%", aspectRatio: "4 / 5", objectFit: "cover", borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)" }} />
                    <figcaption style={{ fontSize: 13, color: "#4b5563" }}>{slotLabel(safeText(asset.slot_key))}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </main>

      {connectHref ? (
        <div className="hsp-sticky-cta">
          <a href={connectHref} className="hsp-cta" aria-label={connectLabel}>
            {connectLabel}
          </a>
        </div>
      ) : null}
    </>
  );
}

function slotLabel(slotKey: string): string {
  const map: Record<string, string> = {
    headshot_front: "Headshot",
    full_body_front: "Full body",
    three_quarter_body: "Three-quarter body",
    angle_left_45: "45-degree left",
    angle_right_45: "45-degree right",
    left_profile: "Left profile",
    right_profile: "Right profile",
    smiling_headshot: "Smiling headshot",
    neutral_headshot: "Neutral headshot",
    extra_angle: "Additional photo",
  };
  const key = safeText(slotKey);
  return map[key] || key.replace(/_/g, " ");
}
