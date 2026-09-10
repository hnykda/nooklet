/**
 * Plugin manifest: `package.json#nooklet` (`docs/spec/api-and-plugin-types.md` §2.1) plus
 * `validateManifest`, a runtime check the host needs (untrusted `package.json` content) and
 * plugin authors benefit from too (fail fast on a typo before `activate()` ever runs).
 */

/** Informational in v1 (trusted ESM); enforced once a worker/sandbox host ships (ADR 007). */
export type PluginPermission = "net" | "fs" | "shell" | "env";
const PLUGIN_PERMISSIONS: ReadonlySet<PluginPermission> = new Set(["net", "fs", "shell", "env"]);

/** JSON Schema 2020-12; the host renders a settings form from it. */
export type JsonSchema = Record<string, unknown>;

export interface CommandContribution {
  /** Matches a `Command.id` this plugin will register in code. */
  id: string;
  title: string;
  category?: string;
  when?: string;
  /** Shown in the palette/keymap UI before the plugin loads. */
  defaultKeys?: { default?: string; mac?: string; win?: string; linux?: string };
}
export interface SlashContribution {
  id: string;
  label: string;
  keywords?: string[];
}
export interface KeybindingContribution {
  key: string;
  command: string;
  when?: string;
}
export interface PluginContributes {
  commands?: CommandContribution[];
  slash?: SlashContribution[];
  keybindings?: KeybindingContribution[];
}

export interface PluginManifest {
  /** Stable, `[a-z0-9-]+`; namespaces kv/settings/routes/rpc. */
  id: string;
  /** Display name; defaults to `id`. */
  name?: string;
  /** Plugin API major this plugin targets (rule 15, see `api-version.ts`). */
  api: "1";
  /** Relative path to the server entry module. */
  server?: string;
  /** Relative path to the client entry module. */
  client?: string;
  permissions?: PluginPermission[];
  settings?: JsonSchema;
  contributes?: PluginContributes;
  /** Required to use `ctx.experimental.*`. */
  experimental?: boolean;
}

// -------------------------------------------------------------------------------------------
// validateManifest
// -------------------------------------------------------------------------------------------

export interface ManifestError {
  /** Dotted/bracketed path into the manifest, e.g. `"contributes.slash[0].label"`; `""` for a
   * whole-manifest error. */
  path: string;
  message: string;
}

export type ValidateManifestResult =
  | { valid: true; errors: []; manifest: PluginManifest }
  | { valid: false; errors: ManifestError[]; manifest?: undefined };

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateStringField(
  errors: ManifestError[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  opts: { required?: boolean } = {},
): void {
  const v = obj[key];
  if (v === undefined) {
    if (opts.required) errors.push({ path, message: `"${key}" is required` });
    return;
  }
  if (typeof v !== "string" || v.length === 0) {
    errors.push({ path, message: `"${key}" must be a non-empty string` });
  }
}

function validateCommandContribution(errors: ManifestError[], value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateStringField(errors, value, "id", `${path}.id`, { required: true });
  validateStringField(errors, value, "title", `${path}.title`, { required: true });
  if (value.category !== undefined && typeof value.category !== "string") {
    errors.push({ path: `${path}.category`, message: "must be a string" });
  }
  if (value.when !== undefined && typeof value.when !== "string") {
    errors.push({ path: `${path}.when`, message: "must be a string" });
  }
  if (value.defaultKeys !== undefined && !isPlainObject(value.defaultKeys)) {
    errors.push({ path: `${path}.defaultKeys`, message: "must be an object" });
  }
}

function validateSlashContribution(errors: ManifestError[], value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateStringField(errors, value, "id", `${path}.id`, { required: true });
  validateStringField(errors, value, "label", `${path}.label`, { required: true });
  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords) || value.keywords.some((k) => typeof k !== "string")) {
      errors.push({ path: `${path}.keywords`, message: "must be an array of strings" });
    }
  }
}

function validateKeybindingContribution(
  errors: ManifestError[],
  value: unknown,
  path: string,
): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateStringField(errors, value, "key", `${path}.key`, { required: true });
  validateStringField(errors, value, "command", `${path}.command`, { required: true });
  if (value.when !== undefined && typeof value.when !== "string") {
    errors.push({ path: `${path}.when`, message: "must be a string" });
  }
}

function validateContributes(errors: ManifestError[], value: unknown): void {
  if (!isPlainObject(value)) {
    errors.push({ path: "contributes", message: "must be an object" });
    return;
  }
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands))
      errors.push({ path: "contributes.commands", message: "must be an array" });
    else {
      for (const [i, c] of value.commands.entries())
        validateCommandContribution(errors, c, `contributes.commands[${i}]`);
    }
  }
  if (value.slash !== undefined) {
    if (!Array.isArray(value.slash))
      errors.push({ path: "contributes.slash", message: "must be an array" });
    else {
      for (const [i, s] of value.slash.entries())
        validateSlashContribution(errors, s, `contributes.slash[${i}]`);
    }
  }
  if (value.keybindings !== undefined) {
    if (!Array.isArray(value.keybindings))
      errors.push({ path: "contributes.keybindings", message: "must be an array" });
    else {
      for (const [i, k] of value.keybindings.entries())
        validateKeybindingContribution(errors, k, `contributes.keybindings[${i}]`);
    }
  }
}

/**
 * Validate an untrusted `package.json#nooklet` value (or the manifest half of a single-file
 * plugin, see `define-plugin.ts`). Returns typed errors rather than throwing, so a host can list
 * every problem at once (Settings -> Plugins) instead of stopping at the first.
 */
export function validateManifest(value: unknown): ValidateManifestResult {
  const errors: ManifestError[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: [{ path: "", message: "manifest must be an object" }] };
  }

  if (value.id === undefined) {
    errors.push({ path: "id", message: '"id" is required' });
  } else if (typeof value.id !== "string" || !ID_RE.test(value.id)) {
    errors.push({
      path: "id",
      message: `"id" must match ${ID_RE} (lowercase letters, digits, hyphens)`,
    });
  }

  if (value.api !== "1") {
    errors.push({
      path: "api",
      message: `"api" must be the literal string "1" (got ${JSON.stringify(value.api)}); see api-version.ts for supported majors`,
    });
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    errors.push({ path: "name", message: '"name" must be a string' });
  }
  if (value.server !== undefined && typeof value.server !== "string") {
    errors.push({ path: "server", message: '"server" must be a relative path string' });
  }
  if (value.client !== undefined && typeof value.client !== "string") {
    errors.push({ path: "client", message: '"client" must be a relative path string' });
  }
  if (value.server === undefined && value.client === undefined) {
    errors.push({
      path: "",
      message: "manifest must declare at least one of server/client (rule 14)",
    });
  }

  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions)) {
      errors.push({ path: "permissions", message: "must be an array" });
    } else {
      value.permissions.forEach((p, i) => {
        if (typeof p !== "string" || !PLUGIN_PERMISSIONS.has(p as PluginPermission)) {
          errors.push({
            path: `permissions[${i}]`,
            message: `unknown permission ${JSON.stringify(p)}; expected one of ${[...PLUGIN_PERMISSIONS].join(", ")}`,
          });
        }
      });
    }
  }

  if (value.settings !== undefined && !isPlainObject(value.settings)) {
    errors.push({ path: "settings", message: "must be a JSON Schema object" });
  }

  if (value.experimental !== undefined && typeof value.experimental !== "boolean") {
    errors.push({ path: "experimental", message: "must be a boolean" });
  }

  if (value.contributes !== undefined) validateContributes(errors, value.contributes);

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], manifest: value as unknown as PluginManifest };
}
