"use client";

// v10.0.0-alpha16.17
// - Removes the AI Haven 4U client-side AI-only selector restriction.
// - The catalog response and database visibility fields now determine which
//   published Human and AI entries are available for every brand.
// - Renames the visible "Companion Type" filter label to "Interplay" across
//   Elaralo, DulceMoon, AI Haven 4U, and future shared-selector brands.
// - Preserves existing identity, plan handoff, auto-open, Connect launch,
//   return-to-selector, and public-card behavior.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MemberPlanPayload = {
  loggedIn?: boolean;
  logged_in?: boolean;
  memberId?: string;
  member_id?: string;
  anonymousId?: string;
  anonymous_id?: string;
  hostMemberId?: string;
  host_member_id?: string;
  isHostUser?: boolean;
  is_host_user?: boolean;
  displayName?: string;
  display_name?: string;
  userName?: string;
  user_name?: string;
  email?: string;
  brand?: string;
  avatar?: string;
  [key: string]: unknown;
};

type CompanionCardItem = {
  id: string;
  companionType: string;
  displayName: string;
  brand: string;
  avatar: string;
  headshotUrl: string;
  summaryPublicUrl: string;
  gender: string;
  ethnicity: string;
  generation: string;
  shortSummary: string;
  catalogHidden: boolean;
  listInCompanionCatalog: boolean;
  raw: Record<string, unknown>;
};

type CatalogResponse = {
  ok?: boolean;
  brand?: string;
  member_id?: string;
  hostMemberId?: string;
  host_member_id?: string;
  isHostUser?: boolean;
  is_host_user?: boolean;
  count?: number;
  items?: unknown[];
  detail?: string;
  message?: string;
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
const APP_BASE = String(process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(/\/+$/, "");
const DEFAULT_HEADSHOT = "/elaralo-logo.png";
const ELARALO_TRIAL_PLAN_NAME = "Trial";

// Trial minutes remain backend-authoritative. These values are sent only when
// the deployment explicitly provides an override through a public build value.
const ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE = String(
  process.env.NEXT_PUBLIC_ELARALO_TRIAL_MINUTES ||
    process.env.NEXT_PUBLIC_TRIAL_MINUTES_ELARALO ||
    "",
).trim();
const AIHAVEN4U_TRIAL_MINUTES_QUERY_OVERRIDE = String(
  process.env.NEXT_PUBLIC_AIHAVEN4U_TRIAL_MINUTES ||
    process.env.NEXT_PUBLIC_TRIAL_MINUTES_AIHAVEN4U ||
    "",
).trim();

function safeText(value: unknown): string {
  return String(value ?? "").trim();
}

function safeLower(value: unknown): string {
  return safeText(value).toLowerCase();
}

function firstNameFromDisplayName(value: unknown): string {
  const text = safeText(value).replace(/\s+/g, " ");
  if (!text) return "Companion";
  return text.split(" ")[0] || text;
}

function payloadHasPaidPlan(payload: MemberPlanPayload): boolean {
  const raw = safeText(payload.planName || payload.plan_name || payload.plan);
  if (!raw) return false;
  const normalized = raw
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/[-–—_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*membership\s*$/i, "")
    .replace(/^test\s+/i, "")
    .trim()
    .toLowerCase();
  return ![
    "",
    "trial",
    "free trial",
    "free",
    "none",
    "no plan",
    "unknown",
    "not provided",
    "pay as you go",
  ].includes(normalized);
}

function isAnonMemberId(value: unknown): boolean {
  return safeLower(value).startsWith("anon:");
}

function canonicalMemberIdFromWixIdentity(
  memberIdRaw: unknown,
  anonymousIdRaw: unknown,
  loggedIn: boolean,
): string {
  const memberId = safeText(memberIdRaw);
  if (loggedIn) return isAnonMemberId(memberId) ? "" : memberId;

  const anonymousId = safeText(anonymousIdRaw || (isAnonMemberId(memberId) ? memberId : ""))
    .replace(/^anon:/i, "")
    .trim();
  return anonymousId ? `anon:${anonymousId}` : "";
}

function stripAvatarCollisionSuffix(value: unknown): string {
  return safeText(value).replace(/-\d{9}$/, "");
}

function toTitle(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ""))
    .join(" ")
    .trim();
}

function normalizeCompanionType(value: unknown): string {
  const raw = safeLower(value);
  if (!raw) return "";
  if (raw === "human" || raw === "human_companion") return "Human";
  if (raw === "ai" || raw === "ai_companion") return "AI";
  return toTitle(raw.replace(/[_-]+/g, " "));
}

function readQueryContext(): MemberPlanPayload {
  if (typeof window === "undefined") return {};
  try {
    const query = new URLSearchParams(window.location.search || "");
    return {
      loggedIn: ["1", "true", "yes"].includes(
        safeLower(query.get("loggedIn") || query.get("logged_in")),
      ),
      memberId: safeText(query.get("memberId") || query.get("member_id")),
      anonymousId: safeText(query.get("anonymousId") || query.get("anonymous_id")),
      hostMemberId: safeText(query.get("hostMemberId") || query.get("host_member_id")),
      isHostUser: ["1", "true", "yes"].includes(
        safeLower(query.get("isHostUser") || query.get("is_host_user")),
      ),
      displayName: safeText(
        query.get("displayName") ||
          query.get("display_name") ||
          query.get("userName") ||
          query.get("user_name"),
      ),
      email: safeText(query.get("email")),
      brand: safeText(query.get("brand")),
      avatar: safeText(query.get("avatar")),
    };
  } catch {
    return {};
  }
}

function readQueryFlag(...names: string[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    const query = new URLSearchParams(window.location.search || "");
    for (const name of names) {
      if (["1", "true", "yes", "y", "on"].includes(safeLower(query.get(name)))) {
        return true;
      }
    }
  } catch {
    // Ignore malformed query strings.
  }
  return false;
}

function mergeMemberPayload(
  previous: MemberPlanPayload,
  incoming: MemberPlanPayload,
): MemberPlanPayload {
  return {
    ...previous,
    ...incoming,
    loggedIn: Boolean(
      incoming.loggedIn ??
        incoming.logged_in ??
        previous.loggedIn ??
        previous.logged_in,
    ),
    memberId: safeText(
      incoming.memberId || incoming.member_id || previous.memberId || previous.member_id,
    ),
    anonymousId: safeText(
      incoming.anonymousId ||
        incoming.anonymous_id ||
        previous.anonymousId ||
        previous.anonymous_id,
    ),
    hostMemberId: safeText(
      incoming.hostMemberId ||
        incoming.host_member_id ||
        previous.hostMemberId ||
        previous.host_member_id,
    ),
    isHostUser: Boolean(
      incoming.isHostUser ??
        incoming.is_host_user ??
        previous.isHostUser ??
        previous.is_host_user,
    ),
    displayName: safeText(
      incoming.displayName ||
        incoming.display_name ||
        incoming.userName ||
        incoming.user_name ||
        previous.displayName ||
        previous.display_name ||
        previous.userName ||
        previous.user_name,
    ),
    email: safeText(incoming.email || previous.email),
    brand: safeText(incoming.brand || previous.brand),
    avatar: safeText(incoming.avatar || previous.avatar),
  };
}

function normalizeCard(itemRaw: unknown, defaultBrand: string): CompanionCardItem {
  const item = itemRaw && typeof itemRaw === "object" ? (itemRaw as Record<string, unknown>) : {};
  const rawDisplayName =
    safeText(item.display_name) ||
    safeText(item.displayName) ||
    safeText(item.public_name) ||
    safeText(item.publicName) ||
    safeText(item.name) ||
    safeText(item.first_name) ||
    safeText(item.firstName) ||
    safeText(item.avatar) ||
    "Companion";
  const displayName = stripAvatarCollisionSuffix(rawDisplayName) || "Companion";
  const avatar =
    safeText(item.avatar) ||
    safeText(item.companion) ||
    safeText(item.companion_key) ||
    safeText(item.companionKey) ||
    safeText(item.slug);
  const brand = safeText(item.brand) || defaultBrand || "Elaralo";
  const headshotUrl =
    safeText(item.headshot_url) ||
    safeText(item.headshotUrl) ||
    safeText(item.image_url) ||
    safeText(item.imageUrl) ||
    safeText(item.photo_url) ||
    safeText(item.photoUrl) ||
    DEFAULT_HEADSHOT;
  const summaryPublicUrl =
    safeText(item.summary_public_url) ||
    safeText(item.summaryPublicUrl) ||
    (avatar
      ? `${APP_BASE || ""}/summary-public?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(avatar)}`
      : "");
  const id =
    safeText(item.id) ||
    safeText(item.companion_id) ||
    safeText(item.companionId) ||
    safeText(item.member_id) ||
    safeText(item.memberId) ||
    `${brand}:${avatar || displayName}`;

  return {
    id,
    companionType: normalizeCompanionType(item.companion_type || item.companionType),
    displayName,
    brand,
    avatar,
    headshotUrl,
    summaryPublicUrl,
    gender: safeText(item.gender),
    ethnicity:
      safeText(item.companion_catalog_ethnicity) ||
      safeText(item.companionCatalogEthnicity) ||
      safeText(item.race_label) ||
      safeText(item.raceLabel) ||
      safeText(item.race) ||
      safeText(item.ethnicity),
    generation:
      safeText(item.generation) ||
      safeText(item.generation_label) ||
      safeText(item.generationLabel),
    shortSummary:
      safeText(item.summary) ||
      safeText(item.short_summary) ||
      safeText(item.shortSummary) ||
      safeText(item.tagline),
    catalogHidden: Boolean(item.catalog_hidden || item.hidden || item.is_hidden || item.isHidden),
    listInCompanionCatalog: Boolean(
      item.list_in_companion_catalog ??
        item.listInCompanionCatalog ??
        item.catalog_visible ??
        item.catalogVisible,
    ),
    raw: item,
  };
}

function isDefaultOrLogoHeadshot(value: unknown): boolean {
  const raw = safeText(value);
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower === DEFAULT_HEADSHOT.toLowerCase() ||
    /(^|\/)elaralo-logo\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(lower)
  );
}

function firstMeaningfulImageUrl(...values: unknown[]): string {
  for (const value of values) {
    const text = safeText(value);
    if (!text || isDefaultOrLogoHeadshot(text)) continue;
    return text;
  }
  return "";
}

function companionKeyFirstToken(value: unknown): string {
  const raw = safeText(value)
    .split("?", 1)[0]
    .split("#", 1)[0]
    .replace(/^.*[\\/]/, "")
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .trim();
  return safeText(raw.split("-", 1)[0]);
}

function payloadCompanionKey(payload: MemberPlanPayload): string {
  return (
    safeText(payload.companionKey) ||
    safeText(payload.companion_key) ||
    safeText(payload.selectedCompanionKey) ||
    safeText(payload.selected_companion_key) ||
    safeText(payload.companion) ||
    safeText(payload.companionName) ||
    safeText(payload.companion_name) ||
    safeText(payload.avatar) ||
    safeText(payload.avatarName) ||
    safeText(payload.avatar_name)
  );
}

function payloadMappingAvatar(payload: MemberPlanPayload): string {
  return (
    safeText(payload.mappingAvatar) ||
    safeText(payload.mapping_avatar) ||
    safeText(payload.sqlAvatar) ||
    safeText(payload.sql_avatar) ||
    safeText(payload.avatar) ||
    safeText(payload.avatarName) ||
    safeText(payload.avatar_name) ||
    companionKeyFirstToken(payloadCompanionKey(payload))
  );
}

function payloadHeadshotUrl(payload: MemberPlanPayload): string {
  return firstMeaningfulImageUrl(
    payload.headshotUrl,
    payload.headshot_url,
    payload.imageUrl,
    payload.image_url,
    payload.photoUrl,
    payload.photo_url,
    payload.avatarUrl,
    payload.avatar_url,
  );
}

function canonicalCompanionKeyForCard(card: CompanionCardItem | null | undefined): string {
  const raw = card?.raw || {};
  return (
    safeText(raw.companion_key) ||
    safeText(raw.companionKey) ||
    safeText(raw.avatar_key) ||
    safeText(raw.avatarKey) ||
    safeText(card?.avatar) ||
    safeText(raw.avatar) ||
    safeText(raw.companion) ||
    safeText(raw.slug)
  );
}

function companionDisplayNameForCard(card: CompanionCardItem | null | undefined): string {
  const key = canonicalCompanionKeyForCard(card);
  const raw = card?.raw || {};
  return stripAvatarCollisionSuffix(
    safeText(card?.displayName) ||
      safeText(raw.display_name) ||
      safeText(raw.displayName) ||
      safeText(raw.name) ||
      key.split("-", 1)[0] ||
      "Companion",
  );
}

function companionMappingAvatarForCard(card: CompanionCardItem | null | undefined): string {
  const raw = card?.raw || {};
  const companionKey = canonicalCompanionKeyForCard(card);
  const companionType = safeLower(card?.companionType || raw.companion_type || raw.companionType);
  const explicitMappingAvatar =
    safeText(raw.mapping_avatar) ||
    safeText(raw.mappingAvatar) ||
    safeText(raw.sql_avatar) ||
    safeText(raw.sqlAvatar);
  if (explicitMappingAvatar) return explicitMappingAvatar;
  if (companionType === "ai") return companionDisplayNameForCard(card) || companionKey;
  return safeText(card?.avatar) || safeText(raw.avatar) || companionKey;
}

function cardMatchesPayloadCompanion(
  card: CompanionCardItem | null | undefined,
  payload: MemberPlanPayload,
): boolean {
  if (!card) return false;
  const candidates = [
    canonicalCompanionKeyForCard(card),
    companionMappingAvatarForCard(card),
    companionDisplayNameForCard(card),
    card.avatar,
    card.raw.avatar,
    card.raw.companion_key,
    card.raw.companionKey,
  ]
    .map((value) => safeLower(value))
    .filter(Boolean);
  const incoming = [
    payloadCompanionKey(payload),
    payloadMappingAvatar(payload),
    companionKeyFirstToken(payloadCompanionKey(payload)),
  ]
    .map((value) => safeLower(value))
    .filter(Boolean);
  return incoming.some((value) => candidates.includes(value));
}

function firstLine(text: string): string {
  const value = safeText(text);
  if (!value) return "";
  const line = value.split(/\n+/)[0]?.trim() || "";
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function resolveButtonUrl(rawTarget: string, fallbackPath: string): URL | null {
  if (typeof window === "undefined") return null;
  const target = safeText(rawTarget) || fallbackPath;
  if (!target) return null;
  const base = APP_BASE || window.location.origin;
  try {
    return new URL(target, base);
  } catch {
    try {
      return new URL(fallbackPath, base);
    } catch {
      return null;
    }
  }
}

function buildCompanionListReturnUrl(brand: string): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    for (const name of ["autoOpenSingle", "auto_open_single", "autoOpen", "auto_open"]) {
      url.searchParams.delete(name);
    }
    url.searchParams.set("brand", safeText(brand) || "Elaralo");
    url.searchParams.set("forceSelector", "1");
    url.searchParams.set("showCompanionList", "1");
    url.searchParams.set("returningFromConnect", "1");
    return url.toString();
  } catch {
    try {
      const url = new URL("/my-elaralo", APP_BASE || window.location.origin);
      url.searchParams.set("brand", safeText(brand) || "Elaralo");
      url.searchParams.set("forceSelector", "1");
      url.searchParams.set("showCompanionList", "1");
      url.searchParams.set("returningFromConnect", "1");
      return url.toString();
    } catch {
      return "";
    }
  }
}

function firstPayloadValue(payload: MemberPlanPayload, keys: string[]): string {
  for (const key of keys) {
    const value = safeText(payload[key]);
    if (value) return value;
  }
  return "";
}

function setPairedParam(url: URL, camelName: string, snakeName: string, value: string): void {
  if (!value) return;
  url.searchParams.set(camelName, value);
  url.searchParams.set(snakeName, value);
}

export default function MyElaraloCompanionSelectorClient() {
  const [memberPayload, setMemberPayload] = useState<MemberPlanPayload>(() => readQueryContext());
  const [cards, setCards] = useState<CompanionCardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [companionTypeFilter, setCompanionTypeFilter] = useState("");
  const [generationFilter, setGenerationFilter] = useState("");
  const [ethnicityFilter, setEthnicityFilter] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [externalPayloadSeen, setExternalPayloadSeen] = useState(false);
  const [contextGraceElapsed, setContextGraceElapsed] = useState(false);
  const autoOpenedSingleRef = useRef(false);
  const payloadPending = useMemo(
    () => readQueryFlag("payloadPending", "payload_pending", "waitForPayload", "wait_for_payload"),
    [],
  );
  const [payloadPendingGraceElapsed, setPayloadPendingGraceElapsed] = useState(!payloadPending);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const data = event?.data && typeof event.data === "object" ? event.data : {};
        const type = safeText((data as Record<string, unknown>).type);
        const directPayload = data as MemberPlanPayload & { payload?: unknown };
        const nestedPayload =
          directPayload.payload && typeof directPayload.payload === "object"
            ? (directPayload.payload as MemberPlanPayload)
            : null;
        const payload = type === "MEMBER_PLAN" ? nestedPayload || directPayload : directPayload;
        if (
          type === "MEMBER_PLAN" ||
          type === "MY_ELARALO_CONTEXT" ||
          payload.memberId ||
          payload.member_id ||
          payload.anonymousId ||
          payload.anonymous_id
        ) {
          setExternalPayloadSeen(true);
          setMemberPayload((previous) => mergeMemberPayload(previous, payload));
          try {
            window.parent?.postMessage({ type: "MY_ELARALO_CONTEXT_ACK" }, "*");
          } catch {
            // Parent acknowledgement is best effort.
          }
        }
      } catch {
        // Ignore unrelated postMessage traffic.
      }
    };

    window.addEventListener("message", handler);
    try {
      window.parent?.postMessage({ type: "REQUEST_MEMBER_PLAN" }, "*");
      window.parent?.postMessage({ type: "MY_ELARALO_CONTEXT_REQUEST" }, "*");
    } catch {
      // Parent request is best effort.
    }
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setContextGraceElapsed(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!payloadPending) {
      setPayloadPendingGraceElapsed(true);
      return;
    }
    const timer = window.setTimeout(() => setPayloadPendingGraceElapsed(true), 12000);
    return () => window.clearTimeout(timer);
  }, [payloadPending]);

  const loggedIn = Boolean(memberPayload.loggedIn ?? memberPayload.logged_in);
  const anonymousId = safeText(memberPayload.anonymousId || memberPayload.anonymous_id);
  const memberId = canonicalMemberIdFromWixIdentity(
    memberPayload.memberId || memberPayload.member_id,
    anonymousId,
    loggedIn,
  );
  const displayName = safeText(
    memberPayload.displayName ||
      memberPayload.display_name ||
      memberPayload.userName ||
      memberPayload.user_name,
  );
  const brandName = safeText(memberPayload.brand) || "Elaralo";
  const brandKey = safeLower(brandName).replace(/[^a-z0-9]+/g, "");
  const isElaraloCoreBrand = brandKey === "elaralo";
  const isAIHaven4UBrand = brandKey === "aihaven4u" || brandKey === "aihaven";
  const sessionDisplayName = displayName || (memberId && !isAnonMemberId(memberId) ? memberId : "Visitor");

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog(): Promise<void> {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }

      if (payloadPending && !externalPayloadSeen && !payloadPendingGraceElapsed) {
        setError("");
        setLoading(true);
        return;
      }

      if (!memberId && isElaraloCoreBrand && loggedIn && !externalPayloadSeen && !contextGraceElapsed) {
        setError("");
        setLoading(true);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const query = new URLSearchParams();
        if (memberId) query.set("memberId", memberId);
        query.set("brand", brandName || "Elaralo");
        const response = await fetch(
          `${API_BASE}/my-elaralo/companions/catalog?${query.toString()}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            credentials: "omit",
          },
        );
        const data = (await response.json().catch(() => ({}))) as CatalogResponse;
        if (!response.ok || !Array.isArray(data.items)) {
          throw new Error(safeText(data.detail || data.message || `HTTP ${response.status}`));
        }
        if (cancelled) return;
        const responseBrand = safeText(data.brand) || brandName || "Elaralo";
        setCards(data.items.map((item) => normalizeCard(item, responseBrand)));
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load companions.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [
    brandName,
    contextGraceElapsed,
    externalPayloadSeen,
    isElaraloCoreBrand,
    loggedIn,
    memberId,
    payloadPending,
    payloadPendingGraceElapsed,
  ]);

  // Database-authoritative shared selector rule:
  // every brand uses the returned catalog rows and visibility flags. The client
  // only rejects hidden rows and unrecognized type values; it no longer forces
  // AI Haven 4U to AI-only at render time.
  const selectableCards = useMemo(
    () =>
      cards.filter((card) => {
        if (card.catalogHidden) return false;
        const companionType = safeLower(card.companionType);
        return companionType === "human" || companionType === "ai";
      }),
    [cards],
  );

  const companionTypeOptions = useMemo(
    () => Array.from(new Set(selectableCards.map((card) => card.companionType).filter(Boolean))).sort(),
    [selectableCards],
  );
  const generationOptions = useMemo(
    () => Array.from(new Set(selectableCards.map((card) => card.generation).filter(Boolean))).sort(),
    [selectableCards],
  );
  const ethnicityOptions = useMemo(
    () => Array.from(new Set(selectableCards.map((card) => card.ethnicity).filter(Boolean))).sort(),
    [selectableCards],
  );
  const genderOptions = useMemo(
    () => Array.from(new Set(selectableCards.map((card) => card.gender).filter(Boolean))).sort(),
    [selectableCards],
  );

  const filteredCards = useMemo(
    () =>
      selectableCards.filter((card) => {
        if (companionTypeFilter && safeLower(card.companionType) !== safeLower(companionTypeFilter)) {
          return false;
        }
        if (generationFilter && safeLower(card.generation) !== safeLower(generationFilter)) return false;
        if (ethnicityFilter && safeLower(card.ethnicity) !== safeLower(ethnicityFilter)) return false;
        if (genderFilter && safeLower(card.gender) !== safeLower(genderFilter)) return false;
        return true;
      }),
    [
      companionTypeFilter,
      ethnicityFilter,
      genderFilter,
      generationFilter,
      selectableCards,
    ],
  );

  const companionPayloadHeadshotUrl = useMemo(
    () => payloadHeadshotUrl(memberPayload),
    [memberPayload],
  );
  const selectableCompanionCount = selectableCards.length;
  const autoOpenCard = useMemo(
    () => (selectableCompanionCount === 1 ? selectableCards[0] : null),
    [selectableCards, selectableCompanionCount],
  );

  const imageUrlForCard = useCallback(
    (card: CompanionCardItem): string => {
      const raw = card.raw || {};
      const fromCard = firstMeaningfulImageUrl(
        card.headshotUrl,
        raw.headshot_url,
        raw.headshotUrl,
        raw.image_url,
        raw.imageUrl,
        raw.photo_url,
        raw.photoUrl,
      );
      if (fromCard) return fromCard;
      if (companionPayloadHeadshotUrl && cardMatchesPayloadCompanion(card, memberPayload)) {
        return companionPayloadHeadshotUrl;
      }
      return DEFAULT_HEADSHOT;
    },
    [companionPayloadHeadshotUrl, memberPayload],
  );

  const openConnect = useCallback(
    (card: CompanionCardItem): void => {
      const companionKey = canonicalCompanionKeyForCard(card);
      if (!companionKey || typeof window === "undefined") return;

      try {
        const raw = card.raw || {};
        const brand = safeText(card.brand) || brandName || "Elaralo";
        const companionDisplayName = companionDisplayNameForCard(card);
        const mappingAvatar = companionMappingAvatarForCard(card);
        const configuredConnectUrl = safeText(
          process.env.NEXT_PUBLIC_CONNECT_URL || process.env.NEXT_PUBLIC_CONNECT_BASE_URL,
        );
        const url = resolveButtonUrl(configuredConnectUrl, "/");
        if (!url) return;

        url.searchParams.set("source", isAIHaven4UBrand ? "my-haven" : "my-elaralo");
        url.searchParams.set("loggedIn", loggedIn ? "1" : "0");
        url.searchParams.set("logged_in", loggedIn ? "1" : "0");
        url.searchParams.set("brand", brand);
        url.searchParams.set("companyName", brand);
        url.searchParams.set("company_name", brand);

        if (memberId) setPairedParam(url, "memberId", "member_id", memberId);
        if (anonymousId) setPairedParam(url, "anonymousId", "anonymous_id", anonymousId);
        if (displayName) {
          url.searchParams.set("displayName", displayName);
          url.searchParams.set("display_name", displayName);
          url.searchParams.set("userName", displayName);
          url.searchParams.set("user_name", displayName);
        }

        url.searchParams.set("avatar", companionKey);
        url.searchParams.set("companion", companionKey);
        setPairedParam(url, "companionKey", "companion_key", companionKey);
        if (companionDisplayName) {
          setPairedParam(url, "companionName", "companion_name", companionDisplayName);
        }
        if (mappingAvatar) {
          setPairedParam(url, "mappingAvatar", "mapping_avatar", mappingAvatar);
          setPairedParam(url, "sqlAvatar", "sql_avatar", mappingAvatar);
        }
        if (card.companionType) {
          setPairedParam(url, "companionType", "companion_type", card.companionType);
        }
        const imageUrl = imageUrlForCard(card);
        if (imageUrl && !isDefaultOrLogoHeadshot(imageUrl)) {
          setPairedParam(url, "headshotUrl", "headshot_url", imageUrl);
        }

        if (selectableCompanionCount > 1) {
          const returnUrl = buildCompanionListReturnUrl(brand);
          url.searchParams.set("returnToCompanions", "1");
          url.searchParams.set("return_to_companions", "1");
          setPairedParam(url, "companionCount", "companion_count", String(selectableCompanionCount));
          setPairedParam(
            url,
            "selectableCompanionCount",
            "selectable_companion_count",
            String(selectableCompanionCount),
          );
          if (returnUrl) setPairedParam(url, "companionListUrl", "companion_list_url", returnUrl);
        }

        const passthrough: Array<[string, string[]]> = [
          ["planName", ["planName", "plan_name", "plan"]],
          ["subscriptionTier", ["subscriptionTier", "subscription_tier"]],
          ["entitlementTier", ["entitlementTier", "entitlement_tier"]],
          ["planStart", ["planStart", "plan_start"]],
          ["planEnd", ["planEnd", "plan_end"]],
          ["freeMinutes", ["freeMinutes", "free_minutes"]],
          ["includedMinutes", ["includedMinutes", "included_minutes"]],
          ["remainingMinutes", ["remainingMinutes", "remaining_minutes"]],
          ["modePill", ["modePill", "mode_pill"]],
          ["rebrandingKey", ["rebrandingKey", "rebranding_key"]],
          ["homeLink", ["homeLink", "home_link"]],
          ["upgradeLink", ["upgradeLink", "upgrade_link"]],
          ["payGoLink", ["payGoLink", "pay_go_link", "paygoLink", "paygo_link"]],
          ["faqLink", ["faqLink", "faq_link"]],
          ["spotlightLink", ["spotlightLink", "spotlight_link"]],
          ["friendAllowed", ["friendAllowed", "friend_allowed"]],
          ["romanticAllowed", ["romanticAllowed", "romantic_allowed"]],
          ["intimateAllowed", ["intimateAllowed", "intimate_allowed"]],
          ["hostEnabled", ["hostEnabled", "host_enabled"]],
          ["emailEnabled", ["emailEnabled", "email_enabled"]],
          ["paygEnabled", ["paygEnabled", "payg_enabled"]],
          ["paygPriceCents", ["paygPriceCents", "payg_price_cents"]],
          ["paygMinutes", ["paygMinutes", "payg_minutes", "PAYG_INCREMENT_MINUTES"]],
          ["brandId", ["brandId", "brand_id"]],
          ["email", ["email"]],
        ];
        for (const [target, sources] of passthrough) {
          const value = firstPayloadValue(memberPayload, sources);
          if (value) url.searchParams.set(target, value);
        }

        const normalizedBrand = safeLower(brand).replace(/[^a-z0-9]+/g, "");
        const hasPaidPlan = payloadHasPaidPlan(memberPayload);
        if (["elaralo", "aihaven4u", "aihaven"].includes(normalizedBrand) && !hasPaidPlan) {
          if (!url.searchParams.get("planName")) url.searchParams.set("planName", ELARALO_TRIAL_PLAN_NAME);
          if (!url.searchParams.get("plan_name")) url.searchParams.set("plan_name", ELARALO_TRIAL_PLAN_NAME);
          const trialMinutesOverride = ["aihaven4u", "aihaven"].includes(normalizedBrand)
            ? AIHAVEN4U_TRIAL_MINUTES_QUERY_OVERRIDE
            : ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE;
          if (trialMinutesOverride) {
            setPairedParam(url, "freeMinutes", "free_minutes", trialMinutesOverride);
            setPairedParam(url, "includedMinutes", "included_minutes", trialMinutesOverride);
          }
          const defaultTrialMode = normalizedBrand === "elaralo" ? "Grow" : "Start";
          if (!url.searchParams.get("modePill")) url.searchParams.set("modePill", defaultTrialMode);
          if (!url.searchParams.get("mode_pill")) url.searchParams.set("mode_pill", defaultTrialMode);
        }

        // Preserve any server-provided direct Connect metadata not already mapped.
        for (const [sourceKey, targetKey] of [
          ["versionId", "versionId"],
          ["version_id", "version_id"],
          ["hostMemberId", "hostMemberId"],
          ["host_member_id", "host_member_id"],
        ] as const) {
          const value = safeText(raw[sourceKey] || memberPayload[sourceKey]);
          if (value) url.searchParams.set(targetKey, value);
        }

        window.location.assign(url.toString());
      } catch {
        // Keep the selector usable if URL construction fails.
      }
    },
    [
      anonymousId,
      brandName,
      displayName,
      imageUrlForCard,
      isAIHaven4UBrand,
      loggedIn,
      memberId,
      memberPayload,
      selectableCompanionCount,
    ],
  );

  const openSummaryPublic = useCallback(
    (card: CompanionCardItem): void => {
      const companionKey = canonicalCompanionKeyForCard(card);
      const brand = safeText(card.brand) || brandName || "Elaralo";
      const fallback = `/summary-public?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(companionKey || card.avatar)}`;
      const url = resolveButtonUrl(card.summaryPublicUrl, fallback);
      if (!url) return;

      url.searchParams.set("brand", url.searchParams.get("brand") || brand);
      url.searchParams.set("loggedIn", loggedIn ? "1" : "0");
      url.searchParams.set("logged_in", loggedIn ? "1" : "0");
      if (memberId) setPairedParam(url, "memberId", "member_id", memberId);
      if (anonymousId) setPairedParam(url, "anonymousId", "anonymous_id", anonymousId);
      if (displayName) {
        url.searchParams.set("displayName", displayName);
        url.searchParams.set("userName", displayName);
      }
      if (selectableCompanionCount > 1) {
        const returnUrl = buildCompanionListReturnUrl(brand);
        url.searchParams.set("returnToCompanions", "1");
        url.searchParams.set("return_to_companions", "1");
        setPairedParam(url, "companionCount", "companion_count", String(selectableCompanionCount));
        setPairedParam(
          url,
          "selectableCompanionCount",
          "selectable_companion_count",
          String(selectableCompanionCount),
        );
        if (returnUrl) setPairedParam(url, "companionListUrl", "companion_list_url", returnUrl);
      }
      const hasVersion = Boolean(url.searchParams.get("versionId") || url.searchParams.get("version_id"));
      if (!hasVersion && companionKey) {
        url.searchParams.set("avatar", companionKey);
        url.searchParams.set("companion", companionKey);
        setPairedParam(url, "companionKey", "companion_key", companionKey);
      }

      try {
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      } catch {
        // Opening a public card is best effort.
      }
    },
    [anonymousId, brandName, displayName, loggedIn, memberId, selectableCompanionCount],
  );

  useEffect(() => {
    if (loading || error || autoOpenedSingleRef.current) return;
    if (selectableCompanionCount !== 1 || !autoOpenCard) return;
    autoOpenedSingleRef.current = true;
    const timer = window.setTimeout(() => openConnect(autoOpenCard), 80);
    return () => window.clearTimeout(timer);
  }, [autoOpenCard, error, loading, openConnect, selectableCompanionCount]);

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#f5f7fb",
    color: "#0f172a",
    fontFamily: "Inter, Arial, sans-serif",
  };
  const shellStyle: React.CSSProperties = {
    maxWidth: 1280,
    margin: "0 auto",
    padding: "28px 20px 48px",
  };
  const heroStyle: React.CSSProperties = {
    background: "#fff",
    border: "1px solid rgba(15,23,42,0.08)",
    borderRadius: 22,
    padding: 24,
    boxShadow: "0 14px 40px rgba(15,23,42,0.06)",
    marginBottom: 20,
  };
  const filtersStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    marginTop: 18,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    color: "#334155",
    marginBottom: 6,
    display: "block",
  };
  const selectStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(15,23,42,0.14)",
    padding: "10px 12px",
    background: "#fff",
    fontSize: 14,
  };
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 16,
  };
  const cardStyle: React.CSSProperties = {
    background: "#fff",
    border: "1px solid rgba(15,23,42,0.08)",
    borderRadius: 22,
    overflow: "hidden",
    boxShadow: "0 16px 34px rgba(15,23,42,0.06)",
    display: "flex",
    flexDirection: "column",
    minHeight: 420,
  };
  const imageButtonStyle: React.CSSProperties = {
    border: 0,
    padding: 0,
    margin: 0,
    background: "#f8fafc",
    cursor: "pointer",
    display: "block",
  };
  const pillStyle = (text: string): React.CSSProperties => ({
    display: text ? "inline-flex" : "none",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    background: "rgba(15,23,42,0.06)",
    color: "#1e293b",
  });

  const catalogNoun = isAIHaven4UBrand ? "Representatives" : "companions";
  const catalogNounSingular = isAIHaven4UBrand ? "Representative" : "Companion";

  return (
    <div style={containerStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              alignItems: "flex-start",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  color: "#64748b",
                  textTransform: "uppercase",
                  marginBottom: 10,
                }}
              >
                {isAIHaven4UBrand
                  ? "My Haven"
                  : brandName && safeLower(brandName) !== "elaralo"
                    ? brandName
                    : "My Elaralo"}
              </div>
              <h1 style={{ margin: 0, fontSize: 42, lineHeight: 1.08 }}>
                {isAIHaven4UBrand ? "Choose your Representative" : "Choose your Companion"}
              </h1>
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 16,
                  lineHeight: 1.6,
                  maxWidth: 840,
                  color: "#475569",
                }}
              >
                {isAIHaven4UBrand
                  ? "Filter the published Representatives, review each Representative Card, then choose one to continue into Connect."
                  : "Filter AI and Human companions, review each Companion Card, then choose one to continue into Connect."}
              </p>
            </div>
            <div style={{ minWidth: 220, textAlign: "right" }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 4 }}>Member session</div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>{sessionDisplayName}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
                {brandName || "Elaralo"}
              </div>
            </div>
          </div>

          <div style={filtersStyle}>
            <div>
              <label style={labelStyle}>Interplay</label>
              <select
                style={selectStyle}
                value={companionTypeFilter}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setCompanionTypeFilter(event.target.value)}
              >
                <option value="">All</option>
                {companionTypeOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Generation</label>
              <select
                style={selectStyle}
                value={generationFilter}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setGenerationFilter(event.target.value)}
              >
                <option value="">All</option>
                {generationOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Ethnicity</label>
              <select
                style={selectStyle}
                value={ethnicityFilter}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setEthnicityFilter(event.target.value)}
              >
                <option value="">All</option>
                {ethnicityOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Gender</label>
              <select
                style={selectStyle}
                value={genderFilter}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setGenderFilter(event.target.value)}
              >
                <option value="">All</option>
                {genderOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {loading ? (
          <section style={heroStyle}>
            <div style={{ fontSize: 16, color: "#475569" }}>Loading {catalogNoun}...</div>
          </section>
        ) : error ? (
          <section
            style={{
              ...heroStyle,
              borderColor: "rgba(239,68,68,0.25)",
              background: "rgba(254,242,242,0.9)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>
              Unable to load {catalogNoun}
            </div>
            <div style={{ fontSize: 14, color: "#7f1d1d" }}>{error}</div>
          </section>
        ) : selectableCompanionCount === 0 ? (
          <section style={heroStyle}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
              No {catalogNoun} are currently available.
            </div>
            <div style={{ fontSize: 14, color: "#475569" }}>
              Please check back after entries have been published for this brand.
            </div>
          </section>
        ) : filteredCards.length === 0 ? (
          <section style={heroStyle}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
              No {catalogNoun} matched these filters.
            </div>
            <div style={{ fontSize: 14, color: "#475569" }}>
              Adjust or clear the filters to view the available entries.
            </div>
          </section>
        ) : (
          <section style={gridStyle}>
            {filteredCards.map((card) => {
              const companionKey = canonicalCompanionKeyForCard(card);
              const canOpenConnect = Boolean(companionKey);
              const connectButtonLabel = `Connect with ${firstNameFromDisplayName(card.displayName)}`;
              const canViewSummary = Boolean(companionKey || card.summaryPublicUrl);
              const metadataLines = [card.gender, card.ethnicity, card.generation].filter(Boolean);
              const summaryLine = firstLine(card.shortSummary);

              return (
                <article key={card.id} style={cardStyle}>
                  <button
                    type="button"
                    style={imageButtonStyle}
                    onClick={() => openConnect(card)}
                    title={connectButtonLabel}
                    disabled={!canOpenConnect}
                  >
                    <img
                      src={imageUrlForCard(card)}
                      alt={card.displayName || catalogNounSingular}
                      style={{
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "cover",
                        display: "block",
                        background: "#e2e8f0",
                      }}
                      onError={(event: React.SyntheticEvent<HTMLImageElement>) => {
                        const image = event.currentTarget;
                        if (image.src !== DEFAULT_HEADSHOT) image.src = DEFAULT_HEADSHOT;
                      }}
                    />
                  </button>
                  <div
                    style={{
                      padding: 18,
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                      flex: 1,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "flex-start",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 24, lineHeight: 1.15, fontWeight: 800 }}>
                          {card.displayName || catalogNounSingular}
                        </div>
                        {summaryLine ? (
                          <div style={{ fontSize: 14, color: "#475569", marginTop: 6 }}>
                            {summaryLine}
                          </div>
                        ) : null}
                      </div>
                      <span style={pillStyle(card.companionType)}>{card.companionType || ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {metadataLines.map((line) => (
                        <span key={`${card.id}:${line}`} style={pillStyle(line)}>
                          {line}
                        </span>
                      ))}
                    </div>
                    <div style={{ marginTop: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => openConnect(card)}
                        disabled={!canOpenConnect}
                        style={{
                          borderRadius: 14,
                          border: 0,
                          background: canOpenConnect ? "#0f172a" : "#94a3b8",
                          color: "#fff",
                          padding: "12px 16px",
                          fontWeight: 800,
                          cursor: canOpenConnect ? "pointer" : "not-allowed",
                        }}
                      >
                        {connectButtonLabel}
                      </button>
                      <button
                        type="button"
                        onClick={() => openSummaryPublic(card)}
                        disabled={!canViewSummary}
                        style={{
                          borderRadius: 14,
                          border: "1px solid rgba(15,23,42,0.14)",
                          background: "#fff",
                          color: "#0f172a",
                          padding: "12px 16px",
                          fontWeight: 800,
                          cursor: canViewSummary ? "pointer" : "not-allowed",
                        }}
                      >
                        {isAIHaven4UBrand ? "View Representative Card" : "View Companion Card"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
