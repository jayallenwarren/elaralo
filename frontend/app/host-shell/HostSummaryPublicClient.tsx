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
  version_id?: string;
  session_id?: string;
  member_id?: string;
  version_no?: number;
  publish_scope?: string;
  approved_epoch?: number;
  public_profile?: Record<string, any>;
  public_page?: Record<string, any>;
  detail?: string;
  message?: string;
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");

function safeText(value: any): string {
  return String(value ?? "").trim();
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

function queryParam(name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return safeText(new URLSearchParams(window.location.search || "").get(name));
  } catch {
    return "";
  }
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

export default function HostSummaryPublicClient() {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [payload, setPayload] = useState<PublicVersionPayload | null>(null);

  const versionId = queryParam("versionId") || queryParam("version_id");
  const memberId = queryParam("memberId") || queryParam("member_id");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (!versionId && !memberId) {
        setError("A public summary link requires either versionId or memberId in the URL.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const qs = new URLSearchParams();
        if (memberId) qs.set("memberId", memberId);
        if (versionId) qs.set("versionId", versionId);

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
  }, [memberId, versionId]);

  const publicProfile = payload?.public_profile || {};
  const publicPage = payload?.public_page || {};

  const headshotAsset = (publicPage.headshot_asset || publicProfile.headshot_asset || null) as PublicAsset | null;
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
  const approvedLabel = formatApprovedDate(payload?.approved_epoch);

  const sectionStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.1)",
    borderRadius: 18,
    background: "#fff",
    padding: 20,
    boxShadow: "0 8px 22px rgba(0,0,0,0.05)",
  };

  if (loading) {
    return (
      <main style={{ maxWidth: 1120, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={sectionStyle}>Loading public summary…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ maxWidth: 1120, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
        <div style={sectionStyle}>
          <h1 style={{ marginTop: 0 }}>Summary Public Page</h1>
          <div style={{ color: "#b91c1c", lineHeight: 1.6 }}>{error}</div>
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1180, margin: "24px auto 48px", padding: "0 16px", fontFamily: "system-ui", color: "#111827" }}>
      <div style={{ display: "grid", gap: 18 }}>
        <section style={{ ...sectionStyle, display: "grid", gap: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#6b7280" }}>
            Summary Public Page
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
            <div>
              {headshotAsset?.url ? (
                <img
                  src={headshotAsset.url}
                  alt={safeText(publicProfile.public_display_name || publicProfile.stage_name || "Host headshot")}
                  style={{ width: "100%", maxWidth: 220, aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 22, border: "1px solid rgba(0,0,0,0.08)" }}
                />
              ) : (
                <div style={{ width: "100%", maxWidth: 220, aspectRatio: "1 / 1", borderRadius: 22, border: "1px dashed rgba(0,0,0,0.18)", display: "grid", placeItems: "center", color: "#6b7280" }}>
                  No headshot uploaded
                </div>
              )}
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 42, lineHeight: 1.1 }}>
                {safeText(publicProfile.public_display_name || publicProfile.stage_name || "Host profile")}
              </h1>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, color: "#4b5563" }}>
                {safeText(publicProfile.gender) ? <span>{safeText(publicProfile.gender)}</span> : null}
                {publicProfile.age ? <span>• Age {String(publicProfile.age)}</span> : null}
                {safeText(publicProfile.zodiac_sign) ? <span>• {safeText(publicProfile.zodiac_sign)}</span> : null}
                {approvedLabel ? <span>• Approved {approvedLabel}</span> : null}
              </div>

              {quickReference && Object.keys(quickReference).length ? (
                <div style={{ display: "grid", gap: 6, color: "#374151", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 700 }}>Quick summary</div>
                  <div>{safeText(quickReference.public_name || publicProfile.public_display_name || publicProfile.stage_name)}</div>
                  {quickReference.birth_location ? <div>Birth location: {safeText(quickReference.birth_location)}</div> : null}
                  {quickReference.ethnicity ? <div>Ethnicity: {safeText(quickReference.ethnicity)}</div> : null}
                  {quickReference.race ? <div>Race: {safeText(quickReference.race)}</div> : null}
                </div>
              ) : null}

              {safeText(publicProfile.personal_motto) ? (
                <blockquote style={{ margin: 0, padding: "12px 16px", borderLeft: "4px solid #111827", background: "rgba(17,24,39,0.03)", borderRadius: 8, color: "#374151" }}>
                  {safeText(publicProfile.personal_motto)}
                </blockquote>
              ) : null}
            </div>
          </div>
        </section>

        {safeText(publicProfile.physical_description) ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Physical Description</h2>
            <div style={{ lineHeight: 1.7, color: "#374151", whiteSpace: "pre-wrap" }}>{safeText(publicProfile.physical_description)}</div>
          </section>
        ) : null}

        {educationEntries.length ? (
          <section style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Education</h2>
            <div style={{ display: "grid", gap: 8 }}>
              {educationEntries.map((line, idx) => (
                <div key={`edu_${idx}`} style={{ color: "#374151", lineHeight: 1.7 }}>
                  • {line}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {galleryAssets.length ? (
          <section style={sectionStyle}>
            <div style={{ display: "grid", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Public Photo Gallery</h2>
              <div style={{ color: "#4b5563", lineHeight: 1.6 }}>
                This section shows the uploaded public reference photos, excluding the headshot.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 16 }}>
              {galleryAssets.map((asset, idx) => (
                <figure key={safeText(asset.asset_id) || `${safeText(asset.slot_key)}_${idx}`} style={{ margin: 0, display: "grid", gap: 8 }}>
                  <img
                    src={safeText(asset.url)}
                    alt={safeText(asset.file_name || slotLabel(safeText(asset.slot_key)))}
                    style={{ width: "100%", aspectRatio: "4 / 5", objectFit: "cover", borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <figcaption style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700, color: "#111827" }}>{slotLabel(safeText(asset.slot_key))}</div>
                    {safeText(asset.file_name) ? <div>{safeText(asset.file_name)}</div> : null}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
