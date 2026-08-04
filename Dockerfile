# syntax=docker/dockerfile:1.7
# Production image for Coolify (socratic-app).
#
# Design constraints (learned the hard way 2026-08-04):
# - Coolify Horizon kills the build command at ~30 minutes. A full
#   `COPY --chown=node:node /app /app` of an unpruned tree (~4 GB image) was
#   routinely exceeding that budget and freezing prod on the last good image.
# - Do not COPY --chown large trees between stages; chown in a RUN instead.
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
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build \
  && npm prune --omit=dev \
  && rm -rf .next/cache \
  && rm -rf test docs ios pdf_pages .git .github \
  && rm -rf node_modules/.cache

FROM node:24.14.1-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tar gzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000

# Copy without --chown (slow for multi-GB trees under BuildKit), then fix
# ownership once. Runtime still drops to USER node below.
COPY --from=build /app /app
RUN chown -R node:node /app

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/health >/dev/null || exit 1

CMD ["bash", "scripts/coolify-prod-start.sh"]
