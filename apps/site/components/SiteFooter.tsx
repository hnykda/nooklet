import Link from "next/link";
import { REPO_URL } from "@/lib/links";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <span>nooklet is open source under the MIT license.</span>
        <a href={REPO_URL}>Source on GitHub</a>
        <Link href="/docs">Docs</Link>
        <Link href="/decisions">Design decisions</Link>
        <a href="/llms.txt">llms.txt</a>
      </div>
    </footer>
  );
}
