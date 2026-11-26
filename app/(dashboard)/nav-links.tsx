"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

const LINKS = [
  { href: "/live", label: "Live", prefix: "/live" },
  { href: "/calls", label: "Calls", prefix: "/calls" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex items-center gap-2">
        {LINKS.map(({ href, label, prefix }) => {
          const active = pathname === prefix || pathname.startsWith(`${prefix}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  buttonVariants({ variant: active ? "secondary" : "ghost" }),
                  "h-10 px-4 text-base",
                  active && "underline underline-offset-4",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
