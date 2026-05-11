# syntax=docker/dockerfile:1.7
#
# Harness Admin — Next.js standalone build for Fly.io (app: odoo-bot-harness).
# Multi-stage: install deps → build standalone → copy thin runtime image.
# Final image ~150 MB (node 20 slim + standalone server + static assets).

# --- deps -------------------------------------------------------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- builder ----------------------------------------------------------------
FROM node:26-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `output: 'standalone'` (next.config.ts) emits .next/standalone + .next/static
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js bakes the /bot-api/* rewrite destination into routes-manifest.json
# at build time, so MIDDLEWARE_URL has to be known here — not at runtime.
# Override from fly.toml [build.args] or `fly deploy --build-arg` when moving
# the middleware onto a different internal hostname.
ARG MIDDLEWARE_URL=http://odoo-bot-middleware.internal:8080
ENV MIDDLEWARE_URL=${MIDDLEWARE_URL}
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next's standalone server listens on 0.0.0.0 when HOSTNAME is unset or set to 0.0.0.0.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# The standalone folder contains a trimmed package.json + server.js; static
# assets are emitted separately under .next/static and public/ — both have to
# be placed at fixed paths next to server.js for Next to find them.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
