/* app/layout.tsx */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Elaralo',
  description: 'Elaralo Web',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-black antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-3">
              <Image src="/elaralo-logo.png" alt="Elaralo" width={32} height={32} />
              <span className="font-semibold tracking-tight">Elaralo</span>
            </Link>

            <nav className="ml-auto flex items-center gap-4 text-sm">
              <a className="hover:underline" href="https://www.elaralo.com/myelaralo" target="_blank">My Elaralo</a>
              <Link className="hover:underline" href="/companion">Companion</Link>
              <a className="hover:underline" href="https://www.elaralo.com/pricing-plans/list" target="_blank">Upgrade</a>
              <a className="hover:underline" href="https://elaralo-api-01.azurewebsites.net/docs" target="_blank">API Docs</a>
              <a className="hover:underline" href="https://elaralo-api-01.azurewebsites.net/site/" target="_blank">Marketing Site</a>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
