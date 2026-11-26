import Link from "next/link";
import { CassetteTape } from "lucide-react";
import { NavLinks } from "./nav-links";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link
            href="/live"
            className="flex items-center gap-2 rounded-lg text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <CassetteTape aria-hidden="true" className="size-7" />
            <span className="font-mono text-xl font-bold tracking-widest">GHOSTLINE</span>
          </Link>
          <NavLinks />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 text-base">{children}</main>
    </div>
  );
}
