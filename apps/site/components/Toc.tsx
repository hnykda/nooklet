"use client";

import { useEffect, useState } from "react";
import type { TocItem } from "@/lib/render";

/** "On this page", with the section you are reading marked. */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (!headings.length) return;
    const onScroll = () => {
      // The last heading above the top fifth of the viewport is the one being read.
      const line = window.innerHeight * 0.2;
      let current = headings[0]?.id ?? null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= line) current = h.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [items]);

  return (
    <nav className="docs-toc" aria-label="On this page">
      <h2>On this page</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={`toc-${i.depth}`}>
            <a href={`#${i.id}`} data-active={active === i.id}>
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
