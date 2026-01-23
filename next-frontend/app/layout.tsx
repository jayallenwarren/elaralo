import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Elaralo",
  description: "Elaralo companion experience",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="appRoot">{children}</main>
      </body>
    </html>
  );
}
