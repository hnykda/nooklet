"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { REPO_URL } from "@/lib/links";
import { Search } from "./Search";
import { ThemeToggle } from "./ThemeToggle";

export function SiteHeader() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const current = (prefix: string) => (pathname?.startsWith(prefix) ? "page" : undefined);

  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="site-header__inner">
        <Link href="/" className="wordmark" aria-label="nooklet home">
          <span className="wordmark__dot" aria-hidden="true" />
          nooklet
        </Link>
        <nav className="site-nav" aria-label="Main">
          <Link href="/docs" aria-current={current("/docs")}>
            Docs
          </Link>
          <Link href="/decisions" aria-current={current("/decisions")}>
            Decisions
          </Link>
          <a href={REPO_URL} className="nav-github">
            GitHub
          </a>
        </nav>
        <Search />
        <ThemeToggle />
      </div>
    </header>
  );
}
