/**
 * `@nooklet/plugin-api` — the public contract plugin authors and the (not-yet-built) plugin host
 * both compile against (`docs/spec/api-and-plugin-types.md`, ADR 007). Types and tiny helpers
 * only: no runtime dependency on `@nooklet/server`, hono, or zod (those appear only as type-only
 * imports, erased at compile time — see `package.json`'s `devDependencies`).
 *
 * NOTE: `Block`/`Page`/`BlockId`/`PageId`/`Properties`/`Op` are NOT re-exported here — per the
 * spec, this package references `@nooklet/core`'s model directly rather than redefining or
 * re-exporting it (§3: "this spec does not redefine those"). Import them from `@nooklet/core`.
 */

export type { ApiMajor } from "./api-version.js";
export {
  assertApiSupported,
  isApiSupported,
  PluginLoadError,
  SUPPORTED_API_MAJORS,
} from "./api-version.js";
export type {
  BlockMenuItemDef,
  ClientPluginContext,
  CodeBlockRenderer,
  EditorApi,
  MacroRenderer,
  PageMenuItemDef,
  PanelDef,
  RenderInfo,
  SlashItem,
  StatusItemDef,
  ToolbarItemDef,
} from "./client-context.js";
export type { Command, CommandKeys, Platform } from "./command.js";
export type {
  BlockNode,
  BlocksApi,
  DataApi,
  PagesApi,
  PropertyPatch,
  QueryApi,
} from "./data.js";
export type { ClientPluginModule, ServerPluginModule, SingleFilePlugin } from "./define-plugin.js";
export { definePlugin } from "./define-plugin.js";
export type { Disposable } from "./disposable.js";
export type { Json } from "./json.js";
export type {
  CommandContribution,
  JsonSchema,
  KeybindingContribution,
  ManifestError,
  PluginContributes,
  PluginManifest,
  PluginPermission,
  SlashContribution,
  ValidateManifestResult,
} from "./manifest.js";
export { validateManifest } from "./manifest.js";
export type {
  Actor,
  ApplyOpsResult,
  HttpExpose,
  HttpMethod,
  Logger,
  McpExpose,
  OpAnnotations,
  OpContext,
  OpDef,
  OpErrorCode,
  OpExpose,
  Origin,
  OriginKind,
  Scope,
  ServerConfig,
} from "./op-def.js";
export {
  defineOp,
  HTTP_STATUS,
  OpError,
  toErrorBody,
} from "./op-def.js";
export type {
  BeforeWriteHandler,
  EmbeddingProviderDef,
  ExporterDef,
  ImporterDef,
  JobDef,
  McpResourceReader,
  McpToolDef,
  McpToolHandler,
  PendingWriteTx,
  PluginCommand,
  RouteInfo,
  RpcFn,
  SearchProviderDef,
  ServerChangeEvents,
  ServerPluginContext,
} from "./server-context.js";
