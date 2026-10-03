/**
 * The graph view: every page as a node, every `[[link]]`/`#tag` as an edge — the picture Logseq
 * and Obsidian both have, and the only view that answers "what is connected to what" rather than
 * "what does it say".
 *
 * Edges come from the server (`graph.links`), not the local replica: `ref` is a server-only
 * derived table (docs/spec/sql-schema.md rule 1), so the client cannot compute a single edge on
 * its own. Same reason search and linked references go over HTTP — see `data/api-client.ts`.
 *
 * Journals are off by default, as in the all-pages list, and for a stronger reason than
 * decluttering: in a daily-notes graph most links are *written* in journal entries, so hiding
 * journal nodes also hides the references that live on them. The server says so in `note` and the
 * view renders it, because a graph that is sparse for a reason looks identical to one that is
 * sparse because ref extraction is broken.
 *
 * Why a hand-rolled layout instead of `d3-force`: the simulation below is ~90 lines with no
 * dependencies, against ~60 kB of d3-force + d3-zoom shipped to a phone for a force model we use
 * a quarter of. The one thing d3-force has that this does not is a quadtree, which is why
 * repulsion here uses a uniform grid with a hard cutoff instead (see `tick`).
 *
 * Measured (a standalone run of `tick` over synthetic scale-free graphs, before wiring it up):
 * 50 nodes settle in 259 ticks / 12 ms, 500 in 259 / 132 ms, 2,000 nodes / 3,200 edges in 85
 * ticks / 356 ms — 4.2 ms per tick, inside a 16 ms frame with the drawing on top. The two
 * degradations that buy that are in `buildSim` (a big graph cools roughly three times faster, so
 * it stops instead of grinding) and in the label pass (`LABEL_BUDGET`).
 */

import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  ApiError,
  describeError,
  type GraphEdge,
  type GraphNode,
  NO_SYNC_TARGET_CODE,
} from "../data/api-client.js";
import { displayRefName } from "../data/page-title.js";
import { useGraphLinks } from "../data/store.js";
import { pageRoutePath, rawAnchorHref } from "../routes/page-path.js";
import "./graph.css";

// ---------------------------------------------------------------------------------------------
// Layout: a small force simulation. Pure — no DOM, no Solid — so it can be reasoned about (and
// timed) on its own.
// ---------------------------------------------------------------------------------------------

interface SimNode extends GraphNode {
  /** Rank in the server's most-connected-first order; also the label priority. */
  order: number;
  /** Edges incident to this node, for the spring bias and the drawn radius. */
  degree: number;
  neighbours: Set<SimNode>;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimEdge {
  a: SimNode;
  b: SimNode;
  weight: number;
}

interface Sim {
  nodes: SimNode[];
  edges: SimEdge[];
  alpha: number;
  alphaDecay: number;
}

/** Repulsion cutoff, and therefore the spatial grid's cell size. */
const CELL = 96;
const REPULSION = 1400;
const SPRING = 0.06;
const SPRING_LENGTH = 48;
/** Pull toward the origin. Weak, but it is the only thing holding disconnected components
 * together now that repulsion has a cutoff and cannot push them apart at long range. */
const GRAVITY = 0.0015;
const VELOCITY_DECAY = 0.78;
const MAX_SPEED = 30;
const ALPHA_MIN = 0.02;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function buildSim(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Sim {
  const byId = new Map<string, SimNode>();
  const simNodes = nodes.map((n, i) => {
    // Phyllotaxis, not `Math.random()`. Two reasons: the graph then looks the same every time you
    // open it, which is what lets you build a memory of where things are; and no two nodes ever
    // start coincident, which is the case that makes a random start occasionally fire a pair off
    // to infinity on the first tick.
    const angle = i * GOLDEN_ANGLE;
    const radius = 14 * Math.sqrt(i + 0.5);
    const node: SimNode = {
      ...n,
      order: i,
      degree: 0,
      neighbours: new Set(),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
    byId.set(n.id, node);
    return node;
  });

  const simEdges: SimEdge[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    // An endpoint outside the node set is normal, not a bug: `graph.links` caps the node list and
    // says so, and an edge to a page that was cut has nothing to attach to.
    if (!a || !b || a === b) continue;
    simEdges.push({ a, b, weight: e.count });
    a.degree++;
    b.degree++;
    a.neighbours.add(b);
    b.neighbours.add(a);
  }

  // A big graph cools about three times faster (85 ticks instead of 259). Stopping early is the
  // degradation the brief asks for: a slightly under-relaxed 2,000-node layout is a picture, a
  // simulation that never stops is a hot laptop.
  const alphaDecay = simNodes.length > 600 ? 0.955 : 0.985;
  return { nodes: simNodes, edges: simEdges, alpha: 1, alphaDecay };
}

function tick(sim: Sim): void {
  const { nodes, edges, alpha } = sim;

  // Repulsion, bucketed into a uniform grid with a hard cutoff at one cell. This is the place
  // where the obvious implementation is wrong: every-pair repulsion is O(n²), i.e. four million
  // distance checks per frame at 2,000 nodes, which freezes the tab. Repulsion past ~100 px is
  // invisible anyway, so the cutoff costs nothing you could see and turns the loop into O(n).
  const buckets = new Map<string, SimNode[]>();
  for (const n of nodes) {
    const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  }
  for (const n of nodes) {
    const cx = Math.floor(n.x / CELL);
    const cy = Math.floor(n.y / CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = buckets.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const m of bucket) {
          if (m === n) continue;
          let dx = n.x - m.x;
          let dy = n.y - m.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > CELL * CELL) continue;
          if (d2 < 1) {
            // Coincident: nudge deterministically by rank rather than randomly, so a reload does
            // not produce a different picture, and so the pair separates instead of dividing by 0.
            dx = (n.order - m.order) * 0.01 + 0.05;
            dy = 0.05;
            d2 = dx * dx + dy * dy;
          }
          const f = (REPULSION * alpha) / (d2 * Math.sqrt(d2));
          n.vx += dx * f;
          n.vy += dy * f;
        }
      }
    }
  }

  for (const e of edges) {
    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    // Weight is capped: a page linked forty times from one other page should read as "strongly
    // connected", not drag that pair into its own distant orbit.
    const f = (d - SPRING_LENGTH) * SPRING * alpha * Math.min(e.weight, 3);
    const ux = dx / d;
    const uy = dy / d;
    // Share the correction inversely to degree (d3-force's link bias): a hub must not be dragged
    // around by each of its leaves, or the whole graph rotates around whatever has most links.
    const total = e.a.degree + e.b.degree;
    const sa = total > 0 ? e.b.degree / total : 0.5;
    const sb = 1 - sa;
    e.a.vx += ux * f * sa;
    e.a.vy += uy * f * sa;
    e.b.vx -= ux * f * sb;
    e.b.vy -= uy * f * sb;
  }

  for (const n of nodes) {
    n.vx -= n.x * GRAVITY * alpha;
    n.vy -= n.y * GRAVITY * alpha;
    n.vx *= VELOCITY_DECAY;
    n.vy *= VELOCITY_DECAY;
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > MAX_SPEED) {
      n.vx = (n.vx / speed) * MAX_SPEED;
      n.vy = (n.vy / speed) * MAX_SPEED;
    }
    n.x += n.vx;
    n.y += n.vy;
  }

  sim.alpha *= sim.alphaDecay;
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

const FONT =
  '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MIN_SCALE = 0.05;
const MAX_SCALE = 6;
/** Labels past this many stop being readable and start being the frame budget. */
const LABEL_BUDGET = 140;
/** Below this zoom a label is a smudge, so only the hovered neighbourhood keeps one. */
const LABEL_MIN_SCALE = 0.35;
/** Up to this many nodes, the hidden list's positions track the canvas every frame; past it they
 * are written only when the layout settles or a gesture ends. Two attribute writes per node per
 * frame is affordable at 300 nodes and is exactly what makes 2,000 crawl. */
const ANCHOR_LIVE_LIMIT = 300;
const TAU = Math.PI * 2;

interface Palette {
  fg: string;
  muted: string;
  accent: string;
  hairline: string;
}

/** Canvas pixels are outside the CSS cascade, so the theme has to be sampled rather than
 * inherited — this is what makes the graph follow a light/dark switch without a reload. Once per
 * frame, which is nothing next to the drawing it precedes. */
function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    fg: read("--fg", "#111114"),
    muted: read("--muted", "#6b6b73"),
    accent: read("--accent", "#3358e0"),
    hairline: read("--hairline", "#e4e4e8"),
  };
}

function radiusOf(n: SimNode): number {
  return Math.min(2.5 + Math.sqrt(n.refCount) * 1.6, 12);
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

export function GraphView(): JSX.Element {
  const navigate = useNavigate();
  const [showJournals, setShowJournals] = createSignal(false);
  const [graph] = useGraphLinks(() => ({ includeJournals: showJournals() }));
  // Reading an errored resource re-throws, so every read goes through this.
  const data = () => (graph.error !== undefined ? undefined : graph());
  const [hovered, setHovered] = createSignal<SimNode | null>(null);
  const [settled, setSettled] = createSignal(false);

  let canvas: HTMLCanvasElement | undefined;
  let sim: Sim | undefined;
  /** View transform, in plain variables rather than signals: it changes on every pointermove and
   * must repaint a canvas, not re-render a component. */
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let width = 0;
  let height = 0;
  /** Once the reader has framed the graph themselves, stop re-framing it for them. */
  let userMoved = false;
  let rafId = 0;

  /** Node -> its `<li>` in the hidden list, so the list can carry each node's current position.
   * A canvas has no DOM, so this is the only handle anything outside the render loop has on where
   * a node actually is — `e2e/tests/graph.spec.ts` clicks nodes through it. Synced when the
   * layout settles and when a gesture ends, never per frame: two attribute writes per node per
   * frame is exactly the kind of thing that makes 2,000 nodes crawl. */
  const anchors = new Map<string, HTMLLIElement>();

  const toScreen = (n: SimNode): { x: number; y: number } => ({
    x: n.x * scale + tx,
    y: n.y * scale + ty,
  });

  function syncAnchors(): void {
    if (!sim) return;
    for (const n of sim.nodes) {
      const li = anchors.get(n.id);
      if (!li) continue;
      const p = toScreen(n);
      li.dataset.x = String(Math.round(p.x));
      li.dataset.y = String(Math.round(p.y));
    }
  }

  function fit(): void {
    if (!sim || sim.nodes.length === 0 || width === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of sim.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 32;
    const next = Math.min(
      (width - pad * 2) / Math.max(maxX - minX, 1),
      (height - pad * 2) / Math.max(maxY - minY, 1),
      2,
    );
    scale = Math.max(Math.min(next, MAX_SCALE), MIN_SCALE);
    tx = width / 2 - ((minX + maxX) / 2) * scale;
    ty = height / 2 - ((minY + maxY) / 2) * scale;
  }

  function draw(): void {
    const el = canvas;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const colors = readPalette(el);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!sim || sim.nodes.length === 0) return;

    const focus = hovered();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);

    // One path for every un-highlighted edge, one stroke: a stroke per edge is the difference
    // between a smooth 3,000-edge graph and a stuttering one.
    ctx.strokeStyle = colors.hairline;
    ctx.globalAlpha = sim.edges.length > 2000 ? 0.5 : 0.9;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    for (const e of sim.edges) {
      if (focus && (e.a === focus || e.b === focus)) continue;
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
    }
    ctx.stroke();

    if (focus) {
      ctx.strokeStyle = colors.accent;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.8 / scale;
      ctx.beginPath();
      for (const e of sim.edges) {
        if (e.a !== focus && e.b !== focus) continue;
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.stroke();
    }

    // Nodes, batched into three paths by colour for the same reason as the edges above.
    const pages = new Path2D();
    const journals = new Path2D();
    const highlit = new Path2D();
    const onScreen: SimNode[] = [];
    for (const n of sim.nodes) {
      const p = toScreen(n);
      if (p.x < -40 || p.y < -40 || p.x > width + 40 || p.y > height + 40) continue;
      onScreen.push(n);
      const r = radiusOf(n);
      const target = focus
        ? n === focus || focus.neighbours.has(n)
          ? highlit
          : n.isJournal
            ? journals
            : pages
        : n.isJournal
          ? journals
          : pages;
      target.moveTo(n.x + r, n.y);
      target.arc(n.x, n.y, r, 0, TAU);
    }
    ctx.globalAlpha = focus ? 0.28 : 1;
    ctx.fillStyle = colors.fg;
    ctx.fill(pages);
    ctx.fillStyle = colors.muted;
    ctx.fill(journals);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.accent;
    ctx.fill(highlit);

    // Labels in screen space, so they stay 11 px however far the graph is zoomed out.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    const labelled = new Set<SimNode>();
    if (focus) {
      ctx.fillStyle = colors.accent;
      for (const n of [focus, ...focus.neighbours]) {
        const p = toScreen(n);
        ctx.fillText(displayRefName(n.name), p.x + radiusOf(n) * scale + 4, p.y);
        labelled.add(n);
      }
    }
    if (scale >= LABEL_MIN_SCALE) {
      ctx.globalAlpha = focus ? 0.4 : 1;
      ctx.fillStyle = colors.fg;
      let budget = LABEL_BUDGET;
      // `sim.nodes` arrives most-connected-first from the server, so spending the budget in order
      // labels the hubs — the nodes worth naming when there is no room to name them all.
      for (const n of onScreen) {
        if (budget <= 0) break;
        if (labelled.has(n)) continue;
        const p = toScreen(n);
        ctx.fillText(displayRefName(n.name), p.x + radiusOf(n) * scale + 4, p.y);
        budget--;
      }
      ctx.globalAlpha = 1;
    }
  }

  function schedule(): void {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      let justSettled = false;
      if (sim && sim.alpha > ALPHA_MIN) {
        tick(sim);
        if (!userMoved) fit();
        schedule();
        justSettled = sim.alpha <= ALPHA_MIN;
        if (justSettled) setSettled(true);
      }
      draw();
      if (sim && (justSettled || sim.nodes.length <= ANCHOR_LIVE_LIMIT)) syncAnchors();
    });
  }

  function nodeAt(px: number, py: number): SimNode | null {
    if (!sim) return null;
    let best: SimNode | null = null;
    let bestDistance = Infinity;
    // Widest any node's hit target can be, so most nodes are rejected by two comparisons rather
    // than a square root — this runs on every pointermove, over every node.
    const reach = Math.max(12 * scale, 10);
    for (const n of sim.nodes) {
      const dx = n.x * scale + tx - px;
      if (dx > reach || dx < -reach) continue;
      const dy = n.y * scale + ty - py;
      if (dy > reach || dy < -reach) continue;
      const d = Math.hypot(dx, dy);
      // A minimum of 10 px regardless of the drawn radius: a 3 px dot is impossible to hit with a
      // finger, and this view has to work on a phone.
      if (d > Math.max(radiusOf(n) * scale, 10)) continue;
      if (d < bestDistance) {
        bestDistance = d;
        best = n;
      }
    }
    return best;
  }

  onMount(() => {
    const el = canvas;
    if (!el) return;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      width = el.clientWidth;
      height = el.clientHeight;
      el.width = Math.max(1, Math.round(width * dpr));
      el.height = Math.max(1, Math.round(height * dpr));
      if (!userMoved) fit();
      syncAnchors();
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    const pointers = new Map<number, { x: number; y: number }>();
    let travelled = 0;
    let pinch = 0;

    const local = (e: PointerEvent): { x: number; y: number } => {
      const box = el.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };

    const zoomAbout = (px: number, py: number, factor: number): void => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      tx = px - (px - tx) * (next / scale);
      ty = py - (py - ty) * (next / scale);
      scale = next;
      userMoved = true;
    };

    const onPointerDown = (e: PointerEvent): void => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimisation (it keeps a pan alive when the pointer leaves the canvas);
        // a pointer the browser no longer considers active throws here, and panning without it
        // still works. Never let that take the click handler down with it.
      }
      pointers.set(e.pointerId, local(e));
      travelled = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      el.classList.add("graph-canvas-dragging");
    };

    const onPointerMove = (e: PointerEvent): void => {
      const p = local(e);
      const previous = pointers.get(e.pointerId);
      if (!previous) {
        const hit = nodeAt(p.x, p.y);
        if (hit !== hovered()) {
          setHovered(hit);
          schedule();
        }
        return;
      }
      pointers.set(e.pointerId, p);
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) {
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch > 0 && distance > 0) {
            zoomAbout((a.x + b.x) / 2, (a.y + b.y) / 2, distance / pinch);
          }
          pinch = distance;
        }
      } else {
        tx += p.x - previous.x;
        ty += p.y - previous.y;
        travelled += Math.hypot(p.x - previous.x, p.y - previous.y);
        userMoved = true;
      }
      schedule();
    };

    const onPointerUp = (e: PointerEvent): void => {
      const p = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      pinch = 0;
      if (pointers.size === 0) el.classList.remove("graph-canvas-dragging");
      syncAnchors();
      // A drag that happens to end over a node is a pan, not a click. 5 px of slack, because a
      // finger never lifts from exactly where it landed.
      if (!p || travelled > 5 || e.type !== "pointerup") return;
      const hit = nodeAt(p.x, p.y);
      if (hit) navigate(pageRoutePath(hit.name));
    };

    const onWheel = (e: WheelEvent): void => {
      // Not passive, and preventDefault is required: without it the wheel scrolls the shell's one
      // scroll container out from under the graph while zooming it.
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomAbout(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0015));
      schedule();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    onCleanup(() => {
      observer.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
    });
  });

  createEffect(() => {
    const result = data();
    if (!result) return;
    sim = buildSim(result.nodes, result.edges);
    setHovered(null);
    setSettled(false);
    userMoved = false;
    fit();
    schedule();
  });

  const refit = (): void => {
    userMoved = false;
    fit();
    syncAnchors();
    schedule();
  };

  return (
    <div class="graph-view">
      <header class="graph-header">
        <h1>
          Graph{" "}
          <span class="graph-count">
            {data()?.nodes.length ?? 0} pages · {data()?.edges.length ?? 0} links
          </span>
        </h1>
        <label class="graph-toggle">
          <input
            type="checkbox"
            checked={showJournals()}
            onChange={(e) => setShowJournals(e.currentTarget.checked)}
          />
          Journals
        </label>
        <button type="button" class="graph-fit" onClick={refit}>
          Fit
        </button>
      </header>

      <Show when={graph.loading && data() === undefined}>
        <p class="graph-status">Loading the link graph…</p>
      </Show>
      {/* B-577: no sync target at all means there was never a server to ask — calm, not alarming. */}
      <Show when={graph.error instanceof ApiError && graph.error.code === NO_SYNC_TARGET_CODE}>
        <p class="graph-status">The graph needs a server — not available in local-only mode.</p>
      </Show>
      <Show
        when={
          graph.error !== undefined &&
          !(graph.error instanceof ApiError && graph.error.code === NO_SYNC_TARGET_CODE)
        }
      >
        <p class="graph-status graph-error" role="alert">
          Couldn't load the graph: {describeError(graph.error)}
        </p>
      </Show>
      <Show when={data()?.note}>{(note) => <p class="graph-status graph-note">{note()}</p>}</Show>
      <Show when={data() && data()?.nodes.length === 0}>
        <p class="graph-status">
          Nothing to draw yet — link a page with <code>[[double brackets]]</code> or a{" "}
          <code>#tag</code> and it will appear here.
        </p>
      </Show>

      <div
        class="graph-canvas-wrap"
        data-node-count={data()?.nodes.length ?? 0}
        data-edge-count={data()?.edges.length ?? 0}
        data-settled={settled() ? "true" : "false"}
      >
        <canvas
          class="graph-canvas"
          ref={canvas}
          role="img"
          aria-label={`Link graph of ${data()?.nodes.length ?? 0} pages. Every page is also listed below.`}
        />
        <Show when={hovered()}>
          {(node) => (
            <p class="graph-hover">
              {displayRefName(node().name)} · {node().refCount} reference(s)
            </p>
          )}
        </Show>
      </div>

      {/* Visually hidden, genuinely present: a canvas is invisible to a screen reader and
          unreachable by keyboard, so the same nodes are also a plain list of links. It unhides on
          focus so a keyboard user can see where they are. */}
      <ul class="graph-node-list" aria-label="Pages in the graph">
        <For each={data()?.nodes ?? []}>
          {(node) => (
            <li
              data-node-id={node.id}
              ref={(li) => {
                anchors.set(node.id, li);
                onCleanup(() => anchors.delete(node.id));
              }}
            >
              {/* ADR 025: a raw `<a>` (plain browser navigation, no onClick override) — see
                  `rawAnchorHref`'s doc comment for why this one needs the prefix itself. */}
              <a href={rawAnchorHref(pageRoutePath(node.name))}>{displayRefName(node.name)}</a>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
