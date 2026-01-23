"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_COMPANION_NAME =
  process.env.NEXT_PUBLIC_DEFAULT_COMPANION_NAME || "Elara";

export default function HomePage() {
  const router = useRouter();

  const [companionKey, setCompanionKey] = useState<string>("");

  const nextUrl = useMemo(() => {
    const url = new URL("http://local/companion");
    if (companionKey.trim()) url.searchParams.set("companion_key", companionKey.trim());
    return url.pathname + url.search;
  }, [companionKey]);

  return (
    <div className="page">
      <div className="card" style={{ padding: 18 }}>
        <div className="headerRow">
          <img
            className="avatar"
            src="/elaralo_logo.png"
            alt="Elaralo"
          />
          <div className="headerText">
            <h1 className="h1">Elaralo</h1>
            <div className="subline">
              Choose a companion and start a session.
            </div>
            <div className="subline" style={{ marginTop: 10 }}>
              Default companion: <strong>{DEFAULT_COMPANION_NAME}</strong>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontWeight: 750, marginBottom: 8 }}>
            Companion Key (optional)
          </div>
          <input
            className="textInput"
            value={companionKey}
            onChange={(e) => setCompanionKey(e.target.value)}
            placeholder="Paste a companion_key here (optional)"
            style={{ width: "100%" }}
          />
          <div className="mutedNote" style={{ marginTop: 10 }}>
            If you do not provide a companion_key, the companion page will use defaults.
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
            <button className="btn" onClick={() => router.push(nextUrl)}>
              Open Companion
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
