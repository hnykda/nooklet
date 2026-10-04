import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Converge } from "@/components/sync/Converge";
import { MergeDemo } from "@/components/sync/MergeDemo";
import { OpJourney } from "@/components/sync/OpJourney";
import { REPO_URL } from "@/lib/links";
import { highlight } from "@/lib/render";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const MCP_CONFIG = `{
  "mcpServers": {
    "nooklet": {
      "type": "http",
      "url": "http://127.0.0.1:6100/g/default/mcp",
      "headers": { "Authorization": "Bearer \${NOOKLET_TOKEN}" }
    }
  }
}`;

const MIRROR_SAMPLE = `type:: project

- TODO Read the ADR on sync ^1m433dkhgaxame
  - started on the HLC part ^1m433dkhgaxamf
- Ask [[Jana]] about the #trip dates ^1m433dkhgaxamg`;

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="landing-section" aria-labelledby={`${id}-title`} id={id}>
      <div className="section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {lede ? <p>{lede}</p> : null}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

const FEATURES: { title: string; body: ReactNode }[] = [
  {
    title: "Outlines",
    body: "Nested bullets you can fold, zoom into and drag. A block reference shows the text of the block it points to.",
  },
  {
    title: "Links and references",
    body: (
      <>
        <code>[[Pages]]</code>, <code>#tags</code> and namespaces. Every page lists what links to
        it, grouped by source, plus unlinked mentions.
      </>
    ),
  },
  {
    title: "Journal and tasks",
    body: "Today’s page opens first. Tasks cycle TODO, DOING, DONE with one shortcut and carry scheduled and deadline dates.",
  },
  {
    title: "Search",
    body: "Full-text search on every device. Add a local Ollama model and search by meaning too, in any language.",
  },
  {
    title: "Logseq import",
    body: "Point the importer at a Logseq file graph: pages, journals, properties and assets come across.",
  },
  {
    title: "Plugins",
    body: "TypeScript plugins with a server half and a client half: commands, slash commands, renderers, MCP tools.",
  },
];

export default async function Home() {
  const [mcpHtml, mirrorHtml] = await Promise.all([
    highlight(MCP_CONFIG, "json"),
    highlight(MIRROR_SAMPLE, "md"),
  ]);

  return (
    <main id="main" className="landing">
      <div className="spine">
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title">Your notes, in bullets, on your own machines.</h1>
          <div className="hero__children">
            <ul className="outline">
              <li className="node">
                An outliner like Logseq: nested blocks, <code>[[links]]</code>, <code>#tags</code>,
                a daily journal and tasks.
              </li>
              <li className="node">
                Every device keeps the whole graph and works offline. A server you run keeps them in
                sync.
              </li>
              <li className="node">
                Give an agent a token and it can search, read and edit your notes one bullet at a
                time, over MCP.
              </li>
            </ul>
          </div>
          <div className="cta-row">
            <Link className="button" href="/docs/getting-started">
              Get started
            </Link>
            <a className="button button--quiet" href={REPO_URL}>
              Source on GitHub
            </a>
          </div>
          <figure className="shot">
            <div className="shot__frame">
              <img
                className="theme-img--light"
                src="/screenshots/page-light.png"
                width={1280}
                height={800}
                alt="nooklet showing a project page: nested bullets with links, tags, a task with a deadline, and linked references at the bottom."
                fetchPriority="high"
              />
              <img
                className="theme-img--dark"
                src="/screenshots/page-dark.png"
                width={1280}
                height={800}
                alt="The same project page in the dark theme."
                loading="lazy"
              />
            </div>
            <figcaption>
              A project page with its tasks, links and the pages that reference it.
            </figcaption>
          </figure>
        </section>

        <Section
          id="features"
          title="What is in it"
          lede="The parts of an outliner you use every day, and nothing you would have to switch off."
        >
          <ul className="outline features">
            {FEATURES.map((f) => (
              <li key={f.title} className="node feature">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
          <figure className="shot">
            <div className="shot__frame">
              <img
                className="theme-img--light"
                src="/screenshots/journal-light.png"
                width={1280}
                height={800}
                alt="The journal: today’s page on top with tasks and links, earlier days below."
                loading="lazy"
              />
              <img
                className="theme-img--dark"
                src="/screenshots/journal-dark.png"
                width={1280}
                height={800}
                alt="The journal in the dark theme."
                loading="lazy"
              />
            </div>
            <figcaption>The journal. Today is always on top; empty days do not exist.</figcaption>
          </figure>
        </Section>

        <Section
          id="sync"
          title="How sync works"
          lede="Each edit becomes a small op. Devices push their ops to your server and pull everyone else’s."
        >
          <ol className="steps">
            <li>
              <strong>You edit on any device.</strong> The change and its op land in the device’s
              own SQLite in one transaction, online or not.
            </li>
            <li>
              <strong>The device pushes its outbox.</strong> The server checks the tree, then logs
              each op with the next sequence number.
            </li>
            <li>
              <strong>The server pokes the other devices.</strong> Each one pulls every op after the
              last number it saw.
            </li>
            <li>
              <strong>Every field merges on its own.</strong> The value with the latest clock stamp
              wins, so all devices land on the same state.
            </li>
          </ol>
          <OpJourney />
          <Converge />
        </Section>

        <Section
          id="conflicts"
          title="When two edits meet"
          lede="Two devices change the same block’s text while offline. nooklet merges the words it can and keeps the rest where you can see it."
        >
          <MergeDemo />
          <p className="section-more">
            <Link href="/docs/sync-and-offline">Read how sync, offline and conflicts work</Link>
          </p>
        </Section>

        <Section
          id="agents"
          title="Agents edit by the bullet"
          lede="The operations the app uses are also an HTTP API, an OpenAPI document and an MCP server. An agent works on blocks, not whole pages."
        >
          <div className="two-col">
            <ul className="outline prose-list">
              <li className="node">
                <code>graph_overview</code> to get its bearings, then keyword, semantic or hybrid
                search.
              </li>
              <li className="node">
                Replace an exact substring inside one bullet and leave the rest alone.
              </li>
              <li className="node">Run several edits as one atomic batch, and undo that batch.</li>
              <li className="node">
                Every change it makes carries the token’s label in page history and the audit log.
              </li>
              <li className="node">
                Nothing is on until you run <code>nooklet token create</code>.
              </li>
            </ul>
            <div>
              <span className="codeblock-label">.mcp.json</span>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted at build time from a constant */}
              <div dangerouslySetInnerHTML={{ __html: mcpHtml }} />
            </div>
          </div>
          <p className="section-more">
            <Link href="/docs/agents">Connect an agent</Link>
          </p>
        </Section>

        <Section
          id="files"
          title="Plain files you can walk away with"
          lede="SQLite holds the truth. The server also writes every page to a markdown file that Logseq and Obsidian can open."
        >
          <div className="two-col">
            <ul className="outline prose-list">
              <li className="node">One file per page, one per journal day.</li>
              <li className="node">
                The <code>^id</code> at the end of a line is the block’s stable id, so references
                survive the round trip.
              </li>
              <li className="node">
                <code>grep</code> and <code>git</code> work on the folder. Edit through the app,
                though: nooklet writes the files and does not read them back.
              </li>
            </ul>
            <div>
              <span className="codeblock-label">pages/Aurora.md</span>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted at build time from a constant */}
              <div dangerouslySetInnerHTML={{ __html: mirrorHtml }} />
            </div>
          </div>
        </Section>
      </div>

      <div className="closing">
        <p>
          Install it, write notes, and stop there if you like. Sync and agents wait until you ask.
        </p>
        <div className="cta-row cta-row--flush">
          <Link className="button" href="/docs">
            Read the docs
          </Link>
          <Link className="button button--quiet" href="/docs/getting-started">
            Install nooklet
          </Link>
        </div>
      </div>
    </main>
  );
}
