import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "inferlog",
  description: "Inference logging & ingestion for an LLM chatbot",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold tracking-tight">
                infer<span className="text-cyan">log</span>
              </span>
              <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                v0.1
              </span>
            </Link>
            <nav className="flex items-center gap-1 font-mono text-xs">
              <Link
                href="/"
                className="rounded px-3 py-1.5 text-zinc-300 hover:bg-ink-700"
              >
                chat
              </Link>
              <Link
                href="/dashboard"
                className="rounded px-3 py-1.5 text-zinc-300 hover:bg-ink-700"
              >
                dashboard
              </Link>
            </nav>
          </header>
          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
