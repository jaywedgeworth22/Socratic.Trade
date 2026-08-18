# syntax=docker/dockerfile:1.7
# Production image for Coolify (socratic-app).
#
# Design constraints (learned the hard way 2026-08-04):
# - Coolify Horizon kills the build command at ~30 minutes. A full
#   `COPY --chown=node:node /app /app` of an unpruned tree (~4 GB image) was
#   routinely exceeding that budget and freezing prod on the last good image.
# - Do not COPY --chown or RUN chown -R large trees (both blew the 30m budget).
# - Prune devDependencies and .next/cache before the runtime stage so the
#   inter-stage copy is small and fast.
# - Pair with .dockerignore so the build context never includes local
#   node_modules/.next/test/ios/docs/agent state.
#
# better-sqlite3 / bookworm glibc (deploy 175-178):
# - better-sqlite3@13 prebuilds need GLIBC_2.38; bookworm ships 2.36.
# - `npm rebuild better-sqlite3 --build-from-source` after prune is a NO-OP:
#   npm 10 ignores --build-from-source as a CLI flag, and after prune the
#   node-gyp toolchain is gone, so rebuild only re-stamps and never emits
#   build/Release/better_sqlite3.node (deploy 178: MODULE_NOT_FOUND, 500
#   healthchecks, roll-back to 6ad913d5).
# - Force a real node-gyp rebuild with an explicit clean of build/ + prebuilds/,
#   keep python3/make/g++ for that step, and fail the image build if the
#   .node binary is missing or unloadable.

FROM node:24.14.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Weekday RTH latch: fail THIS IMAGE BUILD (not the running container) during
# regular US equity hours unless HOTFIX=1 or RTH_DEPLOY_OVERRIDE=1.  A failed
# build leaves the last healthy Coolify container up.  Do not move this into
# scripts/coolify-prod-start.sh -- a runtime refusal would take the site down
# after the container swap.  SOURCE_COMMIT is optional; when Coolify passes
# it, the latch can read HOTFIX=1 from the public GitHub commit message.
ARG HOTFIX=0
ARG SOURCE_COMMIT=""
ENV HOTFIX=${HOTFIX} \
    SOURCE_COMMIT=${SOURCE_COMMIT}
RUN npx tsx scripts/assert-rth-deploy-latch.ts
# scripts/eval/* imports test/fixtures (dockerignored). Next typecheck includes
# **/*.ts and would fail the image build. Drop eval runners before build.
# --ignore-scripts on prune: avoid re-extracting glibc-2.38 prebuilds.
# Then wipe any prebuild/build residue and compile better-sqlite3 from source
# with a real node-gyp (installed globally so prune cannot remove it).
RUN rm -rf scripts/eval test \
  && npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && npm install -g node-gyp@11 \
  && rm -rf node_modules/better-sqlite3/prebuilds node_modules/better-sqlite3/build \
  && (cd node_modules/better-sqlite3 && node-gyp rebuild --release) \
  && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log('better-sqlite3 ok', db.prepare('select 1 as x').get()); db.close();" \
  && rm -rf .next/cache \
  && rm -rf ios pdf_pages .git .github \
  && find docs -mindepth 1 -maxdepth 1 ! -name benchmarks -exec rm -rf {} + 2>/dev/null || true \
  && rm -rf node_modules/.cache

FROM node:24.14.1-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tar gzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000

# Copy without ownership rewrite (recursive chown blew the 30m budget).
# Run as root: coolify-prod-start must mkdir/write /app/data/.bin and the
# Coolify volume mount for /app/data is the writable surface. USER node with
# root-owned /app caused crash-loop exit 1 on deploy 173 (healthcheck never
# passed; rolled back to 6ad913d5).
COPY --from=build /app /app

USER root
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/health >/dev/null || exit 1

CMD ["bash", "scripts/coolify-prod-start.sh"]
