"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
// v9.2.21: honor payloadPending/waitForPayload so DulceMoon paid members do not auto-open as Trial before Wix plan payload arrives.

type MemberPlanPayload = {
  loggedIn?: boolean;
  logged_in?: boolean;
  memberId?: string;
  member_id?: string;
  displayName?: string;
  display_name?: string;
  userName?: string;
  user_name?: string;
  email?: string;
  brand?: string;
  avatar?: string;
  [k: string]: any;
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
  raw: any;
};

type CatalogResponse = {
  ok?: boolean;
  brand?: string;
  member_id?: string;
  count?: number;
  items?: any[];
  detail?: string;
  message?: string;
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
const APP_BASE = String(process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(/\/+$/, "");
const DEFAULT_HEADSHOT = "/elaralo-logo.png";
const ELARALO_TRIAL_PLAN_NAME = "Trial";
// v9.2.47: Elaralo Trial minutes are backend-configurable.
// Do not send a hardcoded 10-minute override unless an explicit query/env override is supplied.
const ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE = String(
  process.env.NEXT_PUBLIC_ELARALO_TRIAL_MINUTES || process.env.NEXT_PUBLIC_TRIAL_MINUTES_ELARALO || ""
).trim();

function safeText(value: any): string {
  return String(value ?? "").trim();
}

function firstNameFromDisplayName(value: any): string {
  const text = safeText(value).replace(/\s+/g, " ");
  if (!text) return "Companion";
  return text.split(" ")[0] || text;
}

function safeLower(value: any): string {
  return safeText(value).toLowerCase();
}

function payloadHasPaidPlan(payload: MemberPlanPayload): boolean {
  const raw = safeText((payload as any)?.planName || (payload as any)?.plan_name || (payload as any)?.plan);
  if (!raw) return false;
  const normalized = raw
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/[-–—_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*membership\s*$/i, "")
    .replace(/^test\s+/i, "")
    .trim()
    .toLowerCase();
  return !["", "trial", "free trial", "free", "none", "no plan", "unknown", "not provided", "pay as you go"].includes(normalized);
}

function isAnonMemberId(value: any): boolean {
  return safeLower(value).startsWith("anon:");
}

function stripAvatarCollisionSuffix(value: any): string {
  return safeText(value).replace(/-\d{9}$/, "");
}

function toTitle(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ""))
    .join(" ")
    .trim();
}

function normalizeCompanionType(value: any): string {
  const raw = safeLower(value);
  if (!raw) return "";
  if (raw === "human" || raw === "human_companion") return "Human";
  if (raw === "ai" || raw === "ai_companion") return "AI";
  return toTitle(raw.replace(/[_-]+/g, " "));
}

function parseList(value: any): string[] {
  if (Array.isArray(value)) return value.map((x) => safeText(x)).filter(Boolean);
  const text = safeText(value);
  if (!text) return [];
  return text
    .split(/\n|,|•|\|/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function readQueryContext(): MemberPlanPayload {
  if (typeof window === "undefined") return {};
  try {
    const qs = new URLSearchParams(window.location.search || "");
    return {
      loggedIn: ["1", "true", "yes"].includes(safeLower(qs.get("loggedIn") || qs.get("logged_in"))),
      memberId: safeText(qs.get("memberId") || qs.get("member_id")),
      displayName: safeText(qs.get("displayName") || qs.get("display_name") || qs.get("userName") || qs.get("user_name")),
      email: safeText(qs.get("email")),
      brand: safeText(qs.get("brand")),
      avatar: safeText(qs.get("avatar")),
    };
  } catch {
    return {};
  }
}

function readQueryFlag(...names: string[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    const qs = new URLSearchParams(window.location.search || "");
    for (const name of names) {
      const raw = safeLower(qs.get(name));
      if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}


function mergeMemberPayload(prev: MemberPlanPayload, incoming: MemberPlanPayload): MemberPlanPayload {
  return {
    ...prev,
    ...incoming,
    loggedIn: Boolean(incoming.loggedIn ?? incoming.logged_in ?? prev.loggedIn ?? prev.logged_in),
    memberId: safeText(incoming.memberId || incoming.member_id || prev.memberId || prev.member_id),
    displayName: safeText(
      incoming.displayName || incoming.display_name || incoming.userName || incoming.user_name || prev.displayName || prev.display_name || prev.userName || prev.user_name,
    ),
    email: safeText(incoming.email || prev.email),
    brand: safeText(incoming.brand || prev.brand),
    avatar: safeText(incoming.avatar || prev.avatar),
  };
}

function normalizeCard(item: any, defaultBrand: string): CompanionCardItem {
  const rawDisplayName =
    safeText(item?.display_name) ||
    safeText(item?.displayName) ||
    safeText(item?.public_name) ||
    safeText(item?.publicName) ||
    safeText(item?.name) ||
    safeText(item?.first_name) ||
    safeText(item?.firstName) ||
    safeText(item?.avatar) ||
    "Companion";
  const displayName = stripAvatarCollisionSuffix(rawDisplayName) || "Companion";
  const avatar =
    safeText(item?.avatar) ||
    safeText(item?.companion) ||
    safeText(item?.companion_key) ||
    safeText(item?.companionKey) ||
    safeText(item?.slug);
  const brand = safeText(item?.brand) || defaultBrand || "Elaralo";
  const headshotUrl =
    safeText(item?.headshot_url) ||
    safeText(item?.headshotUrl) ||
    safeText(item?.image_url) ||
    safeText(item?.imageUrl) ||
    safeText(item?.photo_url) ||
    safeText(item?.photoUrl) ||
    DEFAULT_HEADSHOT;
  const summaryPublicUrl =
    safeText(item?.summary_public_url) ||
    safeText(item?.summaryPublicUrl) ||
    (avatar
      ? `${APP_BASE || ""}/summary-public?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(avatar)}`
      : "");
  const id =
    safeText(item?.id) ||
    safeText(item?.companion_id) ||
    safeText(item?.companionId) ||
    safeText(item?.member_id) ||
    safeText(item?.memberId) ||
    `${brand}:${avatar || displayName}`;
  return {
    id,
    companionType: normalizeCompanionType(item?.companion_type || item?.companionType),
    displayName,
    brand,
    avatar,
    headshotUrl,
    summaryPublicUrl,
    gender: safeText(item?.gender),
    ethnicity:
      safeText(item?.companion_catalog_ethnicity) ||
      safeText(item?.companionCatalogEthnicity) ||
      safeText(item?.race_label) ||
      safeText(item?.raceLabel) ||
      safeText(item?.race) ||
      safeText(item?.ethnicity),
    generation:
      safeText(item?.generation) ||
      safeText(item?.generation_label) ||
      safeText(item?.generationLabel),
    shortSummary:
      safeText(item?.summary) || safeText(item?.short_summary) || safeText(item?.shortSummary) || safeText(item?.tagline),
    catalogHidden: Boolean(item?.catalog_hidden || item?.hidden || item?.is_hidden || item?.isHidden),
    listInCompanionCatalog: Boolean(item?.list_in_companion_catalog ?? item?.listInCompanionCatalog ?? item?.catalog_visible ?? item?.catalogVisible),
    raw: item,
  };
}


function isDefaultOrLogoHeadshot(value: any): boolean {
  const raw = safeText(value);
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower === DEFAULT_HEADSHOT.toLowerCase() || /(^|\/)elaralo-logo\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(lower);
}

function firstMeaningfulImageUrl(...values: any[]): string {
  for (const value of values) {
    const text = safeText(value);
    if (!text) continue;
    if (isDefaultOrLogoHeadshot(text)) continue;
    return text;
  }
  return "";
}

function companionKeyFirstToken(value: any): string {
  const raw = safeText(value)
    .split("?", 1)[0]
    .split("#", 1)[0]
    .replace(/^.*[\\/]/, "")
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .trim();
  const first = safeText(raw.split("-", 1)[0]);
  return first;
}

function payloadCompanionKey(payload: MemberPlanPayload): string {
  const p = payload && typeof payload === "object" ? payload : {};
  return (
    safeText((p as any).companionKey) ||
    safeText((p as any).companion_key) ||
    safeText((p as any).selectedCompanionKey) ||
    safeText((p as any).selected_companion_key) ||
    safeText((p as any).companion) ||
    safeText((p as any).companionName) ||
    safeText((p as any).companion_name) ||
    safeText((p as any).avatar) ||
    safeText((p as any).avatarName) ||
    safeText((p as any).avatar_name)
  );
}

function payloadMappingAvatar(payload: MemberPlanPayload): string {
  const p = payload && typeof payload === "object" ? payload : {};
  return (
    safeText((p as any).mappingAvatar) ||
    safeText((p as any).mapping_avatar) ||
    safeText((p as any).sqlAvatar) ||
    safeText((p as any).sql_avatar) ||
    safeText((p as any).avatar) ||
    safeText((p as any).avatarName) ||
    safeText((p as any).avatar_name) ||
    companionKeyFirstToken(payloadCompanionKey(payload))
  );
}

function payloadHeadshotUrl(payload: MemberPlanPayload): string {
  const p = payload && typeof payload === "object" ? payload : {};
  return firstMeaningfulImageUrl(
    (p as any).headshotUrl,
    (p as any).headshot_url,
    (p as any).imageUrl,
    (p as any).image_url,
    (p as any).photoUrl,
    (p as any).photo_url,
    (p as any).avatarUrl,
    (p as any).avatar_url
  );
}

function cardMatchesPayloadCompanion(card: CompanionCardItem | null | undefined, payload: MemberPlanPayload): boolean {
  if (!card) return false;
  const key = canonicalCompanionKeyForCard(card);
  const mappingAvatar = companionMappingAvatarForCard(card);
  const displayName = companionDisplayNameForCard(card);
  const payloadKey = payloadCompanionKey(payload);
  const payloadMapping = payloadMappingAvatar(payload);
  const candidates = [key, mappingAvatar, displayName, card.avatar, (card.raw || {}).avatar, (card.raw || {}).companion_key, (card.raw || {}).companionKey]
    .map((v) => safeLower(v))
    .filter(Boolean);
  const incoming = [payloadKey, payloadMapping, companionKeyFirstToken(payloadKey)]
    .map((v) => safeLower(v))
    .filter(Boolean);
  if (!incoming.length) return false;
  return incoming.some((v) => candidates.includes(v));
}

function firstLine(text: string): string {
  const t = safeText(text);
  if (!t) return "";
  const line = t.split(/\n+/)[0]?.trim() || "";
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function canonicalCompanionKeyForCard(card: CompanionCardItem | null | undefined): string {
  const raw = (card?.raw && typeof card.raw === "object") ? card.raw : {};
  return (
    safeText(raw?.companion_key) ||
    safeText(raw?.companionKey) ||
    safeText(raw?.avatar_key) ||
    safeText(raw?.avatarKey) ||
    safeText(card?.avatar) ||
    safeText(raw?.avatar) ||
    safeText(raw?.companion) ||
    safeText(raw?.slug)
  );
}

function companionDisplayNameForCard(card: CompanionCardItem | null | undefined): string {
  const key = canonicalCompanionKeyForCard(card);
  const raw = (card?.raw && typeof card.raw === "object") ? card.raw : {};
  return stripAvatarCollisionSuffix(
    safeText(card?.displayName) ||
      safeText(raw?.display_name) ||
      safeText(raw?.displayName) ||
      safeText(raw?.name) ||
      key.split("-", 1)[0] ||
      "Companion",
  );
}

function companionMappingAvatarForCard(card: CompanionCardItem | null | undefined): string {
  const raw = (card?.raw && typeof card.raw === "object") ? card.raw : {};
  const companionKey = canonicalCompanionKeyForCard(card);
  const ctype = safeLower(card?.companionType || raw?.companion_type || raw?.companionType);
  const explicitMappingAvatar =
    safeText(raw?.mapping_avatar) ||
    safeText(raw?.mappingAvatar) ||
    safeText(raw?.sql_avatar) ||
    safeText(raw?.sqlAvatar);
  if (explicitMappingAvatar) return explicitMappingAvatar;
  if (ctype === "ai") return companionDisplayNameForCard(card) || companionKey;
  return safeText(card?.avatar) || safeText(raw?.avatar) || companionKey;
}

function resolveButtonUrl(rawTarget: string, fallbackPath: string): URL | null {
  if (typeof window === "undefined") return null;
  const target = safeText(rawTarget) || fallbackPath;
  if (!target) return null;
  const base = safeText(APP_BASE) || window.location.origin;
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

    // Returning from Connect should show the list and must not immediately
    // auto-open the same single human companion again.
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
      const base = safeText(APP_BASE) || window.location.origin;
      const url = new URL("/my-elaralo", base);
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


export default function MyElaraloCompanionSelectorClient() {
  const [memberPayload, setMemberPayload] = useState<MemberPlanPayload>(() => readQueryContext());
  const [cards, setCards] = useState<CompanionCardItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [companionTypeFilter, setCompanionTypeFilter] = useState<string>("");
  const [generationFilter, setGenerationFilter] = useState<string>("");
  const [ethnicityFilter, setEthnicityFilter] = useState<string>("");
  const [genderFilter, setGenderFilter] = useState<string>("");
  const [externalPayloadSeen, setExternalPayloadSeen] = useState<boolean>(false);
  const [contextGraceElapsed, setContextGraceElapsed] = useState<boolean>(false);
  const autoOpenedSingleRef = useRef<boolean>(false);
  const autoOpenSingle = useMemo(() => readQueryFlag("autoOpenSingle", "auto_open_single", "autoOpen", "auto_open"), []);
  const forceSelector = useMemo(() => readQueryFlag("forceSelector", "force_selector", "showSelector", "show_selector", "showCompanionList", "show_companion_list"), []);
  const payloadPending = useMemo(() => readQueryFlag("payloadPending", "payload_pending", "waitForPayload", "wait_for_payload"), []);
  const [payloadPendingGraceElapsed, setPayloadPendingGraceElapsed] = useState<boolean>(!payloadPending);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const data: any = event?.data || {};
        const type = safeText(data?.type);
        // Wix Website Address iframes commonly post MEMBER_PLAN fields at the
        // top level, while the Elaralo HTML bridge can wrap them in data.payload.
        // Accept both shapes.  This is required for DulceMoon, whose Wix page
        // posts { type: "MEMBER_PLAN", memberId, brand, ... } directly.
        const directPayload = data && typeof data === "object" ? data : {};
        const nestedPayload = directPayload?.payload && typeof directPayload.payload === "object" ? directPayload.payload : null;
        const payload = (type === "MEMBER_PLAN" ? (nestedPayload || directPayload) : directPayload) || {};
        if (type === "MEMBER_PLAN" || type === "MY_ELARALO_CONTEXT" || payload?.memberId || payload?.member_id) {
          setExternalPayloadSeen(true);
          setMemberPayload((prev) => mergeMemberPayload(prev, payload));
          try {
            window.parent?.postMessage({ type: "MY_ELARALO_CONTEXT_ACK" }, "*");
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener("message", handler);
    try {
      window.parent?.postMessage({ type: "REQUEST_MEMBER_PLAN" }, "*");
      window.parent?.postMessage({ type: "MY_ELARALO_CONTEXT_REQUEST" }, "*");
    } catch {
      // ignore
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

  const memberId = safeText(memberPayload.memberId || memberPayload.member_id);
  const displayName = safeText(memberPayload.displayName || memberPayload.display_name || memberPayload.userName || memberPayload.user_name);
  const loggedIn = Boolean(memberPayload.loggedIn ?? memberPayload.logged_in);
  const brandName = safeText(memberPayload.brand) || "Elaralo";
  const brandKey = safeLower(brandName || "Elaralo").replace(/[^a-z0-9]+/g, "");
  const isElaraloCoreBrand = brandKey === "elaralo";
  // DulceMoon should behave like the Elaralo companion architecture while
  // preserving the current product UX: when there is only one visible
  // companion, open Connect directly for both members and visitors.
  const shouldAutoOpenSingle = !forceSelector && (autoOpenSingle || (!isElaraloCoreBrand && brandKey === "dulcemoon"));
  const sessionDisplayName = displayName || (memberId && !isAnonMemberId(memberId) ? memberId : "");

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (payloadPending && !externalPayloadSeen && !payloadPendingGraceElapsed) {
        // The Wix parent is still resolving the member/plan payload.  Do not
        // auto-open a single companion as Trial until the paid-plan context has
        // had a chance to arrive.  This is especially important for DulceMoon
        // legacy Host plans such as Test - Exclusive.
        setError("");
        setLoading(true);
        return;
      }

      if (!memberId) {
        // v9.2.17: Elaralo visitors are allowed to browse/select companions and
        // enter Connect using the brand-level free-minute allowance.  If Wix says
        // the viewer is logged in but member context has not arrived yet, wait
        // briefly; otherwise treat the request as a visitor/free-trial session.
        if (isElaraloCoreBrand && loggedIn && !externalPayloadSeen && !contextGraceElapsed) {
          setError("");
          setLoading(true);
          return;
        }
        // White-label brands such as DulceMoon must support visitor/free-trial
        // access.  When auto-opening a single companion, briefly wait for the
        // Wix MEMBER_PLAN payload so the Connect handoff carries plan minutes,
        // mode entitlement, rebrandingKey, and member/visitor identity.
        if (shouldAutoOpenSingle && !externalPayloadSeen && !contextGraceElapsed) {
          setError("");
          setLoading(true);
          return;
        }
      }

      setLoading(true);
      setError("");

      try {
        const qs = new URLSearchParams();
        if (memberId) qs.set("memberId", memberId);
        qs.set("brand", brandName || "Elaralo");
        const res = await fetch(`${API_BASE}/my-elaralo/companions/catalog?${qs.toString()}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        const data = (await res.json().catch(() => ({} as any))) as CatalogResponse;
        if (!res.ok || !Array.isArray(data?.items)) {
          throw new Error(String(data?.detail || data?.message || `HTTP ${res.status}`));
        }
        if (cancelled) return;
        setCards((data.items || []).map((item) => normalizeCard(item, safeText(data.brand) || brandName || "Elaralo")));
      } catch (err: any) {
        if (cancelled) return;
        setError(String(err?.message || "Unable to load companions."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [API_BASE, brandName, contextGraceElapsed, externalPayloadSeen, isElaraloCoreBrand, loggedIn, memberId, payloadPending, payloadPendingGraceElapsed, shouldAutoOpenSingle]);

  const companionTypeOptions = useMemo(() => Array.from(new Set(cards.map((card) => card.companionType).filter(Boolean))).sort(), [cards]);
  const generationOptions = useMemo(() => Array.from(new Set(cards.map((card) => card.generation).filter(Boolean))).sort(), [cards]);
  const ethnicityOptions = useMemo(() => Array.from(new Set(cards.map((card) => card.ethnicity).filter(Boolean))).sort(), [cards]);
  const genderOptions = useMemo(() => Array.from(new Set(cards.map((card) => card.gender).filter(Boolean))).sort(), [cards]);

  const filteredCards = useMemo(() => {
    return cards.filter((card) => {
      if (companionTypeFilter && safeLower(card.companionType) !== safeLower(companionTypeFilter)) return false;
      if (generationFilter && safeLower(card.generation) !== safeLower(generationFilter)) return false;
      if (ethnicityFilter && safeLower(card.ethnicity) !== safeLower(ethnicityFilter)) return false;
      if (genderFilter && safeLower(card.gender) !== safeLower(genderFilter)) return false;
      return true;
    });
  }, [cards, companionTypeFilter, ethnicityFilter, genderFilter, generationFilter]);

  const companionPayloadHeadshotUrl = useMemo(() => payloadHeadshotUrl(memberPayload), [memberPayload]);
  const selectableCompanionCount = useMemo(() => cards.length, [cards]);

  const autoOpenCard = useMemo(() => {
    if (!shouldAutoOpenSingle) return null;
    const visibleCards = filteredCards.filter((card) => !card.catalogHidden);
    if (visibleCards.length === 1) return visibleCards[0];

    // DulceMoon product rule: while only one Human companion exists for the
    // brand, open that Human companion directly for both members and visitors.
    // This keeps the current one-companion DulceMoon UX while still allowing a
    // selector when more visible Human companions are added later.
    if (brandKey === "dulcemoon") {
      const visibleHumans = visibleCards.filter((card) => safeLower(card.companionType) === "human");
      if (visibleHumans.length === 1) return visibleHumans[0];
    }

    return null;
  }, [brandKey, filteredCards, shouldAutoOpenSingle]);

  const imageUrlForCard = useCallback(
    (card: CompanionCardItem) => {
      const raw = (card?.raw && typeof card.raw === "object") ? card.raw : {};
      const fromCard = firstMeaningfulImageUrl(
        card?.headshotUrl,
        raw?.headshot_url,
        raw?.headshotUrl,
        raw?.image_url,
        raw?.imageUrl,
        raw?.photo_url,
        raw?.photoUrl
      );
      if (fromCard) return fromCard;
      if (companionPayloadHeadshotUrl && cardMatchesPayloadCompanion(card, memberPayload)) return companionPayloadHeadshotUrl;
      return DEFAULT_HEADSHOT;
    },
    [companionPayloadHeadshotUrl, memberPayload],
  );

  const openConnect = useCallback(
    (card: CompanionCardItem) => {
      const companionKey = canonicalCompanionKeyForCard(card);
      if (!companionKey) return;
      try {
        const raw = (card?.raw && typeof card.raw === "object") ? card.raw : {};
        const brand = safeText(card.brand) || brandName || "Elaralo";
        const companionDisplayName = companionDisplayNameForCard(card);
        const configuredConnectUrl = safeText((process.env.NEXT_PUBLIC_CONNECT_URL as any) || (process.env.NEXT_PUBLIC_CONNECT_BASE_URL as any));
        const url = resolveButtonUrl(configuredConnectUrl, "/");
        if (!url) return;

        url.searchParams.set("source", "my-elaralo");
        url.searchParams.set("loggedIn", loggedIn ? "1" : "0");
        if (selectableCompanionCount > 1) {
          const returnUrl = buildCompanionListReturnUrl(brand);
          if (returnUrl) {
            url.searchParams.set("returnToCompanions", "1");
            url.searchParams.set("return_to_companions", "1");
            url.searchParams.set("companionListUrl", returnUrl);
            url.searchParams.set("companion_list_url", returnUrl);
          }
          url.searchParams.set("companionCount", String(selectableCompanionCount));
          url.searchParams.set("companion_count", String(selectableCompanionCount));
          url.searchParams.set("selectableCompanionCount", String(selectableCompanionCount));
          url.searchParams.set("selectable_companion_count", String(selectableCompanionCount));
        }
        if (memberId) {
          url.searchParams.set("memberId", memberId);
          url.searchParams.set("member_id", memberId);
        }
        if (displayName) {
          url.searchParams.set("displayName", displayName);
          url.searchParams.set("userName", displayName);
        }
        url.searchParams.set("brand", brand);
        url.searchParams.set("rebranding", brand);

        // Connect uses avatar/companionName for the companion_mappings SQL lookup.
        // The API can return mapping_avatar when companion_mappings.avatar has a
        // collision suffix such as Sera-000000001. Do not strip that value for lookup;
        // only display labels hide the suffix.
        const mappingAvatar = companionMappingAvatarForCard(card) || companionKey;
        url.searchParams.set("avatar", mappingAvatar);
        url.searchParams.set("avatarName", mappingAvatar);
        url.searchParams.set("avatar_name", mappingAvatar);
        url.searchParams.set("mappingAvatar", mappingAvatar);
        url.searchParams.set("mapping_avatar", mappingAvatar);
        url.searchParams.set("sqlAvatar", mappingAvatar);
        url.searchParams.set("sql_avatar", mappingAvatar);
        url.searchParams.set("companion", mappingAvatar);
        url.searchParams.set("companionName", mappingAvatar);
        url.searchParams.set("companion_name", mappingAvatar);
        url.searchParams.set("companionKey", companionKey);
        url.searchParams.set("companion_key", companionKey);
        url.searchParams.set("companionDisplayName", companionDisplayName);
        url.searchParams.set("companion_display_name", companionDisplayName);
        if (card.companionType) url.searchParams.set("companionType", card.companionType);
        const headshotUrl = imageUrlForCard(card);
        if (headshotUrl && !isDefaultOrLogoHeadshot(headshotUrl)) {
          url.searchParams.set("headshotUrl", headshotUrl);
          url.searchParams.set("headshot_url", headshotUrl);
          url.searchParams.set("imageUrl", headshotUrl);
          url.searchParams.set("image_url", headshotUrl);
          url.searchParams.set("photoUrl", headshotUrl);
          url.searchParams.set("photo_url", headshotUrl);
        }

        const passthroughParamMap: Array<[string, string[]]> = [
          ["planName", ["planName", "plan_name", "plan"]],
          ["plan_name", ["planName", "plan_name", "plan"]],
          ["rebrandingKey", ["rebrandingKey", "rebranding_key", "RebrandingKey", "rebrandingkey"]],
          ["rebranding_key", ["rebrandingKey", "rebranding_key", "RebrandingKey", "rebrandingkey"]],
          ["modePill", ["modePill", "mode_pill", "modepill"]],
          ["mode_pill", ["modePill", "mode_pill", "modepill"]],
          ["freeMinutes", ["freeMinutes", "free_minutes", "includedMinutes", "included_minutes"]],
          ["free_minutes", ["freeMinutes", "free_minutes", "includedMinutes", "included_minutes"]],
          ["cycleDays", ["cycleDays", "cycle_days"]],
          ["cycle_days", ["cycleDays", "cycle_days"]],
          ["upgradeUrl", ["upgradeUrl", "upgrade_url", "upgradeURL", "UPGRADE_URL"]],
          ["paygUrl", ["paygUrl", "payg_url", "paygURL", "PAYG_PAY_URL"]],
          ["paygPrice", ["paygPrice", "payg_price", "PAYG_PRICE"]],
          ["paygMinutes", ["paygMinutes", "payg_minutes", "PAYG_INCREMENT_MINUTES"]],
          ["brandId", ["brandId", "brand_id"]],
          ["email", ["email"]],
        ];
        for (const [target, sources] of passthroughParamMap) {
          const value = sources.map((key) => safeText((memberPayload as any)?.[key])).find(Boolean) || "";
          if (value) url.searchParams.set(target, value);
        }

        // v9.2.18: for Elaralo visitors OR logged-in members with no paid
        // plan, explicitly pass the Trial free-minute allowance into Connect
        // so the UI/session payload and backend usage logic agree from the
        // first turn.  The backend also enforces this by brand, so these query
        // params are a UX/bootstrap convenience, not the security source of truth.
        const brandKeyForConnect = safeLower(brand).replace(/[^a-z0-9]+/g, "");
        const hasPaidPlanForConnect = payloadHasPaidPlan(memberPayload);
        if (brandKeyForConnect === "elaralo" && !hasPaidPlanForConnect) {
          if (!url.searchParams.get("planName")) url.searchParams.set("planName", ELARALO_TRIAL_PLAN_NAME);
          if (!url.searchParams.get("plan_name")) url.searchParams.set("plan_name", ELARALO_TRIAL_PLAN_NAME);
          // Trial minutes are enforced by the backend per brand. Only pass an explicit
          // free-minute override if one was supplied to the app or build config.
          if (ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE) {
            if (!url.searchParams.get("freeMinutes")) url.searchParams.set("freeMinutes", ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE);
            if (!url.searchParams.get("free_minutes")) url.searchParams.set("free_minutes", ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE);
            if (!url.searchParams.get("includedMinutes")) url.searchParams.set("includedMinutes", ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE);
            if (!url.searchParams.get("included_minutes")) url.searchParams.set("included_minutes", ELARALO_TRIAL_MINUTES_QUERY_OVERRIDE);
          }
          if (!url.searchParams.get("modePill")) url.searchParams.set("modePill", "Mate");
          if (!url.searchParams.get("mode_pill")) url.searchParams.set("mode_pill", "Mate");
        }

        window.location.assign(url.toString());
      } catch {
        // ignore
      }
    },
    [brandName, displayName, imageUrlForCard, loggedIn, memberId, memberPayload, selectableCompanionCount],
  );

  const openSummaryPublic = useCallback((card: CompanionCardItem) => {
    const companionKey = canonicalCompanionKeyForCard(card);
    const brand = safeText(card.brand) || brandName || "Elaralo";
    const fallback = `/summary-public?brand=${encodeURIComponent(brand)}&avatar=${encodeURIComponent(companionKey || safeText(card.avatar))}`;
    const url = resolveButtonUrl(safeText(card.summaryPublicUrl), fallback);
    if (!url) return;

    url.searchParams.set("brand", url.searchParams.get("brand") || brand);
    url.searchParams.set("loggedIn", loggedIn ? "1" : "0");
    url.searchParams.set("logged_in", loggedIn ? "1" : "0");
    if (memberId) {
      url.searchParams.set("memberId", memberId);
      url.searchParams.set("member_id", memberId);
    }
    if (displayName) {
      url.searchParams.set("displayName", displayName);
      url.searchParams.set("userName", displayName);
    }
    if (selectableCompanionCount > 1) {
      const returnUrl = buildCompanionListReturnUrl(brand);
      url.searchParams.set("returnToCompanions", "1");
      url.searchParams.set("return_to_companions", "1");
      url.searchParams.set("companionCount", String(selectableCompanionCount));
      url.searchParams.set("companion_count", String(selectableCompanionCount));
      url.searchParams.set("selectableCompanionCount", String(selectableCompanionCount));
      url.searchParams.set("selectable_companion_count", String(selectableCompanionCount));
      if (returnUrl) {
        url.searchParams.set("companionListUrl", returnUrl);
        url.searchParams.set("companion_list_url", returnUrl);
      }
    }
    const hasVersion = Boolean(url.searchParams.get("versionId") || url.searchParams.get("version_id"));
    if (!hasVersion && companionKey) {
      url.searchParams.set("avatar", companionKey);
      url.searchParams.set("companion", companionKey);
      url.searchParams.set("companionKey", companionKey);
      url.searchParams.set("companion_key", companionKey);
    }

    try {
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // ignore
    }
  }, [brandName, displayName, loggedIn, memberId, selectableCompanionCount]);


  useEffect(() => {
    if (!shouldAutoOpenSingle || loading || error || autoOpenedSingleRef.current) return;
    if (!autoOpenCard) return;
    autoOpenedSingleRef.current = true;
    const timer = window.setTimeout(() => openConnect(autoOpenCard), 80);
    return () => window.clearTimeout(timer);
  }, [shouldAutoOpenSingle, autoOpenCard, error, loading, openConnect]);

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

  return (
    <div style={containerStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: ".08em", color: "#64748b", textTransform: "uppercase", marginBottom: 10 }}>
                {brandName && safeLower(brandName) !== "elaralo" ? brandName : "My Elaralo"}
              </div>
              <h1 style={{ margin: 0, fontSize: 42, lineHeight: 1.08 }}>Choose your Companion</h1>
              <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, maxWidth: 840, color: "#475569" }}>
                Filter AI and Human companions, review each Companion Card, then click a card to continue into Connect.
              </p>
            </div>
            <div style={{ minWidth: 220, textAlign: "right" }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 4 }}>Member session</div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>{sessionDisplayName}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>{brandName || "Elaralo"}</div>
            </div>
          </div>
          <div style={filtersStyle}>
            <div>
              <label style={labelStyle}>Companion Type</label>
              <select style={selectStyle} value={companionTypeFilter} onChange={(e) => setCompanionTypeFilter(e.target.value)}>
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
              <select style={selectStyle} value={generationFilter} onChange={(e) => setGenerationFilter(e.target.value)}>
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
              <select style={selectStyle} value={ethnicityFilter} onChange={(e) => setEthnicityFilter(e.target.value)}>
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
              <select style={selectStyle} value={genderFilter} onChange={(e) => setGenderFilter(e.target.value)}>
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
            <div style={{ fontSize: 16, color: "#475569" }}>Loading companions...</div>
          </section>
        ) : error ? (
          <section style={{ ...heroStyle, borderColor: "rgba(239,68,68,0.25)", background: "rgba(254,242,242,0.9)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>Unable to load {isElaraloCoreBrand ? "My Elaralo" : brandName} companions</div>
            <div style={{ fontSize: 14, color: "#7f1d1d" }}>{error}</div>
          </section>
        ) : filteredCards.length === 0 ? (
          <section style={heroStyle}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No companions matched these filters.</div>
            <div style={{ fontSize: 14, color: "#475569" }}>Adjust the filters or return after additional companions have been published.</div>
          </section>
        ) : (
          <section style={gridStyle}>
            {filteredCards.map((card) => {
              const companionKey = canonicalCompanionKeyForCard(card);
              const canOpenConnect = Boolean(companionKey);
              const connectButtonLabel = `Connect with ${firstNameFromDisplayName(card.displayName)}`;
              const canViewSummary = Boolean(companionKey || safeText(card.summaryPublicUrl));
              // Companion type already appears as the badge at the top-right of the
              // card.  Do not repeat "Human"/"AI" in the metadata chip row.
              const lines = [
                card.gender,
                card.ethnicity,
                card.generation,
              ].filter(Boolean);
              const summaryLine = firstLine(card.shortSummary);
              const isHiddenCard = Boolean(card.catalogHidden);
              return (
                <article key={card.id} style={cardStyle}>
                  <button type="button" style={imageButtonStyle} onClick={() => openConnect(card)} title={connectButtonLabel}>
                    <img
                      src={imageUrlForCard(card)}
                      alt={card.displayName || "Companion"}
                      style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block", background: "#e2e8f0" }}
                      onError={(e) => {
                        const img = e.currentTarget as HTMLImageElement;
                        if (img.src !== DEFAULT_HEADSHOT) img.src = DEFAULT_HEADSHOT;
                      }}
                    />
                  </button>
                  <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 24, lineHeight: 1.15, fontWeight: 800 }}>{card.displayName || "Companion"}</div>
                        {summaryLine ? <div style={{ fontSize: 14, color: "#475569", marginTop: 6 }}>{summaryLine}</div> : null}
                      </div>
                      <span style={pillStyle(card.companionType)}>{card.companionType || ""}</span>
                      {isHiddenCard ? <span style={{ ...pillStyle("Hidden"), background: "rgba(245,158,11,0.16)", color: "#92400e" }}>Hidden</span> : null}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {lines.map((line) => (
                        <span key={`${card.id}:${line}`} style={pillStyle(line)}>{line}</span>
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
                        View Companion Card
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
