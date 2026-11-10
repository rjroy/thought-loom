"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
  { href: "/explore", label: "Explore" },
  { href: "/browse", label: "Browse" },
  { href: "/capture", label: "Capture" },
  { href: "/settings", label: "Settings" },
] as const;

export function PrimaryNavigation() {
  const pathname = usePathname();

  return (
    <nav className="primary-navigation" aria-label="Main navigation">
      {destinations.map(({ href, label }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`) || (href === "/capture" && (pathname === "/import" || pathname.startsWith("/import/"))) || (href === "/explore" && pathname === "/");
        return (
          <Link key={href} href={href} className="navigation-link" aria-current={current ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
