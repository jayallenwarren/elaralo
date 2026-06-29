"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

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
  companionKey: string;
  mappingAvatar: string;
  headshotUrl: string;
  headshotFileName: string;
  summaryPublicUrl: string;
  gender: string;
  ethnicity: string;
  generation: string;
  shortSummary: string;
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

type ParsedCompanionMeta = {
  key: string;
  first: string;
  gender: string;
  ethnicity: string;
  generation: string;
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
const APP_BASE = String(process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(/\/+$/, "");
const DEFAULT_HEADSHOT = "/elaralo-logo.png";
const HEADSHOT_DIR = "/companion/headshot";
const REBRANDING_PUBLIC_DIR = "/rebranding";

function safeText(value: any): string {
  return String(value ?? "").trim();
}

function safeLower(value: any): string {
  return safeText(value).toLowerCase();
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

function normalizeRebrandingSlug(rawBrand: string): string {
  const raw = safeText(rawBrand);
  if (!raw) return "";
  const normalizedBase = raw
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .replace(/-logo$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalizedBase || raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function joinUrlPrefix(prefix: string, path: string): string {
  const pre = String(prefix || "").trim();
  const p = String(path || "");
  if (!pre) return p;
  if (pre.endsWith("/") && p.startsWith("/")) return pre.slice(0, -1) + p;
  if (!pre.endsWith("/") && !p.startsWith("/")) return pre + "/" + p;
  return pre + p;
}

function stripExt(s: string): string {
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

function normalizeKeyForFile(raw: string): string {
  return String(raw || "").trim().replace(/\s+/g, "-");
}

function titleCaseToken(token: string): string {
  const lower = String(token || "").toLowerCase();
  if (lower === "genz") return "GenZ";
  if (lower === "genx") return "GenX";
  if (lower === "geny") return "GenY";
  if (lower === "genalpha") return "GenAlpha";
  if (lower === "usa") return "USA";
  if (lower === "uk") return "UK";
  if (!lower) return "";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function toTitleCaseHyphenated(s: string): string {
  return String(s || "")
    .split("-")
    .map((t) => titleCaseToken(t))
    .join("-");
}

function humanizeToken(token: string): string {
  return String(token || "")
    .replace(/_/g, "-")
    .split("-")
    .map((part) => titleCaseToken(part))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function parseCompanionKeyMeta(raw: string): ParsedCompanionMeta {
  const cleaned = normalizeKeyForFile(stripTrailingUuid(stripExt(String(raw || "").split("/").pop() || ""))).replace(/^-+|-+$/g, "");
  const parts = cleaned
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 4) {
    return {
      key: cleaned,
      first: humanizeToken(parts[0] || cleaned),
      gender: "",
      ethnicity: "",
      generation: "",
    };
  }

  const [first, gender, ethnicity, ...rest] = parts;
  return {
    key: cleaned,
    first: humanizeToken(first),
    gender: humanizeToken(gender),
    ethnicity: humanizeToken(ethnicity),
    generation: humanizeToken(rest.join("-")),
  };
}

function isDefaultHeadshot(value: string): boolean {
  const s = safeText(value);
  if (!s) return false;
  return s === DEFAULT_HEADSHOT || /\/elaralo-logo\.(png|jpg|jpeg|webp)$/i.test(s) || /\/elaralo-logo\.png$/i.test(s);
}

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of items) {
    const s = safeText(value);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildAvatarCandidates(companionKeyOrName: string, brand?: string): string[] {
  const raw = stripExt(String(companionKeyOrName || "").split("/").pop() || "");
  if (!raw) return [];

  const baseInputs = Array.from(new Set([raw, stripTrailingUuid(raw)].map((v) => safeText(v)).filter(Boolean)));
  const encVariants: string[] = [];
  const seenEnc = new Set<string>();

  for (const baseInput of baseInputs) {
    const normalized = normalizeKeyForFile(baseInput);
    const lower = normalized.toLowerCase();
    const title = toTitleCaseHyphenated(lower);
    for (const v of [normalized, title, lower]) {
      const trimmed = safeText(v);
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
      const rebrandBase = joinUrlPrefix("", `${REBRANDING_PUBLIC_DIR}/${slugEnc}${HEADSHOT_DIR}/${enc}`);
      candidates.push(rebrandBase);
      for (const ext of exts) candidates.push(`${rebrandBase}.${ext}`);
    }

    const base = joinUrlPrefix("", `${HEADSHOT_DIR}/${enc}`);
    candidates.push(base);
    for (const ext of exts) candidates.push(`${base}.${ext}`);
  }

  return uniqueStrings(candidates);
}

function resolveSummaryUrl(rawUrl: string, brand: string, companionKey: string): string {
  const explicit = safeText(rawUrl);
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return explicit;
    if (APP_BASE && explicit.startsWith("/")) return `${APP_BASE}${explicit}`;
    return explicit;
  }
  if (!companionKey) return "";
  const relative = `/summary-public?brand=${encodeURIComponent(brand || "Elaralo")}&avatar=${encodeURIComponent(companionKey)}`;
  return APP_BASE ? `${APP_BASE}${relative}` : relative;
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
  const brand = safeText(item?.brand) || defaultBrand || "Elaralo";
  const explicitAvatar =
    safeText(item?.avatar) ||
    safeText(item?.companion) ||
    safeText(item?.slug) ||
    safeText(item?.companion_key) ||
    safeText(item?.companionKey);
  const companionKey =
    safeText(item?.companion_key) ||
    safeText(item?.companionKey) ||
    explicitAvatar;
  const parsed = parseCompanionKeyMeta(companionKey || explicitAvatar);
  const companionType = normalizeCompanionType(item?.companion_type || item?.companionType) || (parsed.gender || parsed.ethnicity || parsed.generation ? "AI" : "");
  const displayName =
    safeText(item?.display_name) ||
    safeText(item?.displayName) ||
    safeText(item?.public_name) ||
    safeText(item?.publicName) ||
    safeText(item?.name) ||
    safeText(item?.first_name) ||
    safeText(item?.firstName) ||
    parsed.first ||
    safeText(companionKey || explicitAvatar) ||
    "Companion";
  const headshotUrl =
    safeText(item?.headshot_url) ||
    safeText(item?.headshotUrl) ||
    safeText(item?.image_url) ||
    safeText(item?.imageUrl) ||
    safeText(item?.photo_url) ||
    safeText(item?.photoUrl);
  const headshotFileName =
    safeText(item?.headshot_file_name) ||
    safeText(item?.headshotFileName) ||
    safeText(item?.headshot_asset?.file_name) ||
    safeText(item?.public_page?.headshot_asset?.file_name);
  const summaryPublicUrl = resolveSummaryUrl(
    safeText(item?.summary_public_url) || safeText(item?.summaryPublicUrl),
    brand,
    companionKey || explicitAvatar,
  );
  const id =
    safeText(item?.id) ||
    safeText(item?.companion_id) ||
    safeText(item?.companionId) ||
    safeText(item?.approved_version_id) ||
    safeText(item?.approvedVersionId) ||
    `${brand}:${companionType || "Companion"}:${companionKey || explicitAvatar || displayName}`;

  return {
    id,
    companionType,
    displayName,
    brand,
    avatar: explicitAvatar || companionKey,
    companionKey: companionKey || explicitAvatar,
    mappingAvatar: safeText(item?.mapping_avatar || item?.mappingAvatar),
    headshotUrl,
    headshotFileName,
    summaryPublicUrl,
    gender: safeText(item?.gender) || parsed.gender,
    ethnicity: safeText(item?.ethnicity) || parsed.ethnicity,
    generation: safeText(item?.generation) || parsed.generation,
    shortSummary:
      safeText(item?.summary) || safeText(item?.short_summary) || safeText(item?.shortSummary) || safeText(item?.tagline),
    raw: item,
  };
}

function firstLine(text: string): string {
  const t = safeText(text);
  if (!t) return "";
  const line = t.split(/\n+/)[0]?.trim() || "";
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function CompanionHeadshotImage({ card }: { card: CompanionCardItem }) {
  const candidates = useMemo(() => {
    const direct = safeText(card.headshotUrl);
    const fromFile = safeText(card.headshotFileName);
    const key = safeText(card.companionKey || card.avatar);
    const raw: string[] = [];

    if (direct && !isDefaultHeadshot(direct)) raw.push(direct);
    if (fromFile) raw.push(...buildAvatarCandidates(fromFile, card.brand));
    if (key && safeLower(card.companionType) === "ai") raw.push(...buildAvatarCandidates(key, card.brand));
    if (direct && isDefaultHeadshot(direct)) raw.push(direct);
    raw.push(DEFAULT_HEADSHOT);
    return uniqueStrings(raw);
  }, [card.avatar, card.brand, card.companionKey, card.companionType, card.headshotFileName, card.headshotUrl]);

  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
  }, [candidates.join("|")]);

  const src = candidates[Math.min(idx, Math.max(candidates.length - 1, 0))] || DEFAULT_HEADSHOT;

  return (
    <img
      src={src}
      alt={card.displayName || "Companion"}
      style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block", background: "#e2e8f0" }}
      onError={() => {
        setIdx((prev) => (prev + 1 < candidates.length ? prev + 1 : prev));
      }}
    />
  );
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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const data: any = event?.data || {};
        const type = safeText(data?.type);
        const payload = (type === "MEMBER_PLAN" ? data?.payload : data) || {};
        if (type === "MEMBER_PLAN" || type === "MY_ELARALO_CONTEXT" || payload?.memberId || payload?.member_id) {
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

  const memberId = safeText(memberPayload.memberId || memberPayload.member_id);
  const displayName = safeText(memberPayload.displayName || memberPayload.display_name || memberPayload.userName || memberPayload.user_name);
  const loggedIn = Boolean(memberPayload.loggedIn ?? memberPayload.logged_in);
  const brandName = safeText(memberPayload.brand) || "Elaralo";

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (!memberId) {
        setError(loggedIn ? "Waiting for member context..." : "Please sign in through the Elaralo member area.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const qs = new URLSearchParams();
        qs.set("memberId", memberId);
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
  }, [brandName, loggedIn, memberId]);

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

  const openConnect = useCallback(
    (card: CompanionCardItem) => {
      const avatar = safeText(card.companionKey || card.avatar);
      if (!avatar) return;
      try {
        const url = new URL("/", window.location.origin);
        url.searchParams.set("loggedIn", loggedIn ? "1" : "0");
        if (memberId) url.searchParams.set("memberId", memberId);
        if (displayName) url.searchParams.set("displayName", displayName);
        url.searchParams.set("brand", safeText(card.brand) || brandName || "Elaralo");
        url.searchParams.set("avatar", avatar);
        url.searchParams.set("companionKey", avatar);
        if (card.companionType) url.searchParams.set("companionType", card.companionType);
        if (card.mappingAvatar) url.searchParams.set("mappingAvatar", card.mappingAvatar);
        window.location.assign(url.toString());
      } catch {
        // ignore
      }
    },
    [brandName, displayName, loggedIn, memberId],
  );

  const openSummaryPublic = useCallback(
    (card: CompanionCardItem) => {
      const target = resolveSummaryUrl(card.summaryPublicUrl, card.brand || brandName || "Elaralo", card.companionKey || card.avatar);
      if (!target) return;
      try {
        window.open(target, "_blank", "noopener,noreferrer");
      } catch {
        // ignore
      }
    },
    [brandName],
  );

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
                My Elaralo
              </div>
              <h1 style={{ margin: 0, fontSize: 42, lineHeight: 1.08 }}>Choose your Companion</h1>
              <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, maxWidth: 840, color: "#475569" }}>
                Filter AI and Human companions, review each Companion Card, then click a card to continue into Connect.
              </p>
            </div>
            <div style={{ minWidth: 220, textAlign: "right" }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 4 }}>Member session</div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>{displayName || memberId || ""}</div>
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
            <div style={{ fontSize: 16, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>Unable to load My Elaralo companions</div>
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
              const lines = [
                card.companionType,
                card.gender,
                card.ethnicity,
                card.generation,
              ].filter(Boolean);
              const summaryLine = firstLine(card.shortSummary);
              const canOpenConnect = Boolean(safeText(card.companionKey || card.avatar));
              return (
                <article key={card.id} style={cardStyle}>
                  <button type="button" style={imageButtonStyle} onClick={() => openConnect(card)} title="Open in Connect">
                    <CompanionHeadshotImage card={card} />
                  </button>
                  <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 24, lineHeight: 1.15, fontWeight: 800 }}>{card.displayName || "Companion"}</div>
                        {summaryLine ? <div style={{ fontSize: 14, color: "#475569", marginTop: 6 }}>{summaryLine}</div> : null}
                      </div>
                      <span style={pillStyle(card.companionType)}>{card.companionType || ""}</span>
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
                        Open Connect
                      </button>
                      <button
                        type="button"
                        onClick={() => openSummaryPublic(card)}
                        disabled={!safeText(card.summaryPublicUrl) && !safeText(card.companionKey || card.avatar)}
                        style={{
                          borderRadius: 14,
                          border: "1px solid rgba(15,23,42,0.14)",
                          background: "#fff",
                          color: "#0f172a",
                          padding: "12px 16px",
                          fontWeight: 800,
                          cursor: "pointer",
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
