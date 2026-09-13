/**
 * The installed plugins, as the server reports them (`GET /api/v1/plugins`,
 * `packages/server/src/plugins/http.ts#mountPluginListRoute`).
 *
 * A plain `GET` with this device's token rather than `callOp`: the listing is not a `defineOp`
 * op (it is the discovery route a client plugin host would read to know what to `import()`), so it
 * has no `POST /api/v1/<op>` form. Errors are turned into the same `ApiError` shape every other
 * panel renders with `describeError`.
 *
 * The server lists ACTIVE plugins only — disabled and failed-to-load ones are not in the reply,
 * and there is no op to enable or disable one from here (`nooklet plugin enable|disable` is the
 * only switch). The settings section says so rather than implying the list is everything on disk.
 */

import { ApiError } from "./api-client.js";
import { apiBaseUrl, authToken } from "./bootstrap.js";

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  hasClient: boolean;
  hasServer: boolean;
}

interface PluginListWire {
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    has_client: boolean;
    has_server: boolean;
  }>;
}

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const token = authToken();
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/v1/plugins`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    throw new ApiError(
      "network",
      `could not reach ${apiBaseUrl() || location.origin} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) throw new ApiError("internal", `plugin list failed: HTTP ${res.status}`);
  const body = (await res.json()) as PluginListWire;
  return body.plugins.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    hasClient: p.has_client,
    hasServer: p.has_server,
  }));
}
