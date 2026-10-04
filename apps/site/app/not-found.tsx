import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main id="main" className="lost">
      <h1 className="hero__title-404">This page does not exist.</h1>
      <ul className="outline">
        <li className="node">
          <Link href="/">Go to the start page</Link>
        </li>
        <li className="node">
          <Link href="/docs">Browse the docs</Link>
        </li>
        <li className="node">
          Press <kbd>/</kbd> to search
        </li>
      </ul>
    </main>
  );
}
