/**
 * "Is the embedding provider actually there, and does it have that model?"
 *
 * Exists because the two failures people actually hit when turning semantic search on — Ollama
 * isn't running, or the model was never pulled — both surface from the providers themselves as
 * something useless. `OllamaProvider.dims()` swallows a failed `/api/show` and falls back to a
 * probe embed, so an unreachable host arrives as a bare `TypeError: fetch failed` and a missing
 * model as a raw HTTP body, several layers from anything a person can act on. Asking the host
 * what it has, before asking it to do anything, turns both into a sentence with a fix in it.
 *
 * Cheap and bounded: one GET with a short timeout. Never throws — an unreachable host is an
 * answer, not an exception.
 */

import type { EmbeddingSettings } from "./settings.js";

export interface ProviderProbe {
  /** `null` when this provider kind has nothing to probe (the fake/plugin providers). */
  reachable: boolean | null;
  /** Model names the host advertises, or `null` when it cannot be asked. */
  availableModels: string[] | null;
  /** Whether `settings.model` is among them; `null` when the list is unknown. */
  modelAvailable: boolean | null;
  /** Why it is unreachable, in the words the fetch failed with. */
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 2500;

/** An error as one line, with `fetch`'s `.cause` attached. Also used by `./semantic-search.ts`. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // `fetch` reports a refused connection as an opaque "fetch failed" with the real reason on
    // `.cause` — which is the half that tells you it was ECONNREFUSED rather than DNS or TLS.
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    return causeMessage && causeMessage !== err.message
      ? `${err.message}: ${causeMessage}`
      : err.message;
  }
  return String(err);
}

/**
 * An Ollama tag is `name:tag` ("bge-m3:latest"); people type the bare name. Treat a bare name as
 * matching any tag of it, so "bge-m3" finds "bge-m3:latest" — otherwise the honest-looking error
 * ("that model is not available") would be wrong for the most common input there is.
 */
function modelMatches(available: string, wanted: string): boolean {
  if (available === wanted) return true;
  if (!wanted.includes(":") && available.startsWith(`${wanted}:`)) return true;
  return false;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Ask the configured host what models it has. `settings.host` is used verbatim (minus a trailing
 * slash) so what is probed is exactly what the providers will later call.
 */
export async function probeEmbeddingProvider(
  settings: EmbeddingSettings,
  opts: { timeoutMs?: number } = {},
): Promise<ProviderProbe> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = settings.host.replace(/\/+$/, "");

  if (settings.provider === "fake" || settings.provider === "plugin") {
    // In-process: there is no host to reach, and claiming "reachable: true" would be a guess.
    return { reachable: null, availableModels: null, modelAvailable: null, error: null };
  }

  try {
    if (settings.provider === "openai-compat") {
      const body = (await getJson(`${host}/v1/models`, timeoutMs)) as {
        data?: Array<{ id?: unknown }>;
      };
      const models = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      return {
        reachable: true,
        availableModels: models,
        modelAvailable: models.some((m) => modelMatches(m, settings.model)),
        error: null,
      };
    }

    const body = (await getJson(`${host}/api/tags`, timeoutMs)) as {
      models?: Array<{ name?: unknown }>;
    };
    const models = (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string");
    return {
      reachable: true,
      availableModels: models,
      modelAvailable: models.some((m) => modelMatches(m, settings.model)),
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      availableModels: null,
      modelAvailable: null,
      error: messageOf(err),
    };
  }
}
