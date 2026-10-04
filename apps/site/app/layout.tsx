import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk, Literata } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { SITE_URL } from "@/lib/source";
import "./globals.css";

const familjen = Familjen_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-familjen",
  display: "swap",
});

const literata = Literata({
  subsets: ["latin", "latin-ext"],
  variable: "--font-literata",
  display: "swap",
  axes: ["opsz"],
});

const description =
  "A local-first outliner in the spirit of Logseq. Your notes live in SQLite and plain markdown on your own disk, sync through a server you run, and agents can read and edit them over MCP.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "nooklet: a local-first outliner", template: "%s | nooklet" },
  description,
  applicationName: "nooklet",
  openGraph: {
    type: "website",
    siteName: "nooklet",
    title: "nooklet: a local-first outliner",
    description,
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4f1" },
    { media: "(prefers-color-scheme: dark)", color: "#141b18" },
  ],
};

// Runs before first paint so a stored theme choice never flashes the other theme. Wrapped in
// try/catch: storage can throw in private windows, and then the system preference applies.
const themeScript = `try{var t=localStorage.getItem("nooklet-site-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${familjen.variable} ${literata.variable}`} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant string, see themeScript */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
