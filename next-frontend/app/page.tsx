import Link from "next/link";

export default function MyElaraloPage() {
  return (
    <main style={{ minHeight: "100vh", padding: 24 }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <img
            src="/elaralo-logo.png"
            alt="Elaralo"
            width={44}
            height={44}
            style={{ borderRadius: 9999, display: "block" }}
          />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>My Elaralo</div>
            <div style={{ opacity: 0.8, fontSize: 13 }}>
              Navigate to your Companion, Docs, and Site pages.
            </div>
          </div>
        </header>

        <section
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 12,
            padding: 18,
            background: "rgba(255,255,255,0.04)",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <Link
              href="/companion"
              style={{
                display: "inline-block",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                textDecoration: "none",
              }}
            >
              Open Companion (Elara)
            </Link>

            <a
              href="https://www.elaralo.com/myelaralo"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                textDecoration: "none",
              }}
            >
              Open My Elaralo (Website)
            </a>

            <a
              href="https://www.elaralo.com/pricing-plans/list"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                textDecoration: "none",
              }}
            >
              Pricing & Plans
            </a>
          </div>
        </section>

        <footer style={{ marginTop: 18, opacity: 0.7, fontSize: 12 }}>
          If you embed the Companion inside another site (e.g., Wix), the page supports postMessage-based
          initialization for plan, member id, and companion_key.
        </footer>
      </div>
    </main>
  );
}
