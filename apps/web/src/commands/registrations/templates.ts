/**
 * `block.insertTemplate` — the `/template` slash item (ADR 019).
 *
 * With no argument it opens the picker (`../slash/TemplatePicker.tsx`) at the caret and inserts
 * whichever template is chosen; with a string argument (the template's name — what an agent
 * passes through `ui_run`, and what tests use) it inserts that one directly.
 *
 * Two shapes of insertion, both built by `data/templates.ts`:
 * - the caret's bullet is EMPTY (the usual case: a fresh bullet, `/template`, pick) — the template
 *   goes INTO that bullet: its first block's text replaces the empty text, its properties land on
 *   the bullet, its children hang beneath it;
 * - the bullet has text — the template is inserted as the following sibling(s) and the caret
 *   moves to the first new block.
 *
 * Either way the ops are one batch committed through the editor (`EditorHost.commitOps`), so the
 * whole insertion is one Cmd/Ctrl+Z (B-108). Only when no editor shows the block any more (the
 * person left the page while the template was being read) are they applied directly.
 *
 * The data and picker seams are injectable so the command's own test needs neither a database
 * nor a DOM; `createCoreCommands` passes nothing and gets the real ones.
 */
import type { Op } from "@nooklet/core";
import { applyOps } from "../../data/store.js";
import {
  findTemplateByName,
  listTemplates,
  type TemplateSummary,
  templateAfterOps,
  templateIntoBlockOps,
} from "../../data/templates.js";
import { requestBlockFocus } from "../../editor/focus-request.js";
import type { EditorHost, EditorSelection } from "../hosts/editor-host.js";
import type { Command } from "../types.js";

export interface TemplateCommandDeps {
  editor: EditorHost;
  data?: {
    listTemplates: () => Promise<TemplateSummary[]>;
    findTemplateByName: (name: string) => Promise<TemplateSummary | undefined>;
    templateAfterOps: (
      templateId: string,
      blockId: string,
    ) => Promise<{ ops: Op[]; firstId: string } | undefined>;
    templateIntoBlockOps: (
      templateId: string,
      blockId: string,
    ) => Promise<{ ops: Op[] } | undefined>;
    /** The fallback write, for a batch no editor would take. */
    applyOps: (ops: Op[]) => Promise<unknown>;
  };
  /** Opens the picker; resolves with the chosen template or `undefined` on cancel. */
  pick?: (templates: TemplateSummary[]) => Promise<TemplateSummary | undefined>;
  focusBlock?: (id: string) => void;
}

/** The real picker, loaded on first use: it is JSX over a DOM, and this registration module —
 * like the rest of `commands/` — must evaluate without one (its tests run in plain Node). */
async function defaultPick(templates: TemplateSummary[]): Promise<TemplateSummary | undefined> {
  const { caretPopupPosition, openTemplatePicker } = await import("../slash/TemplatePicker.js");
  return new Promise((resolve) => {
    openTemplatePicker({
      templates,
      position: caretPopupPosition(),
      onPick: resolve,
      onCancel: () => resolve(undefined),
    });
  });
}

/** The template named by a command argument: a bare string, or `{ name }`. */
function requestedName(args: unknown): string | undefined {
  if (typeof args === "string") return args.trim() || undefined;
  if (args && typeof args === "object" && typeof (args as { name?: unknown }).name === "string") {
    return (args as { name: string }).name.trim() || undefined;
  }
  return undefined;
}

export function createTemplateCommands(deps: TemplateCommandDeps): Command[] {
  const { editor } = deps;
  const data = deps.data ?? {
    listTemplates,
    findTemplateByName,
    templateAfterOps,
    templateIntoBlockOps,
    applyOps,
  };
  const pick = deps.pick ?? defaultPick;
  const focusBlock = deps.focusBlock ?? requestBlockFocus;

  async function insert(template: TemplateSummary, opened: EditorSelection): Promise<void> {
    // The editor keeps focus while the picker is open, so the live selection is the truth; the
    // one captured when the command started is the fallback for a host that lost it meanwhile.
    const at = editor.getSelection() ?? opened;
    if (at.content.trim() === "") {
      const built = await data.templateIntoBlockOps(template.id, at.blockId);
      if (!built) return;
      // The caret ends the inserted text only if it is still in that bullet: focus that moved on
      // while the template was being read stays where the person put it.
      const stillThere = editor.getSelection()?.blockId === at.blockId;
      const batch = {
        ops: built.ops,
        anchorId: at.blockId,
        ...(stillThere ? { focus: { blockId: at.blockId, caret: "end" as const } } : {}),
      };
      if (!editor.commitOps(batch)) await data.applyOps(built.ops);
      return;
    }
    const built = await data.templateAfterOps(template.id, at.blockId);
    if (!built) return;
    const batch = {
      ops: built.ops,
      anchorId: at.blockId,
      focus: { blockId: built.firstId, caret: "end" as const },
    };
    if (editor.commitOps(batch)) return;
    await data.applyOps(built.ops);
    focusBlock(built.firstId);
  }

  return [
    {
      id: "block.insertTemplate",
      title: "Insert template…",
      description: "Copy a template's blocks here. Any block with a template:: name is a template.",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      async run(ctx) {
        const opened = editor.getSelection();
        if (!opened) return;
        const name = requestedName(ctx.args);
        if (name !== undefined) {
          const template = await data.findTemplateByName(name);
          if (template) await insert(template, opened);
          return;
        }
        // Not awaited: the slash menu stays mounted until this command's promise settles (it
        // dismisses after `exec`), and a picker stacked on top of a lingering slash menu is two
        // popups for one question. Open the picker, return, and let the pick do the work.
        const templates = await data.listTemplates();
        void pick(templates).then((chosen) => (chosen ? insert(chosen, opened) : undefined));
      },
    },
  ];
}
