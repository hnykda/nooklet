/**
 * `embeddings.status` / `embeddings.configure` / `embeddings.reindex` — semantic search, turned on
 * from the app instead of from a terminal.
 *
 * Why these exist: every install reports `"model": null` from `system.diagnostics`, because the
 * only way to register an embedding model was `nooklet embed model <name>` — a command nobody
 * discovers. Multilingual semantic search is a headline feature that silently degraded to keyword
 * for every user who never read the CLI help. The machinery was all already there (ADR 010,
 * `../embeddings/`); what was missing was a way to reach it. These three ops are that way in, and
 * they deliberately do nothing the CLI did not already do.
 *
 * All three are HTTP-only (`expose: { mcp: false }`), which is a deliberate choice, not an
 * oversight:
 *
 *  - `configure` and `reindex` change how this machine is set up and cost real time and GPU. That
 *    is a decision the person running nooklet makes, not one an agent should make on their behalf
 *    while answering a question.
 *  - `status` would be the one plausible MCP tool, but `system.diagnostics` already answers the
 *    only question an agent has here ("is semantic search worth attempting?"), and this op reaches
 *    out to the provider over the network — `OpAnnotations.openWorldHint` is documented as
 *    MUST-be-false for every core MCP tool. Exposing it would either break that rule or lie in the
 *    annotation.
 *
 * The MCP tool list is pinned by `../mcp/server.test.ts`; that test records the resulting count.
 */

import type { SqlDriver } from "@nooklet/core";
import { z } from "zod";
import {
  buildProviderFromConfig,
  type EmbeddingModelRow,
  type EmbeddingSettings,
  embedQueueLength,
  enqueueBackfill,
  findModel,
  getActiveModel,
  getEmbeddingSettings,
  getVecStatus,
  modelCounts,
  probeEmbeddingProvider,
  promoteConfiguredModelIfReady,
  registerModel,
  setEmbeddingSettings,
} from "../embeddings/index.js";
import { defineOp, OpError } from "./registry.js";

/** The two providers a person can choose. `fake` is test-only and `plugin` is chosen by enabling
 * a plugin, not by typing a host — neither belongs in a settings form. */
const PROVIDER = z.enum(["ollama", "openai-compat"]);

const modelState = z.object({
  id: z.number().int(),
  provider: z.string(),
  model: z.string(),
  dimensions: z.number().int(),
  indexed: z.number().int().describe("Vectors stored for this model"),
  pending: z.number().int().describe("Units waiting to be embedded for this model"),
  errors: z.number().int().describe("Units whose embedding failed (usually the provider was down)"),
});

type ModelState = z.infer<typeof modelState>;

function stateOf(driver: SqlDriver, row: EmbeddingModelRow | undefined): ModelState | null {
  if (!row) return null;
  const counts = modelCounts(driver, row);
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dims,
    ...counts,
  };
}

export const embeddingsStatus = defineOp({
  name: "embeddings.status",
  summary: "Semantic search: what is configured, indexed, and reachable",
  description:
    "Everything the settings panel needs to say whether semantic search actually works: whether " +
    "sqlite-vec loaded, which provider/host/model is configured, which model is active, how far " +
    "the index has got, and whether the provider answers right now.",
  input: z
    .object({
      probe: z
        .boolean()
        .default(true)
        .describe("Contact the provider to check it is reachable and has the configured model"),
    })
    .strict(),
  output: z.object({
    sqlite_vec: z.object({
      loaded: z.boolean(),
      version: z.string().nullable(),
      error: z.string().nullable().describe("Why it did not load - semantic search cannot work"),
    }),
    configured: z.object({ provider: z.string(), model: z.string(), host: z.string() }),
    active: modelState.nullable().describe("The model semantic search queries right now"),
    switching_to: modelState
      .nullable()
      .describe("A registered model still backfilling; it activates itself when it finishes"),
    queued: z.number().int().describe("Units in the shared dirty queue, across all models"),
    provider: z.object({
      reachable: z.boolean().nullable(),
      error: z.string().nullable(),
      model_available: z.boolean().nullable(),
      available_models: z.array(z.string()).nullable(),
    }),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Contacts the configured provider (Ollama, LM Studio, an OpenAI-compatible endpoint).
    openWorldHint: true,
  },
  scopes: ["read"],
  expose: { mcp: false },
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const vec = getVecStatus(driver);
    const configured = getEmbeddingSettings(driver);
    const active = getActiveModel(driver);
    const registered = findModel(driver, configured.provider, configured.model);
    // The configured model only appears as `switching_to` while it is registered but not yet live;
    // once it activates it is simply `active` and this goes back to null.
    const switching = registered && !registered.active ? registered : undefined;

    const probe = input.probe
      ? await probeEmbeddingProvider(configured)
      : { reachable: null, error: null, modelAvailable: null, availableModels: null };

    return {
      sqlite_vec: {
        loaded: vec.loaded,
        version: vec.version ?? null,
        error: vec.error ?? null,
      },
      configured,
      active: stateOf(driver, active),
      switching_to: stateOf(driver, switching),
      queued: embedQueueLength(driver),
      provider: {
        reachable: probe.reachable,
        error: probe.error,
        model_available: probe.modelAvailable,
        available_models: probe.availableModels,
      },
    };
  },
});

export const embeddingsConfigure = defineOp({
  name: "embeddings.configure",
  summary: "Point semantic search at a provider and model",
  description:
    "Sets the embedding provider, host and model, discovers the model's vector width from the " +
    "provider itself, registers it and enqueues a full backfill. Fails with the reason when the " +
    "host cannot be reached or does not have that model - it never stores a configuration it has " +
    "just proven does not work.",
  input: z
    .object({
      provider: PROVIDER.optional().describe("Defaults to whatever is configured now"),
      host: z.string().min(1).optional().describe("e.g. http://127.0.0.1:11434"),
      model: z.string().min(1).describe("e.g. bge-m3"),
    })
    .strict(),
  output: z.object({
    provider: z.string(),
    model: z.string(),
    host: z.string(),
    model_id: z.number().int(),
    dimensions: z.number().int(),
    active: z.boolean().describe("False while the backfill runs; it activates itself when done"),
    queued: z.number().int().describe("Units enqueued for backfill"),
    pending: z.number().int(),
  }),
  annotations: {
    readOnlyHint: false,
    // Registering a model adds a vector table; it never drops the old one (rule 19 keeps the
    // outgoing model queryable until the new one is ready).
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // `write`, not `admin`: the served web client's own token is write-scoped
  // (`../http/app.ts#webClientToken`), and the settings panel is the intended caller.
  scopes: ["write"],
  expose: { mcp: false },
  handler: async (input, ctx) => {
    const driver = ctx.db;

    const vec = getVecStatus(driver);
    if (!vec.loaded) {
      throw new OpError(
        "invalid",
        `sqlite-vec is not loaded on this server (${vec.error ?? "unknown reason"}), so embeddings cannot be stored.`,
        "Semantic search needs the sqlite-vec extension. Until it loads, search stays keyword-only.",
      );
    }

    const current = getEmbeddingSettings(driver);
    // An omitted provider keeps the current one — unless the current one is `fake` or `plugin`,
    // which this op does not offer and cannot validate the way it validates an HTTP host.
    const candidate: EmbeddingSettings = {
      provider:
        input.provider ?? (current.provider === "openai-compat" ? "openai-compat" : "ollama"),
      model: input.model,
      host: input.host ?? current.host,
    };

    // Ask the host what it has BEFORE asking it to embed anything: the two failures people
    // actually hit (nothing listening, model never pulled) are indistinguishable once they come
    // back out of a provider's `dims()` — see `../embeddings/probe.ts`.
    const probe = await probeEmbeddingProvider(candidate);
    if (probe.reachable === false) {
      throw new OpError(
        "invalid",
        `Could not reach the ${candidate.provider} server at ${candidate.host}: ${probe.error ?? "no response"}.`,
        candidate.provider === "ollama"
          ? "Is Ollama running? Start it with `ollama serve`, then try again."
          : "Check the host URL and that the service is running.",
      );
    }
    if (probe.modelAvailable === false) {
      const known = (probe.availableModels ?? []).slice(0, 8);
      throw new OpError(
        "invalid",
        `The ${candidate.provider} server at ${candidate.host} has no model named "${candidate.model}".`,
        candidate.provider === "ollama"
          ? `Pull it first: \`ollama pull ${candidate.model}\`.` +
              (known.length ? ` Models it does have: ${known.join(", ")}.` : "")
          : known.length
            ? `Models it does have: ${known.join(", ")}.`
            : "Check the model name.",
      );
    }

    // Same discovery the CLI's `embed model` does, against a provider built from the candidate
    // rather than from stored settings — nothing is persisted until it answers.
    let dims: number;
    try {
      dims = await buildProviderFromConfig(driver, candidate).dims();
    } catch (err) {
      throw new OpError(
        "invalid",
        `Could not measure the embedding size of "${candidate.model}" at ${candidate.host}: ${err instanceof Error ? err.message : String(err)}`,
        "The host answered, but embedding failed. Is that model an embedding model?",
      );
    }
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new OpError(
        "invalid",
        `"${candidate.model}" at ${candidate.host} reported an unusable embedding size (${dims}).`,
        "Is that an embedding model? A chat model will not work here.",
      );
    }

    setEmbeddingSettings(driver, candidate);
    const row = registerModel(driver, {
      provider: candidate.provider,
      model: candidate.model,
      dims,
    });
    const queued = enqueueBackfill(driver);
    // Activates right away when there is nothing to backfill (a fresh graph, or re-selecting a
    // model that is already fully indexed); otherwise the indexer flips it when the queue drains.
    const promoted = promoteConfiguredModelIfReady(driver);
    const counts = modelCounts(driver, row);

    return {
      provider: row.provider,
      model: row.model,
      host: candidate.host,
      model_id: row.id,
      dimensions: row.dims,
      active: row.active || promoted !== undefined,
      queued,
      pending: counts.pending,
    };
  },
});

export const embeddingsReindex = defineOp({
  name: "embeddings.reindex",
  summary: "Re-embed the whole graph",
  description:
    "Enqueues every page and block for re-embedding under every tracked model. Use it after the " +
    "provider was down during a backfill (embeddings.status reports the error count), or to fill " +
    "in a model that was registered while the host was unreachable. Returns how many units were " +
    "queued; the indexer drains them in the background.",
  input: z.object({}).strict(),
  output: z.object({
    queued: z.number().int(),
    model: z.string().nullable().describe("The model these units will be embedded for"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    // Enqueueing is a local write; the network calls happen later, in the indexer.
    openWorldHint: false,
  },
  scopes: ["write"],
  expose: { mcp: false },
  handler: (_input, ctx) => {
    const driver = ctx.db;
    const configured = getEmbeddingSettings(driver);
    const target =
      getActiveModel(driver) ?? findModel(driver, configured.provider, configured.model);
    if (!target) {
      // Enqueueing with no model registered is a silent no-op: the indexer would walk the whole
      // graph and write nothing. Say so instead.
      throw new OpError(
        "invalid",
        "No embedding model is registered, so there is nothing to index.",
        "Configure a provider and model first (embeddings.configure, or the settings panel).",
      );
    }
    return { queued: enqueueBackfill(driver), model: `${target.provider}:${target.model}` };
  },
});
