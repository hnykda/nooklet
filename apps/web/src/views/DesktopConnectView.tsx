/**
 * The desktop app's screen for a server graph it has no working token for (proposal 005, ADR 032).
 *
 * The shell hands a server graph's page its token from the keychain before any script runs. A page
 * without one is a graph whose token was never stored there: one listed by an older version (its
 * `desktop.json` migrated without tokens, which were in each origin's own storage), or a graph on a
 * server reached some other way. The server refused the token (revoked) is the other case.
 *
 * Either way the answer is the same add form as the graph menu's "Connect to a server", pre-filled
 * with this graph's address (and, the first time after an update, with the token the older version
 * kept here: one click moves it to the keychain). No "Just this device", no token-only field, no
 * second screen (B-782, B-783). Other graphs are one click away below it, so the screen is never a
 * dead end without the graph menu.
 */
import Laptop from "lucide-solid/icons/laptop";
import Server from "lucide-solid/icons/server";
import { For, type JSX, Show } from "solid-js";
import { legacyDesktopToken, samePathGraphPrefix } from "../data/bootstrap.js";
import {
  currentDesktopGraph,
  type DesktopShell,
  onBundledServer,
} from "../platform/desktop-shell.js";
import { DesktopAddGraph } from "../shell/DesktopAddGraph.js";
import { hostOf } from "../shell/desktop-graphs.js";
import "./connect.css";
import "./graph-mismatch.css";
import "../shell/desktop-graphs.css";

export function DesktopConnectView(props: {
  shell: DesktopShell;
  /** The server refused the token this Mac had (B-613's case), rather than there being none. */
  rejected?: boolean;
  /** From a pairing link (B-603/B-655): its address and its code or token. */
  prefill?: { address: string; credential: string };
  onCancel?: () => void;
}): JSX.Element {
  const here = currentDesktopGraph(props.shell.graphs);
  const address =
    props.prefill?.address ?? here?.address ?? `${location.origin}${samePathGraphPrefix() ?? ""}`;
  const name = props.prefill ? hostOf(address) : (here?.label ?? hostOf(address));
  const legacy = props.prefill || props.rejected ? undefined : legacyDesktopToken();
  const others = props.shell.graphs.filter((g) => g.key !== here?.key);

  return (
    <div class="graph-mismatch-scroll">
      <main class="connect" aria-label="Connect to a server">
        <Show when={props.onCancel}>
          <button type="button" class="connect-back" onClick={() => props.onCancel?.()}>
            ‹ Back
          </button>
        </Show>
        <Show
          when={props.rejected}
          fallback={<h1>{props.prefill ? `Connect to ${name}?` : `Connect to ${name}`}</h1>}
        >
          <h1>The server refused this Mac's token</h1>
        </Show>
        <p class="connect-lede">
          <Show
            when={props.rejected}
            fallback={
              <Show
                when={props.prefill}
                fallback={
                  <>
                    To open this graph, nooklet needs a device token for <code>{address}</code>. It
                    is kept in this Mac's keychain.
                    <Show when={legacy}>
                      {" "}
                      The token an earlier version of nooklet used here is filled in: Connect moves
                      it to the keychain.
                    </Show>
                  </>
                }
              >
                A pairing link asked to connect this Mac to <code>{address}</code>. Connect only if
                it is yours.
              </Show>
            }
          >
            <code>{address}</code> refused the token this Mac was using, most likely because it was
            revoked. Your notes and any changes not yet synced are kept on this Mac, and are sent
            once a new token is accepted.
          </Show>
        </p>
        <DesktopAddGraph
          shell={props.shell}
          address={address}
          token={props.prefill?.credential ?? legacy}
          connectOnly
        />
        <Show when={others.length > 0}>
          <section class="connect-elsewhere" aria-labelledby="desktop-connect-others">
            <h2 id="desktop-connect-others">Open another graph instead</h2>
            <ul class="desktop-graph-choices">
              <For each={others}>
                {(graph) => (
                  <li>
                    {/* The shell routes this navigation, as from the graph menu. */}
                    <button type="button" onClick={() => location.assign(graph.address)}>
                      <span>
                        <Show
                          when={graph.place === "mac"}
                          fallback={<Server size={13} aria-hidden="true" />}
                        >
                          <Laptop size={13} aria-hidden="true" />
                        </Show>{" "}
                        {graph.label}
                      </span>
                      <span class="desktop-graph-where">
                        {graph.place === "mac" ? "on this Mac" : hostOf(graph.address)}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={!onBundledServer(props.shell)}>
          <p class="connect-why">
            Sending a token over plain HTTP exposes it to anyone on the network path. Outside a
            trusted LAN, put the server behind HTTPS or reach it over a tailnet such as Tailscale.
          </p>
        </Show>
      </main>
    </div>
  );
}
