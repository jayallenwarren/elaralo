/* app/page.tsx */
'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';

const AUTO = String(process.env.NEXT_PUBLIC_AUTO_REDIRECT_MY || '').toLowerCase() === 'true';
const MY_URL = 'https://www.elaralo.com/myelaralo';

export default function Home() {
  useEffect(() => {
    if (AUTO && typeof window !== 'undefined') {
      const t = setTimeout(() => window.location.assign(MY_URL), 2000);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <section className="grid gap-8">
      <div className="flex items-center gap-4">
        <Image src="/elaralo-logo.png" alt="Elaralo" width={64} height={64} />
        <div>
          <h1 className="text-3xl font-bold">My Elaralo</h1>
          <p className="text-neutral-600">
            Central hub for your account, subscriptions, and settings.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={MY_URL}
          target="_blank"
          className="rounded-lg border px-4 py-2 font-medium hover:border-black/60"
        >
          Open My Elaralo
        </a>
        {AUTO ? (
          <span className="text-sm text-neutral-600">Auto-redirecting…</span>
        ) : (
          <span className="text-sm text-neutral-600">
            (Enable auto redirect by setting <code>NEXT_PUBLIC_AUTO_REDIRECT_MY=true</code>)
          </span>
        )}
      </div>

      <hr className="my-4" />

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Companion"
          desc="Health check and quick developer actions."
          href="/companion"
        />
        <Card
          title="Upgrade"
          desc="Plans & billing details."
          href="https://www.elaralo.com/pricing-plans/list"
          external
        />
        <Card
          title="API Docs"
          desc="OpenAPI / Swagger UI for the backend."
          href="https://elaralo-api-01.azurewebsites.net/docs"
          external
        />
        <Card
          title="Marketing Site"
          desc="Static site served by backend."
          href="https://elaralo-api-01.azurewebsites.net/site/"
          external
        />
      </div>
    </section>
  );
}

function Card({
  title,
  desc,
  href,
  external = false,
}: {
  title: string;
  desc: string;
  href: string;
  external?: boolean;
}) {
  const cls = 'block rounded-lg border p-4 hover:border-black/60';
  return external ? (
    <a href={href} target="_blank" className={cls}>
      <div className="font-semibold">{title}</div>
      <div className="text-sm text-neutral-600">{desc}</div>
    </a>
  ) : (
    <Link href={href} className={cls}>
      <div className="font-semibold">{title}</div>
      <div className="text-sm text-neutral-600">{desc}</div>
    </Link>
  );
}
