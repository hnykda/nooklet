# nooklet server image: `nooklet serve` + the built web client, for a self-hosted server (e.g. the
# owner's MicroK8s cluster — deploy/k8s/). Build from the REPO ROOT:
#
#   docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile -t nooklet:dev .
#
# Reuses apps/desktop/build-sidecar.mjs rather than a second packaging path: run on Linux it
# produces the same self-contained bundle the desktop app ships (server.mjs, the official Node
# binary it was built with, sqlite-vec's vec0.so, the esbuild binary for runtime plugin bundling,
# the web client, the pre-bundled built-in plugins, host-modules/) — so the image runs exactly what
# the desktop sidecar runs, with no node_modules at runtime.

# Node 26: the release workflow builds the shipped sidecar on 26 (.github/workflows/release.yml),
# and build-sidecar.mjs copies the BUILDING Node's own version into the bundle.
FROM node:26-bookworm AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nooklet/desktop run sidecar

FROM debian:bookworm-slim
# libatomic1: the official Node Linux binary links it, and slim Debian does not ship it ("error while
# loading shared libraries: libatomic.so.1" on first run — found by running this image).
# ca-certificates: outbound HTTPS from the server (embedding providers, if configured).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1000 --create-home nooklet \
  && mkdir -p /data && chown nooklet:nooklet /data
COPY --from=build /src/apps/desktop/sidecar /app
WORKDIR /app
USER 1000
# Same environment apps/desktop/src-tauri/src/main.rs#spawn_server gives the sidecar.
ENV NODE_ENV=production \
    NOOKLET_DATA=/data \
    NOOKLET_SQLITE_VEC_PATH=/app/vec0.so \
    ESBUILD_BINARY_PATH=/app/esbuild
EXPOSE 6100
VOLUME ["/data"]
# --host 0.0.0.0 so the pod is reachable at all; the server then refuses any Host it was not
# told about (--allow-host), so the deployment must pass the name clients use.
# --no-loopback-token: nobody runs a browser inside this container, so the "this machine gets a
# token automatically" convenience has no legitimate user here — but anything that DOES reach the
# server over the container's loopback (a sidecar proxy in the same pod, `kubectl port-forward`,
# `docker exec ... curl`) would be handed a write + sync token by it (B-600, decision D3). Devices
# use a token from `nooklet token create` instead, exactly as they do over the network anyway.
ENTRYPOINT ["/app/node", "/app/server.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "6100", "--web", "/app/web", "--no-loopback-token"]
