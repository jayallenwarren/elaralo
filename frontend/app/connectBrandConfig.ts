// v10.0.0-alpha15.24
// Centralized public-link configuration for the shared Elaralo/DulceMoon Connect UI.
// Runtime values come from the backend /connect/brand-config endpoint; deterministic
// defaults keep the UI functional if the endpoint or environment setting is unavailable.

export type ConnectBrandKey = "elaralo" | "dulcemoon" | "unknown";

export type ConnectBrandPublicConfig = {
  brandKey: ConnectBrandKey;
  brandName: string;
  homeUrl: string;
  faqUrl: string;
  spotlightUrl: string;
  spotlightSource: "environment" | "default" | "fallback";
};

const CONNECT_BRAND_DEFAULTS: Record<Exclude<ConnectBrandKey, "unknown">, ConnectBrandPublicConfig> = {
  elaralo: {
    brandKey: "elaralo",
    brandName: "Elaralo",
    homeUrl: "https://www.elaralo.com/",
    faqUrl: "https://elaralo.com/faqs",
    spotlightUrl: "https://elaralo.com/#spotlight",
    spotlightSource: "default",
  },
  dulcemoon: {
    brandKey: "dulcemoon",
    brandName: "DulceMoon",
    homeUrl: "https://www.dulcemoon.net/",
    faqUrl: "https://dulcemoon.net/faqs",
    spotlightUrl: "https://dulcemoon.net/#spotlight",
    spotlightSource: "default",
  },
};

const UNKNOWN_BRAND_CONFIG: ConnectBrandPublicConfig = {
  brandKey: "unknown",
  brandName: "",
  homeUrl: "",
  faqUrl: "",
  spotlightUrl: "",
  spotlightSource: "fallback",
};

function normalizeBrandToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function resolveConnectBrandKey(value: unknown): ConnectBrandKey {
  const token = normalizeBrandToken(value);
  if (token === "elaralo") return "elaralo";
  if (token === "dulcemoon") return "dulcemoon";
  return "unknown";
}

export function getConnectBrandPublicConfigDefaults(brand: unknown): ConnectBrandPublicConfig {
  const key = resolveConnectBrandKey(brand);
  if (key === "elaralo" || key === "dulcemoon") {
    return { ...CONNECT_BRAND_DEFAULTS[key] };
  }
  return { ...UNKNOWN_BRAND_CONFIG };
}

function normalizePublicHttpUrl(value: unknown, fallback: string): string {
  let candidate = String(value ?? "").trim();
  if (!candidate) return fallback;

  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) {
    return fallback;
  }

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    if (!parsed.hostname) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

export async function fetchConnectBrandPublicConfig(
  apiBase: string | undefined,
  brand: unknown,
  signal?: AbortSignal
): Promise<ConnectBrandPublicConfig> {
  const fallback = getConnectBrandPublicConfigDefaults(brand);
  const base = String(apiBase ?? "").trim().replace(/\/+$/, "");
  if (!base || fallback.brandKey === "unknown") return fallback;

  try {
    const response = await fetch(
      `${base}/connect/brand-config?brand=${encodeURIComponent(fallback.brandName)}`,
      {
        method: "GET",
        cache: "no-store",
        signal,
      }
    );
    if (!response.ok) return fallback;

    const raw = await response.json().catch(() => null);
    if (!raw || typeof raw !== "object") return fallback;

    const responseBrandKey = resolveConnectBrandKey(
      (raw as any).brand_key ?? (raw as any).brandKey ?? (raw as any).brand
    );
    if (responseBrandKey !== fallback.brandKey) return fallback;

    return {
      ...fallback,
      homeUrl: normalizePublicHttpUrl(
        (raw as any).home_url ?? (raw as any).homeUrl,
        fallback.homeUrl
      ),
      faqUrl: normalizePublicHttpUrl(
        (raw as any).faq_url ?? (raw as any).faqUrl,
        fallback.faqUrl
      ),
      spotlightUrl: normalizePublicHttpUrl(
        (raw as any).spotlight_url ?? (raw as any).spotlightUrl,
        fallback.spotlightUrl
      ),
      spotlightSource:
        String((raw as any).spotlight_source ?? (raw as any).spotlightSource ?? "").trim() ===
        "environment"
          ? "environment"
          : "default",
    };
  } catch (error: any) {
    if (error?.name === "AbortError") return fallback;
    return fallback;
  }
}
