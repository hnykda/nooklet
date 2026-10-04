"use client";

import { type ReactNode, useEffect, useRef } from "react";

const WIDE = "(min-width: 900px)";

/**
 * The docs page list. On a phone it is a closed disclosure above the article, so the article is
 * what you see first; on a wide screen it is an always-open sidebar. It renders closed, CSS
 * (`::details-content`) shows the list on wide screens where the browser supports it, and this
 * effect sets `open` there too for browsers that do not.
 */
export function SidebarDisclosure({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const apply = () => {
      if (ref.current && mq.matches) ref.current.open = true;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return (
    <details ref={ref}>
      <summary>Docs pages</summary>
      {children}
    </details>
  );
}
