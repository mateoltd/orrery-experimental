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
# openssl: Prisma's query engine links against it, and node:24-bookworm-slim does not ship
# it. Found by BUILDING this image rather than reading it — `prisma generate` failed with
# "Could not resolve @prisma/client", which says nothing about the real cause. If you ever
# see that message, check for OpenSSL before anything else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
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
# Prisma's engine also needs a compiler-compatible toolchain in the build stage on some
# hosts; the runtime image gets the generated client, not the engine toolchain.
# SCHEMA_GATE_ALLOW_NO_DB=1 — and read the gate's banner if you see one.
#
# The schema gate's drift check replays prisma/migrations in a scratch database. There is no
# Postgres and no docker-in-docker in this build stage, so the check cannot run here and a
# database-less container build is exactly the case the flag exists for.
#
# It is opt-IN, so a developer machine and a CI job — both of which have a database — keep the
# check. The alternative, making the check pass by default when it cannot run, is the failure
# mode this whole check was written to prevent: it would have looked like protection in every
# build and protected nothing in this one.
ENV SCHEMA_GATE_ALLOW_NO_DB=1
RUN pnpm run gates                      # schema · board · invariants · pinning · bundle
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
# `node-linker=hoisted` (.npmrc) puts dependencies flat at the repo root, so `next` is at
# /app/node_modules/next, not /app/apps/web/node_modules/next. Found by RUNNING the image —
# the build succeeded and the container died on MODULE_NOT_FOUND, which is exactly the class
# of defect a build cannot catch.
# `next start [dir]`: the runtime WORKDIR is /app so that node_modules/next resolves flat
# from the repo root (hoisted linker), but the .next build lives in /app/apps/web. Running
# the container proved both halves of that: the build was present and BUILD_ID was written,
# and Next still reported "no production build" because it resolves .next against cwd.
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", "3000"]
