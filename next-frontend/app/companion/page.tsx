/* app/companion/page.tsx */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';

type Health = { ok: boolean; ts?: string } | { detail?: string };

const defaultApiBase =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '') ||
  'https://elaralo-api-01.azurewebsites.net';

export default function CompanionPage() {
  const API_BASE = useMemo(() => defaultApiBase, []);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        setLoading(true);
        const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        const j = (await r.json()) as Health;
        if (!cancelled) setHealth(j);
      } catch {
        if (!cancelled) setHealth({ detail: 'unreachable' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [API_BASE]);

  const statusText = (() => {
    if (loading && !health) return 'Checking…';
    if (!health) return 'Unknown';
    if ('ok' in health && health.ok) {
      return health.ts ? `Healthy (${new Date(health.ts).toLocaleString()})` : 'Healthy';
    }
    if ('detail' in health) return `Error: ${health.detail}`;
    return 'Unhealthy';
  })();

  return (
    <main className="min-h-[70vh]">
      <div className="mx-auto mb-6 flex items-center gap-3">
        <Image src="/elaralo-logo.png" alt="Elaralo" width={48} height={48} />
        <h1 className="text-2xl font-bold">Elaralo Companion</h1>
      </div>

      <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
        <span
          className={[
            'inline-block h-2.5 w-2.5 rounded-full',
            health && 'ok' in health && health.ok ? 'bg-emerald-500' : 'bg-rose-500',
          ].join(' ')}
        />
        <span className="tabular-nums">{statusText}</span>
      </div>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Action href="https://www.elaralo.com/myelaralo" title="My Elaralo" subtitle="Account" />
        <Action href="https://www.elaralo.com/pricing-plans/list" title="Upgrade" subtitle="Plans" />
        <Action href={`${API_BASE}/docs`} title="API Docs" subtitle="OpenAPI UI" />
        <Action href={`${API_BASE}/site/`} title="Marketing Site" subtitle="Static pages" />
      </div>

      <div className="mt-10 rounded-lg border p-4 text-left">
        <h2 className="font-semibold">Developer</h2>
        <ul className="mt-2 list-disc pl-6 text-sm text-neutral-700">
          <li>
            <code>NEXT_PUBLIC_API_BASE</code> ={' '}
            <code className="select-all break-all">{API_BASE}</code>
          </li>
          <li>
            Health endpoint:{' '}
            <Link className="underline" href={`${API_BASE}/health`} target="_blank">
              {API_BASE}/health
            </Link>
          </li>
          <li>Replace <code>/public/elaralo-logo.png</code> to update the logo.</li>
        </ul>
      </div>
    </main>
  );
}

function Action(props: { href: string; title: string; subtitle?: string }) {
  return (
    <Link
      href={props.href}
      target="_blank"
      className="group rounded-lg border p-4 text-left transition hover:border-black/50"
    >
      <div className="font-semibold">{props.title}</div>
      {props.subtitle && (
        <div className="text-sm text-neutral-600 group-hover:text-neutral-800">
          {props.subtitle}
        </div>
      )}
    </Link>
  );
}
