"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type PublicAsset = {
  asset_id?: string;
  slot_key?: string;
  slot_label?: string;
  url?: string;
  file_name?: string;
  content_type?: string;
  width_px?: number;
  height_px?: number;
};

type EducationEntry = {
  degree?: string;
  field_of_study?: string;
  institution?: string;
  graduation_year?: string;
  notes?: string;
};

type PublicSummaryResponse = {
  ok?: boolean;
  version?: {
    version_id?: string;
    session_id?: string;
    member_id?: string;
    version_no?: number;
    publish_scope?: string;
    approved_epoch?: number;
  };
  public_profile?: Record<string, any>;
  public_page?: {
    headline?: string;
    headshot_asset?: PublicAsset | null;
    gallery_assets?: PublicAsset[];
    education_entries?: EducationEntry[];
    education_text?: string;
  };
};

const API_BASE = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");

function splitList(raw: any): string[] {
  return String(raw || "")
    .split(/\n|,|•/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function educationSummary(entry: EducationEntry): string {
  const degree = String(entry?.degree || "").trim();
  const field = String(entry?.field_of_study || "").trim();
  const institution = String(entry?.institution || "").trim();
  const graduationYear = String(entry?.graduation_year || "").trim();
  const notes = String(entry?.notes || "").trim();
  const lead = degree && field ? `${degree} in ${field}` : degree || field;
  const parts = [lead, institution, graduationYear ? `Class of ${graduationYear}` : ""].filter(Boolean);
  const base = parts.join(" — ");
  return notes ? (base ? `${base}. ${notes}` : notes) : base;
}

function formatApprovedEpoch(epoch?: number): string {
  if (!epoch) return "";
  try {
    return new Date(epoch * 1000).toLocaleString();
  } catch {
    return "";
  }
}

export default function SummaryPublicPage() {
  const searchParams = useSearchParams();
  const memberId = String(searchParams.get("memberId") || searchParams.get("member_id") || "").trim();
  const versionId = String(searchParams.get("versionId") || searchParams.get("version_id") || "").trim();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<PublicSummaryResponse | null>(null);

  useEffect(() => {
    async function run() {
      if (!API_BASE) {
        setError("NEXT_PUBLIC_API_BASE_URL is not configured.");
        setLoading(false);
        return;
      }
      if (!memberId && !versionId) {
        setError("memberId or versionId is required to load the Summary Public Page.");
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
        const payload = (await res.json().catch(() => ({}))) as PublicSummaryResponse & { detail?: string };
        if (!res.ok || !payload?.ok) {
          throw new Error(String(payload?.detail || `HTTP ${res.status}`));
        }
        setData(payload);
      } catch (err: any) {
        setError(String(err?.message || "Unable to load the Summary Public Page."));
      } finally {
        setLoading(false);
      }
    }
    void run();
  }, [memberId, versionId]);

  const publicProfile = data?.public_profile || {};
  const publicPage = data?.public_page || {};
  const headshot = (publicPage.headshot_asset || publicProfile.headshot_asset || null) as PublicAsset | null;
  const galleryAssets = (Array.isArray(publicPage.gallery_assets) ? publicPage.gallery_assets : (Array.isArray(publicProfile.gallery_assets) ? publicProfile.gallery_assets : [])) as PublicAsset[];
  const educationEntries = useMemo(() => {
    const raw = Array.isArray(publicPage.education_entries)
      ? publicPage.education_entries
      : Array.isArray(publicProfile.education_entries)
        ? publicProfile.education_entries
        : [];
    const normalized = raw.map((entry) => educationSummary(entry || {})).filter(Boolean);
    if (normalized.length) return normalized;
    const legacy = String(publicPage.education_text || publicProfile.education || "").trim();
    return legacy ? legacy.split(/\n+/).map((line) => line.trim()).filter(Boolean) : [];
  }, [publicPage.education_entries, publicPage.education_text, publicProfile.education, publicProfile.education_entries]);

  const quickReference = publicProfile.quick_reference_summary || {};
  const likes = splitList(publicProfile.likes);
  const hobbies = splitList(publicProfile.hobbies);
  const dislikes = splitList(publicProfile.dislikes);
  const astrologicalProfile = publicProfile.astrological_profile || {};
  const strengths = Array.isArray(astrologicalProfile.strengths) ? astrologicalProfile.strengths : splitList(astrologicalProfile.strengths);
  const challenges = Array.isArray(astrologicalProfile.challenges) ? astrologicalProfile.challenges : splitList(astrologicalProfile.challenges);

  const shellStyle: React.CSSProperties = {
    maxWidth: 1120,
    margin: "24px auto",
    padding: "0 16px 48px",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    color: "#111827",
  };
  const cardStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 18,
    background: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
    padding: 20,
  };
  const chipStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "8px 12px",
    background: "rgba(17,24,39,0.06)",
    fontWeight: 700,
    fontSize: 13,
  };

  if (loading) {
    return (
      <main style={shellStyle}>
        <div style={cardStyle}>Loading Summary Public Page...</div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={shellStyle}>
        <div style={cardStyle}>
          <h1 style={{ marginTop: 0 }}>Summary Public Page</h1>
          <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div>
        </div>
      </main>
    );
  }

  return (
    <main style={shellStyle}>
      <div style={{ display: "grid", gap: 18 }}>
        <section style={{ ...cardStyle, display: "grid", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
            <div style={{ display: "grid", gap: 12 }}>
              {headshot?.url ? (
                <img
                  src={headshot.url}
                  alt={String(publicPage.headline || publicProfile.public_display_name || publicProfile.stage_name || "Profile headshot")}
                  style={{ width: "100%", borderRadius: 18, objectFit: "cover", aspectRatio: "4 / 5", background: "#f3f4f6" }}
                />
              ) : (
                <div style={{ width: "100%", aspectRatio: "4 / 5", borderRadius: 18, background: "#f3f4f6", display: "grid", placeItems: "center", color: "#6b7280", fontWeight: 700 }}>
                  Headshot pending
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {quickReference?.public_name ? <span style={chipStyle}>{quickReference.public_name}</span> : null}
                {publicProfile?.age ? <span style={chipStyle}>Age {publicProfile.age}</span> : null}
                {publicProfile?.zodiac_sign ? <span style={chipStyle}>{publicProfile.zodiac_sign}</span> : null}
                {publicProfile?.gender ? <span style={chipStyle}>{publicProfile.gender}</span> : null}
              </div>
            </div>
            <div style={{ display: "grid", gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "#6b7280" }}>
                  Summary Public Page
                </div>
                <h1 style={{ margin: "6px 0 0 0", fontSize: 42, lineHeight: 1.05 }}>
                  {String(publicPage.headline || publicProfile.public_display_name || publicProfile.stage_name || "Approved public profile")}
                </h1>
                <div style={{ marginTop: 10, color: "#4b5563", fontSize: 14 }}>
                  Approved version {data?.version?.version_no || 0}
                  {data?.version?.publish_scope ? ` • ${String(data.version.publish_scope).toUpperCase()} publish` : ""}
                  {data?.version?.approved_epoch ? ` • Approved ${formatApprovedEpoch(data.version.approved_epoch)}` : ""}
                </div>
              </div>
              <div style={{ color: "#374151", lineHeight: 1.7, fontSize: 16 }}>
                {String(publicProfile.personality || publicProfile.background_story || "This host summary is available after an approved version is published.")}
              </div>
              {quickReference && Object.keys(quickReference).length ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                  {quickReference.birth_location ? <div style={cardStyle}><div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>Birth location</div><div style={{ marginTop: 6 }}>{String(quickReference.birth_location)}</div></div> : null}
                  {quickReference.nationalities ? <div style={cardStyle}><div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>Nationalities</div><div style={{ marginTop: 6 }}>{Array.isArray(quickReference.nationalities) ? quickReference.nationalities.join(", ") : String(quickReference.nationalities)}</div></div> : null}
                  {quickReference.race ? <div style={cardStyle}><div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>Race</div><div style={{ marginTop: 6 }}>{String(quickReference.race)}</div></div> : null}
                  {quickReference.ethnicity ? <div style={cardStyle}><div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>Ethnicity</div><div style={{ marginTop: 6 }}>{String(quickReference.ethnicity)}</div></div> : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {publicProfile.family_heritage ? (
            <div style={cardStyle}>
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Family Heritage</h2>
              <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.family_heritage)}</div>
            </div>
          ) : null}
          {publicProfile.physical_description ? (
            <div style={cardStyle}>
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Physical Description</h2>
              <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.physical_description)}</div>
            </div>
          ) : null}
          {publicProfile.lifestyle ? (
            <div style={cardStyle}>
              <h2 style={{ marginTop: 0, marginBottom: 10 }}>Lifestyle</h2>
              <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.lifestyle)}</div>
            </div>
          ) : null}
        </section>

        {(strengths.length || challenges.length || astrologicalProfile?.narrative) ? (
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Astrological Profile</h2>
            {astrologicalProfile?.narrative ? <div style={{ color: "#374151", lineHeight: 1.7, marginBottom: 14 }}>{String(astrologicalProfile.narrative)}</div> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              {strengths.length ? (
                <div>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Strengths</div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    {strengths.map((item, idx) => <li key={`s-${idx}`}>{String(item)}</li>)}
                  </ul>
                </div>
              ) : null}
              {challenges.length ? (
                <div>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Challenges</div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    {challenges.map((item, idx) => <li key={`c-${idx}`}>{String(item)}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {educationEntries.length ? (
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Education</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {educationEntries.map((entry, idx) => (
                <div key={`edu-${idx}`} style={{ padding: 14, borderRadius: 14, background: "rgba(17,24,39,0.04)" }}>
                  {entry}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {(publicProfile.career?.current_job_title || publicProfile.career?.career_summary) ? (
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Career</h2>
            {publicProfile.career?.current_job_title ? <div style={{ fontWeight: 800 }}>{String(publicProfile.career.current_job_title)}</div> : null}
            {publicProfile.career?.current_company ? <div style={{ marginTop: 4, color: "#4b5563" }}>{String(publicProfile.career.current_company)}</div> : null}
            {publicProfile.career?.career_summary ? <div style={{ marginTop: 12, color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.career.career_summary)}</div> : null}
          </section>
        ) : null}

        {(likes.length || hobbies.length || dislikes.length || publicProfile.core_values || publicProfile.personal_motto || publicProfile.background_story) ? (
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            {likes.length ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Likes</h2>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {likes.map((item, idx) => <li key={`likes-${idx}`}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            {hobbies.length ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Hobbies</h2>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {hobbies.map((item, idx) => <li key={`hobbies-${idx}`}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            {dislikes.length ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Dislikes</h2>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {dislikes.map((item, idx) => <li key={`dislikes-${idx}`}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            {publicProfile.core_values ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Core Values</h2>
                <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.core_values)}</div>
              </div>
            ) : null}
            {publicProfile.personal_motto ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Personal Motto</h2>
                <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.personal_motto)}</div>
              </div>
            ) : null}
            {publicProfile.background_story ? (
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Background Story</h2>
                <div style={{ color: "#374151", lineHeight: 1.7 }}>{String(publicProfile.background_story)}</div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Public Page Photo Gallery</h2>
          <div style={{ color: "#4b5563", lineHeight: 1.6, marginBottom: 14 }}>
            This section shows all uploaded pictures except the primary headshot.
          </div>
          {galleryAssets.length ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              {galleryAssets.map((asset, idx) => (
                <figure key={asset.asset_id || asset.url || idx} style={{ margin: 0, display: "grid", gap: 8 }}>
                  <img
                    src={String(asset.url || "")}
                    alt={String(asset.slot_label || asset.file_name || `Gallery image ${idx + 1}`)}
                    style={{ width: "100%", borderRadius: 16, objectFit: "cover", aspectRatio: "4 / 5", background: "#f3f4f6" }}
                  />
                  <figcaption style={{ fontSize: 13, color: "#4b5563" }}>
                    {String(asset.slot_label || asset.file_name || `Image ${idx + 1}`)}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>No additional uploaded pictures are available for the public gallery yet.</div>
          )}
        </section>
      </div>
    </main>
  );
}
