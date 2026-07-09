# syntax=docker/dockerfile:1.7
#
# omadia Admin UI — Next.js standalone build for Docker / Fly.io.
# Multi-stage: install deps → build standalone → copy thin runtime image.
# Final image ~150 MB (node 22 slim + standalone server + static assets).

# --- deps -------------------------------------------------------------------
FROM node:22.23.1-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- builder ----------------------------------------------------------------
FROM node:22.23.1-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `output: 'standalone'` (next.config.ts) emits .next/standalone + .next/static
ENV NEXT_TELEMETRY_DISABLED=1
# MIDDLEWARE_URL is a pure RUNTIME setting: /bot-api/* and /p/* are proxied
# by route handlers that read it per request (app/_lib/middlewareProxy.ts),
# so the same image runs against any middleware host. Do not reintroduce a
# build ARG for it — that was the bug that pinned the published image to
# the compose hostname.
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22.23.1-slim AS runtime
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
