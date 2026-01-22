// next-frontend/app/companion/page.tsx
import Image from "next/image";
import Link from "next/link";

export const metadata = {
  title: "Elaralo • Companion",
  description: "Elaralo Companion Page",
};

export default function CompanionPage() {
  const ts = new Date().toISOString();

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "2.25rem",
        padding: "2rem 1rem",
      }}
    >
      {/* Header / Branding */}
      <header
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
          alignItems: "center",
        }}
      >
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: "9999px",
            border: "3px solid #111",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
            background: "transparent",
          }}
          aria-label="Elaralo logo"
        >
          {/* Default avatar/logo comes from public/elaralo-logo.png */}
          <Image
            src="/elaralo-logo.png"
            alt="Elaralo"
            width={84}
            height={84}
            priority
            style={{ objectFit: "contain" }}
          />
        </div>

        <div>
          <h1
            style={{
              fontSize: "clamp(1.75rem, 2.8vw + 1rem, 3rem)",
              fontWeight: 800,
              margin: 0,
            }}
          >
            Companion for Elaralo
          </h1>
          <p
            style={{
              marginTop: 8,
              color: "#444",
              maxWidth: 720,
            }}
          >
            A focused hub for starting, navigating, and testing your Elaralo
            experience. This page reflects the latest branding and logic updates
            discussed in this thread (logo, routes, and copy).
          </p>
          <p style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
            ts: <code>{ts}</code>
          </p>
        </div>
      </header>

      {/* Primary Actions */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1rem",
          width: "min(100%, 900px)",
        }}
      >
        <NavCard
          title="My Elaralo"
          href="https://www.elaralo.com/myelaralo"
          external
          desc="Account, preferences, and subscriptions."
        />

        <NavCard
          title="Upgrade"
          href="https://www.elaralo.com/pricing-plans/list"
          external
          desc="Plans and billing."
        />

        <NavCard
          title="Companions (this page)"
          href="/companion"
          desc="You are here. Use as a quick-start hub."
          highlight
        />

        <NavCard
          title="Docs"
          href="/docs"
          desc="Project docs or API docs (wire up your route)."
        />

        <NavCard
          title="Site"
          href="/site"
          desc="Static site endpoint exposed by the backend (if configured)."
        />

        <NavCard
          title="Health"
          href="/health"
          desc="Backend health probe (proxied route or API path)."
        />
      </section>

      {/* Helper notes */}
      <footer style={{ color: "#666", fontSize: 13, textAlign: "center" }}>
        <p style={{ margin: 0 }}>
          Logo source: <code>/public/elaralo-logo.png</code> (default avatar).
        </p>
        <p style={{ margin: 0 }}>
          To make this the landing page, either copy this component to{" "}
          <code>app/page.tsx</code> or add a redirect from <code>/</code> to{" "}
          <code>/companion</code> in <code>next.config.js</code>.
        </p>
      </footer>
    </main>
  );
}

/* --------- Small, dependency-free “card” component --------- */
function NavCard({
  title,
  desc,
  href,
  external = false,
  highlight = false,
}: {
  title: string;
  desc: string;
  href: string;
  external?: boolean;
  highlight?: boolean;
}) {
  const card = (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      style={{
        display: "block",
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: "1rem 1rem",
        textDecoration: "none",
        background: highlight ? "rgba(17,17,17,0.03)" : "white",
        transition: "transform 120ms ease, box-shadow 120ms ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
      }}
      onMouseOver={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLAnchorElement).style.boxShadow =
          "0 6px 16px rgba(0,0,0,0.08)";
      }}
      onMouseOut={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.transform = "none";
        (e.currentTarget as HTMLAnchorElement).style.boxShadow =
          "0 1px 2px rgba(0,0,0,0.05)";
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h3>
      <p style={{ margin: "6px 0 0", color: "#444", lineHeight: 1.4 }}>{desc}</p>
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "#888" }}>
        {external ? "Opens in a new tab" : "Internal route"}
      </p>
    </a>
  );

  // Prefer Next Link for internal routes for prefetch benefits
  if (!external && href.startsWith("/")) {
    return (
      <Link href={href} style={{ textDecoration: "none" }}>
        {card}
      </Link>
    );
  }
  return card;
}
