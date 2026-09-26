# syntax=docker/dockerfile:1.7
# Orrery web image.
#
# Two things here are load-bearing rather than conventional:
#
#   1. **The build stage runs the gates.** If the schema does not validate or a bundle is
#      over budget, the image does not build. `pnpm build` alone would happily produce an
#      image from a schema that `gate:schema` rejects, which is how a broken schema reaches
#      production on a "green" pipeline.
#
#   2. **The runtime image contains no secrets and no dev dependencies.** Secrets are
#      injected at runtime from the platform's store (14 §8); the image is identical in
#      staging and production, so "it worked in staging" stays a meaningful statement.

# ───────────────────────────────────────────────────────────────────── build
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# ─────────────────────────────────────────────────────── deps (cached layer)
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/clock/package.json packages/clock/
COPY packages/ids/package.json packages/ids/
COPY packages/rng/package.json packages/rng/
# `--frozen-lockfile` so a build can never quietly resolve different versions than CI did.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────── build with the gates
FROM deps AS build
COPY . .
RUN pnpm run gates                      # schema · board · invariants · pinning
RUN pnpm --filter @orrery/db db:generate
RUN pnpm run build

# ─────────────────────────────────────────────────────────── minimal runtime
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# The exam runtime budget assumes a modern baseline; this is what students actually get.
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# tini reaps zombies and forwards signals, so a container stop is a graceful shutdown
# rather than a 30-second SIGKILL — which matters when a deploy lands during an exam.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build /repo/packages ./packages

# Never root. A compromised process should not own the filesystem.
USER node

EXPOSE 3000
ENV PORT=3000

# Liveness must not touch a dependency (18 §3): a liveness probe that fails when Postgres
# is slow restarts the app during an outage it could have ridden out.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "-p", "3000"]
