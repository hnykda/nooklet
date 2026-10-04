# nooklet's public site (apps/site: landing page + docs, a Next.js static export) served by nginx.
# Build from the REPO ROOT — the site renders docs/guide and docs/adr at build time, so it needs the
# whole repository as context, not just apps/site:
#
#   docker buildx build --platform linux/amd64 -f deploy/docker/site.Dockerfile -t nooklet-site:dev .
#   docker run --rm -p 8080:80 nooklet-site:dev        # then open http://localhost:8080
#
# The image holds static files only: no secrets, no server, nothing that talks to a nooklet server.

# On the BUILD platform: the export is plain static files, identical for every architecture, so a
# multi-arch build (.woodpecker/images.yaml on release tags) emulates only the nginx stage below.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /src
COPY . .
# `...` = the site and its workspace dependencies only; the server/desktop toolchains never install.
RUN pnpm install --frozen-lockfile --filter "@nooklet/site..."
RUN pnpm --filter @nooklet/site build

FROM nginx:1.31-alpine
COPY deploy/docker/site.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/site/out /usr/share/nginx/html
# Fail the build, not the rollout, if the config is malformed.
RUN nginx -t
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
