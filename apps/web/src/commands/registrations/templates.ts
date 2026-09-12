/**
 * `block.insertTemplate` — the `/template` slash item (ADR 019).
 *
 * With no argument it opens the picker (`../slash/TemplatePicker.tsx`) at the caret and inserts
 * whichever template is chosen; with a string argument (the template's name — what an agent
 * passes through `ui_run`, and what tests use) it inserts that one directly.
 *
 * Two shapes of insertion, both through `data/templates.ts`:
 * - the caret's bullet is EMPTY (the usual case: a fresh bullet, `/template`, pick) — the template
 *   goes INTO that bullet: its first block's text replaces the empty text, its properties land on
 *   the bullet, its children hang beneath it. The text is written through `EditorHost`, never by
 *   an op, because the editor owns that block's buffer and would flush over an op's content;
 * - the bullet has text — the template is inserted as the following sibling(s) and the caret
 *   moves to the first new block.
 *
 * The data and picker seams are injectable so the command's own test needs neither a database
 * nor a DOM; `createCoreCommands` passes nothing and gets the real ones.
 */
import {
  applyTemplateIntoBlock,
  findTemplateByName,
  insertTemplateAfter,
  listTemplates,
  type TemplateSummary,
} from "../../data/templates.js";
import { requestBlockFocus } from "../../editor/focus-request.js";
import type { EditorHost, EditorSelection } from "../hosts/editor-host.js";
import type { Command } from "../types.js";

export interface TemplateCommandDeps {
  editor: EditorHost;
  data?: {
    listTemplates: () => Promise<TemplateSummary[]>;
    findTemplateByName: (name: string) => Promise<TemplateSummary | undefined>;
    insertTemplateAfter: (templateId: string, blockId: string) => Promise<string | undefined>;
    applyTemplateIntoBlock: (
      templateId: string,
      blockId: string,
    ) => Promise<{ content: string } | undefined>;
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
    insertTemplateAfter,
    applyTemplateIntoBlock,
  };
  const pick = deps.pick ?? defaultPick;
  const focusBlock = deps.focusBlock ?? requestBlockFocus;

  async function insert(template: TemplateSummary, opened: EditorSelection): Promise<void> {
    // The editor keeps focus while the picker is open, so the live selection is the truth; the
    // one captured when the command started is the fallback for a host that lost it meanwhile.
    const at = editor.getSelection() ?? opened;
    if (at.content.trim() === "") {
      const result = await data.applyTemplateIntoBlock(template.id, at.blockId);
      if (!result) return;
      const latest = editor.getSelection();
      if (latest && latest.blockId === at.blockId) {
        editor.replaceRange({ from: 0, to: latest.content.length, text: result.content });
      }
      return;
    }
    const firstId = await data.insertTemplateAfter(template.id, at.blockId);
    if (firstId) focusBlock(firstId);
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
