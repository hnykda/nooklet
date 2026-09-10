/**
 * Proves `runRemoteCommand` goes through the REAL command registry/context/exec — the same
 * `createCommandRegistry`/`createCommandContext` `<CommandProvider>` itself uses, not a parallel
 * path — by asserting on side effects (MRU recording) that only `ctx.exec` produces, and by
 * exercising real `when` clauses through the real evaluator.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeStore } from "../commands/hosts/store.js";
import { createCommandContext } from "../commands/provider/executor.js";
import { createMruStore } from "../commands/ranking/mru.js";
import { createCommandRegistry } from "../commands/registry.js";
import { type Command, type CommandContext, DEFAULT_WHEN_CONTEXT } from "../commands/types.js";
import { type CommandRunDeps, runRemoteCommand } from "./command-runner.js";
import { subscribeFlash } from "./flash-bus.js";

describe("runRemoteCommand", () => {
  let registry: ReturnType<typeof createCommandRegistry>;
  let mru: ReturnType<typeof createMruStore>;
  let state: { focusedBlockId: string | null; selectedBlockIds: string[]; isTask: boolean };
  let ran: string[];
  let deps: CommandRunDeps;

  beforeEach(() => {
    registry = createCommandRegistry();
    mru = createMruStore();
    ran = [];
    state = { focusedBlockId: "b1", selectedBlockIds: [], isTask: false };

    const contextBase = (): Omit<CommandContext, "exec" | "args"> => ({
      ...DEFAULT_WHEN_CONTEXT,
      editorFocused: true,
      isTask: state.isTask,
      focusedBlockId: state.focusedBlockId,
      selectedBlockIds: state.selectedBlockIds,
      surface: null,
      store: createFakeStore(),
    });

    deps = {
      registry,
      contextBase,
      buildContext: (base) => createCommandContext(base, registry, mru),
      isControlEnabled: () => true,
      forceSync: async () => {
        ran.push("forceSync");
      },
    };

    registry.register({
      id: "task.markAlways",
      title: "Always runs",
      category: "Task",
      defaultKeys: {},
      run() {
        ran.push("task.markAlways");
      },
    } satisfies Command);

    registry.register({
      id: "task.markIfTask",
      title: "Only when isTask",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      run() {
        ran.push("task.markIfTask");
      },
    } satisfies Command);

    registry.register({
      id: "app.privileged",
      title: "Not remotely invocable",
      category: "App",
      defaultKeys: {},
      remoteInvocable: false,
      run() {
        ran.push("app.privileged");
      },
    } satisfies Command);

    registry.register({
      id: "block.moveFocus",
      title: "Moves focus to another block",
      category: "Block",
      defaultKeys: {},
      run() {
        state.focusedBlockId = "b2"; // simulates the command's real effect on live app state
      },
    } satisfies Command);
  });

  it("runs a command with no when clause, through the real registry/exec, recording MRU", async () => {
    const result = await runRemoteCommand(deps, "task.markAlways", undefined);
    expect(result.when_result).toBe("ran");
    expect(ran).toContain("task.markAlways");
    // Only `ctx.exec` (the real dispatch path every trigger uses, R71) records MRU — this would be
    // absent if runRemoteCommand called `command.run(ctx)` directly instead.
    expect(mru.indexOf("command", "task.markAlways")).toBe(0);
  });

  it("honours a true `when` clause against the CURRENT context", async () => {
    state.isTask = true;
    const result = await runRemoteCommand(deps, "task.markIfTask", undefined);
    expect(result.when_result).toBe("ran");
    expect(ran).toContain("task.markIfTask");
  });

  it("honours a false `when` clause: skipped, not run, not an error, no MRU entry", async () => {
    state.isTask = false;
    const result = await runRemoteCommand(deps, "task.markIfTask", undefined);
    expect(result.when_result).toBe("skipped_when_false");
    expect(ran).not.toContain("task.markIfTask");
    expect(mru.indexOf("command", "task.markIfTask")).toBe(Number.POSITIVE_INFINITY);
  });

  it("unknown_command for an id not in the registry", async () => {
    const result = await runRemoteCommand(deps, "no.suchCommand", undefined);
    expect(result.when_result).toBe("unknown_command");
  });

  it("not_permitted for a command marked remoteInvocable: false, without running it", async () => {
    const result = await runRemoteCommand(deps, "app.privileged", undefined);
    expect(result.when_result).toBe("not_permitted");
    expect(ran).not.toContain("app.privileged");
  });

  it("a disabled local control toggle refuses everything — not_permitted, before even looking up the command", async () => {
    deps = { ...deps, isControlEnabled: () => false };
    const result = await runRemoteCommand(deps, "task.markAlways", undefined);
    expect(result.when_result).toBe("not_permitted");
    expect(ran).not.toContain("task.markAlways");
    expect(ran).not.toContain("forceSync");
  });

  it("still refuses via the toggle even for an id that doesn't exist (checked first)", async () => {
    deps = { ...deps, isControlEnabled: () => false };
    const result = await runRemoteCommand(deps, "no.suchCommand", undefined);
    expect(result.when_result).toBe("not_permitted");
  });

  it("best-effort forces an immediate sync push after a successful run, not otherwise", async () => {
    await runRemoteCommand(deps, "task.markAlways", undefined);
    expect(ran).toContain("forceSync");

    ran.length = 0;
    await runRemoteCommand(deps, "app.privileged", undefined);
    expect(ran).not.toContain("forceSync");
  });

  it("flashes whatever ended up focused after the command ran (post-run snapshot, not pre-run)", async () => {
    const flashed: string[] = [];
    const unsubscribe = subscribeFlash((e) => flashed.push(e.blockId));
    await runRemoteCommand(deps, "block.moveFocus", undefined);
    unsubscribe();
    expect(flashed).toEqual(["b2"]);
  });

  it("passes args through to the command's run() via ctx.args", async () => {
    let seenArgs: unknown;
    registry.register({
      id: "task.withArgs",
      title: "Records its args",
      category: "Task",
      defaultKeys: {},
      run(ctx) {
        seenArgs = ctx.args;
      },
    } satisfies Command);
    await runRemoteCommand(deps, "task.withArgs", { page: "Projects/Aurora" });
    expect(seenArgs).toEqual({ page: "Projects/Aurora" });
  });
});
