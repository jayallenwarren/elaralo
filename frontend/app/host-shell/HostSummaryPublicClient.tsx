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
const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(
  /\/+$/,
  "",
);
const APP_BASE = String(process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(
  /\/+$/,
  "",
);

function safeText(value: any): string {
  return String(value ?? "").trim();
}

function queryParam(name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return safeText(
      new URLSearchParams(window.location.search || "").get(name),
    );
  } catch {
    return "";
  }
}

function listFromLooseValue(value: any): string[] {
  if (Array.isArray(value))
    return value.map((x) => safeText(x)).filter(Boolean);
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
  const degreeAndField = [
    safeText(entry.degree),
    safeText(entry.field_of_study),
  ]
    .filter(Boolean)
    .join(" in ");
  const left = [degreeAndField, safeText(entry.institution)]
    .filter(Boolean)
    .join(" — ");
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

function companionKeyFromDisplayName(value: any): string {
  return safeText(value)
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isDefaultOrLogoHeadshot(value: any): boolean {
  const raw = safeText(value);
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower === DEFAULT_AVATAR.toLowerCase() ||
    /(^|\/)elaralo-logo\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(lower)
  );
}

const APP_BASE_PATH = getAppBasePathFromAsset(DEFAULT_AVATAR);

function stripExt(s: string) {
  let out = String(s || "")
    .trim()
    .split("?", 1)[0]
    .split("#", 1)[0];
  while (true) {
    const next = out.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTrailingUuid(raw: string): string {
  const s = String(raw || "").trim();
  return s.replace(
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "",
  );
}

function normalizeKeyForFile(raw: string) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, "-");
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
  const raw = stripExt(
    String(companionKeyOrName || "")
      .split("/")
      .pop() || "",
  );
  if (!raw) return [DEFAULT_AVATAR];

  const baseInputs = Array.from(
    new Set(
      [raw, stripTrailingUuid(raw)]
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    ),
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

  const slug = normalizeRebrandingSlug(brand || "");
  const slugEnc = slug ? encodeURIComponent(slug) : "";
  const exts = [
    "jpeg",
    "JPEG",
    "jpg",
    "JPG",
    "png",
    "PNG",
    "webp",
    "WEBP",
  ] as const;
  const candidates: string[] = [];

  for (const enc of encVariants) {
    if (slugEnc && slug !== "elaralo") {
      const rebrandBase = joinUrlPrefix(
        APP_BASE_PATH,
        `${REBRANDING_PUBLIC_DIR}/${slugEnc}${HEADSHOT_DIR}/${enc}`,
      );
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

export default function HostSummaryPublicClient() {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [payload, setPayload] = useState<PublicVersionPayload | null>(null);
  const [resolvedHeadshot, setResolvedHeadshot] = useState<string>("");

  const versionId = queryParam("versionId") || queryParam("version_id");
  const memberId = queryParam("memberId") || queryParam("member_id");
  const brand = queryParam("brand") || queryParam("brandId") || "Elaralo";
  const avatar =
    queryParam("avatar") ||
    queryParam("companion") ||
    queryParam("companionKey") ||
    queryParam("companion_key");
  const headshot =
    queryParam("headshot") ||
    queryParam("headshotFile") ||
    queryParam("headshot_file");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (!versionId && !memberId && !avatar && !headshot) {
        setError(
          "A public summary link requires versionId, memberId, avatar, or headshot in the URL.",
        );
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

        const res = await fetch(
          `${API_BASE}/host-onboarding/public/summary?${qs.toString()}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
          },
        );
        const data = (await res
          .json()
          .catch(() => ({}) as any)) as PublicVersionPayload;
        if (!res.ok || !data?.public_profile) {
          throw new Error(
            String(data?.detail || data?.message || `HTTP ${res.status}`),
          );
        }
        if (cancelled) return;
        setPayload(data);
      } catch (err: any) {
        if (cancelled) return;
        setError(
          String(err?.message || "Unable to load the public summary page."),
        );
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
    const cardType = safeText(
      publicPage.card_type ||
        publicProfile.summary_mode ||
        publicProfile.card_type,
    ).toLowerCase();
    const companionType = safeText(
      publicProfile.companion_type || publicPage.companion_type,
    ).toLowerCase();
    return (
      cardType === "ai_companion" ||
      cardType === "ai_companion_card" ||
      companionType === "ai"
    );
  }, [
    publicPage.card_type,
    publicPage.companion_type,
    publicProfile.card_type,
    publicProfile.companion_type,
    publicProfile.summary_mode,
  ]);

  const directHeadshotUrl = safeText(
    publicPage.headshot_asset?.url || publicProfile.headshot_asset?.url || "",
  );
  const avatarKey = safeText(
    publicProfile.avatar ||
      avatar ||
      headshot ||
      publicPage.headshot_asset?.file_name ||
      publicProfile.headshot_asset?.file_name ||
      "",
  );

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
      const picked = await pickFirstLoadableImage(
        buildAvatarCandidates(avatarKey, brand),
      );
      if (!cancelled)
        setResolvedHeadshot(picked && picked !== DEFAULT_AVATAR ? picked : "");
    }
    void resolveImage();
    return () => {
      cancelled = true;
    };
  }, [avatarKey, brand, directHeadshotUrl, isAiCompanionCard]);

  const headshotUrl = isAiCompanionCard
    ? resolvedHeadshot || directHeadshotUrl
    : directHeadshotUrl;
  const galleryAssets = useMemo(
    () =>
      (Array.isArray(publicPage.gallery_assets)
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
    const normalized = raw
      .map((entry: any) => educationLine(entry || {}))
      .filter(Boolean);
    if (normalized.length) return normalized;
    return listFromLooseValue(
      publicPage.education_text || publicProfile.education,
    );
  }, [
    publicPage.education_entries,
    publicPage.education_text,
    publicProfile.education,
    publicProfile.education_entries,
  ]);

  const quickReference = (publicProfile.quick_reference_summary ||
    {}) as Record<string, any>;
  const approvedLabel = formatApprovedDate(payload?.version?.approved_epoch);
  const personalMotto = safeText(publicProfile.personal_motto);

  const sectionStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.1)",
    borderRadius: 18,
    background: "#fff",
    padding: 20,
    boxShadow: "0 8px 22px rgba(0,0,0,0.05)",
  };

  const chips = [
    safeText(
      publicProfile.companion_type || (isAiCompanionCard ? "AI Companion" : ""),
    ),
    safeText(publicProfile.gender),
    safeText(publicProfile.ethnicity),
    safeText(publicProfile.generation),
  ].filter(Boolean);

  const displayNameForConnect = safeText(
    publicProfile.public_display_name ||
      publicProfile.stage_name ||
      quickReference.public_name ||
      "Companion",
  );
  const connectCompanionKey =
    safeText(
      queryParam("avatar") ||
        queryParam("companion") ||
        queryParam("companionKey") ||
        queryParam("companion_key") ||
        publicProfile.companion_key ||
        publicProfile.companionKey ||
        publicProfile.selected_companion_key ||
        publicProfile.selectedCompanionKey ||
        publicProfile.avatar ||
        publicProfile.avatar_key ||
        publicProfile.avatarKey ||
        publicPage.companion_key ||
        publicPage.companionKey ||
        publicPage.avatar,
    ) || companionKeyFromDisplayName(displayNameForConnect);
  const connectMappingAvatar =
    safeText(
      publicProfile.mapping_avatar ||
        publicProfile.mappingAvatar ||
        publicProfile.sql_avatar ||
        publicProfile.sqlAvatar ||
        publicProfile.avatar ||
        publicPage.avatar,
    ) || connectCompanionKey;
  const connectCompanionType = safeText(
    publicProfile.companion_type ||
      publicPage.companion_type ||
      (isAiCompanionCard ? "AI" : "Human"),
  );
  const connectHeadshotUrl = safeText(
    directHeadshotUrl ||
      headshotUrl ||
      publicPage.headshot_asset?.url ||
      publicProfile.headshot_asset?.url ||
      "",
  );
  const connectHref = useMemo(() => {
    if (!connectCompanionKey && !connectMappingAvatar) return "";
    const configuredConnectUrl = safeText(
      process.env.NEXT_PUBLIC_CONNECT_URL ||
        process.env.NEXT_PUBLIC_CONNECT_BASE_URL,
    );
    const url = resolveButtonUrl(configuredConnectUrl, "/");
    if (!url) return "";
    const mappingAvatar = connectMappingAvatar || connectCompanionKey;
    const companionKey = connectCompanionKey || mappingAvatar;
    url.searchParams.set("source", "my-elaralo");
    url.searchParams.set("handoffSource", "summary-public");
    url.searchParams.set("handoff_source", "summary-public");
    url.searchParams.set("origin", "summary-public");
    url.searchParams.set("loggedIn", "0");
    url.searchParams.set("logged_in", "0");
    url.searchParams.set("brand", brand || "Elaralo");
    url.searchParams.set("rebranding", brand || "Elaralo");
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
    if (displayNameForConnect) {
      url.searchParams.set("companionDisplayName", displayNameForConnect);
      url.searchParams.set("companion_display_name", displayNameForConnect);
    }
    if (connectCompanionType) {
      url.searchParams.set("companionType", connectCompanionType);
      url.searchParams.set("companion_type", connectCompanionType);
    }
    if (versionId) {
      url.searchParams.set("profileVersionId", versionId);
      url.searchParams.set("profile_version_id", versionId);
    }
    if (connectHeadshotUrl && !isDefaultOrLogoHeadshot(connectHeadshotUrl)) {
      url.searchParams.set("headshotUrl", connectHeadshotUrl);
      url.searchParams.set("headshot_url", connectHeadshotUrl);
      url.searchParams.set("imageUrl", connectHeadshotUrl);
      url.searchParams.set("image_url", connectHeadshotUrl);
      url.searchParams.set("photoUrl", connectHeadshotUrl);
      url.searchParams.set("photo_url", connectHeadshotUrl);
    }
    return url.toString();
  }, [
    brand,
    connectCompanionKey,
    connectCompanionType,
    connectHeadshotUrl,
    connectMappingAvatar,
    displayNameForConnect,
    versionId,
  ]);

  const gallerySection = galleryAssets.length ? (
    <section style={sectionStyle}>
      <h2 style={{ marginTop: 0 }}>
        {isAiCompanionCard ? "Additional Photos" : "Public Gallery"}
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        {galleryAssets.map((asset, idx) => (
          <figure
            key={`${safeText(asset.asset_id || asset.url || idx)}`}
            style={{ margin: 0, display: "grid" }}
          >
            <img
              src={safeText(asset.url)}
              alt={slotLabel(safeText(asset.slot_key))}
              style={{
                width: "100%",
                aspectRatio: "2 / 3",
                objectFit: "contain",
                objectPosition: "center center",
                background: "#f8fafc",
                borderRadius: 16,
                border: "1px solid rgba(0,0,0,0.08)",
              }}
            />
          </figure>
        ))}
      </div>
    </section>
  ) : null;

  const connectButton = connectHref ? (
    <a
      href={connectHref}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        maxWidth: 220,
        height: 24,
        minHeight: 0,
        padding: "0 12px",
        boxSizing: "border-box",
        borderRadius: 999,
        background: "#111827",
        color: "#fff",
        textDecoration: "none",
        fontSize: 13,
        lineHeight: 1,
        fontWeight: 800,
        boxShadow: "0 4px 10px rgba(17,24,39,0.12)",
      }}
      aria-label={`Connect with ${displayNameForConnect || "this companion"}`}
    >
      Connect
    </a>
  ) : null;

  if (loading) {
    return (
      <main
        style={{
          maxWidth: 1120,
          margin: "24px auto",
          padding: "0 16px",
          fontFamily: "system-ui",
        }}
      >
        <div style={sectionStyle}>
          Loading {isAiCompanionCard ? "companion card" : "public summary"}…
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main
        style={{
          maxWidth: 1120,
          margin: "24px auto",
          padding: "0 16px",
          fontFamily: "system-ui",
        }}
      >
        <div style={sectionStyle}>
          <h1 style={{ marginTop: 0 }}>
            {isAiCompanionCard ? "Companion Card" : "Summary Public Page"}
          </h1>
          <div style={{ color: "#b91c1c", lineHeight: 1.6 }}>{error}</div>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 1180,
        margin: "24px auto 48px",
        padding: "0 16px",
        fontFamily: "system-ui",
        color: "#111827",
      }}
    >
      <div style={{ display: "grid", gap: 18 }}>
        <section style={{ ...sectionStyle, display: "grid", gap: 18 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            {isAiCompanionCard ? "Companion Card" : "Summary Public Page"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)",
              gap: 20,
              alignItems: "start",
            }}
          >
            <div
              style={{
                display: "grid",
                gap: 4,
                justifyItems: "stretch",
                width: "100%",
                maxWidth: 220,
              }}
            >
              {headshotUrl ? (
                <img
                  src={headshotUrl}
                  alt={safeText(
                    publicProfile.public_display_name ||
                      publicProfile.stage_name ||
                      "Companion headshot",
                  )}
                  style={{
                    width: "100%",
                    maxWidth: 220,
                    aspectRatio: "2 / 3",
                    objectFit: "cover",
                    objectPosition: "center top",
                    borderRadius: 22,
                    border: "1px solid rgba(0,0,0,0.08)",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    maxWidth: 220,
                    aspectRatio: "2 / 3",
                    borderRadius: 22,
                    border: "1px dashed rgba(0,0,0,0.18)",
                    display: "grid",
                    placeItems: "center",
                    color: "#6b7280",
                  }}
                >
                  No headshot available
                </div>
              )}


              {!personalMotto || isAiCompanionCard ? connectButton : null}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: 42, lineHeight: 1.1 }}>
                {safeText(
                  publicProfile.public_display_name ||
                    publicProfile.stage_name ||
                    "Companion profile",
                )}
              </h1>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {chips.map((chip) => (
                  <span
                    key={chip}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      background: "rgba(17,24,39,0.06)",
                      fontSize: 13,
                      color: "#374151",
                    }}
                  >
                    {chip}
                  </span>
                ))}
                {approvedLabel ? (
                  <span
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      background: "rgba(17,24,39,0.06)",
                      fontSize: 13,
                      color: "#374151",
                    }}
                  >
                    Approved {approvedLabel}
                  </span>
                ) : null}
              </div>


              {isAiCompanionCard ? (
                <div
                  style={{
                    display: "grid",
                    gap: 6,
                    color: "#374151",
                    lineHeight: 1.6,
                  }}
                >
                  {safeText(publicProfile.gender) ? (
                    <div>
                      <b>Gender:</b> {safeText(publicProfile.gender)}
                    </div>
                  ) : null}
                  {safeText(publicProfile.ethnicity) ? (
                    <div>
                      <b>Ethnicity:</b> {safeText(publicProfile.ethnicity)}
                    </div>
                  ) : null}
                  {safeText(publicProfile.generation) ? (
                    <div>
                      <b>Generation:</b> {safeText(publicProfile.generation)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {quickReference && Object.keys(quickReference).length ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 6,
                        color: "#374151",
                        lineHeight: 1.6,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>Quick summary</div>
                      <div>
                        {safeText(
                          quickReference.public_name ||
                            publicProfile.public_display_name ||
                            publicProfile.stage_name,
                        )}
                      </div>
                      {quickReference.birth_location ? (
                        <div>
                          Birth location:{" "}
                          {safeText(quickReference.birth_location)}
                        </div>
                      ) : null}
                      {quickReference.ethnicity ? (
                        <div>
                          Ethnicity: {safeText(quickReference.ethnicity)}
                        </div>
                      ) : null}
                      {quickReference.race ? (
                        <div>Race: {safeText(quickReference.race)}</div>
                      ) : null}
                      {personalMotto && !isAiCompanionCard ? (
                        <blockquote
                          style={{
                            margin: "10px 0 0",
                            padding: "12px 16px",
                            borderLeft: "4px solid #111827",
                            background: "rgba(17,24,39,0.03)",
                            borderRadius: 8,
                            color: "#374151",
                          }}
                        >
                          “{personalMotto}”
                        </blockquote>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {personalMotto && !isAiCompanionCard ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)",
                gap: 20,
                alignItems: "start",
              }}
            >
              <div style={{ width: "100%", maxWidth: 220 }}>
                {connectButton}
              </div>
              <div />
            </div>
          ) : null}
        </section>

        {gallerySection}

        {!isAiCompanionCard && safeText(publicProfile.physical_description) ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Physical Description</h2>
            <div style={{ color: "#374151", lineHeight: 1.75 }}>
              {safeText(publicProfile.physical_description)}
            </div>
          </section>
        ) : null}

        {!isAiCompanionCard && safeText(publicProfile.personality) ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Personality</h2>
            <div style={{ color: "#374151", lineHeight: 1.75 }}>
              {safeText(publicProfile.personality)}
            </div>
          </section>
        ) : null}

        {!isAiCompanionCard && educationEntries.length ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Education</h2>
            <div style={{ display: "grid", gap: 10 }}>
              {educationEntries.map((line, idx) => (
                <div
                  key={`${line}-${idx}`}
                  style={{ color: "#374151", lineHeight: 1.7 }}
                >
                  {line}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {!isAiCompanionCard &&
        (safeText(publicProfile.career?.current_job_title) ||
          safeText(publicProfile.career?.career_summary)) ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Career</h2>
            <div
              style={{
                display: "grid",
                gap: 8,
                color: "#374151",
                lineHeight: 1.7,
              }}
            >
              {safeText(publicProfile.career?.current_job_title) ? (
                <div>
                  <b>Current position:</b>{" "}
                  {safeText(publicProfile.career?.current_job_title)}
                </div>
              ) : null}
              {safeText(publicProfile.career?.current_company) ? (
                <div>
                  <b>Company:</b>{" "}
                  {safeText(publicProfile.career?.current_company)}
                </div>
              ) : null}
              {safeText(publicProfile.career?.career_summary) ? (
                <div>{safeText(publicProfile.career?.career_summary)}</div>
              ) : null}
            </div>
          </section>
        ) : null}

        {!isAiCompanionCard &&
        (safeText(publicProfile.likes) ||
          safeText(publicProfile.hobbies) ||
          safeText(publicProfile.lifestyle) ||
          safeText(publicProfile.background_story) ||
          safeText(publicProfile.core_values)) ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Profile Highlights</h2>
            <div
              style={{
                display: "grid",
                gap: 12,
                color: "#374151",
                lineHeight: 1.75,
              }}
            >
              {safeText(publicProfile.likes) ? (
                <div>
                  <b>Likes:</b> {safeText(publicProfile.likes)}
                </div>
              ) : null}
              {safeText(publicProfile.hobbies) ? (
                <div>
                  <b>Hobbies:</b> {safeText(publicProfile.hobbies)}
                </div>
              ) : null}
              {safeText(publicProfile.lifestyle) ? (
                <div>
                  <b>Lifestyle:</b> {safeText(publicProfile.lifestyle)}
                </div>
              ) : null}
              {safeText(publicProfile.background_story) ? (
                <div>
                  <b>Background:</b> {safeText(publicProfile.background_story)}
                </div>
              ) : null}
              {safeText(publicProfile.core_values) ? (
                <div>
                  <b>Core values:</b> {safeText(publicProfile.core_values)}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </main>
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
