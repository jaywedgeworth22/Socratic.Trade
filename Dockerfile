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

FROM node:24.14.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3@13 ships prebuilds linked against GLIBC_2.38; Debian bookworm
# only has 2.36 (deploy 175/177: ERR_DLOPEN_FAILED). npm prune re-extracts
# prebuilds, so we rebuild AGAIN after prune and delete prebuilds/.
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# scripts/eval/* imports test/fixtures (dockerignored). Next typecheck includes
# **/*.ts and would fail the image build. Drop eval runners before build.
RUN rm -rf scripts/eval test \
  && npm run build \
  && npm prune --omit=dev \
  && rm -rf node_modules/better-sqlite3/prebuilds \
  && npm rebuild better-sqlite3 --build-from-source \
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
