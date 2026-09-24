# syntax=docker/dockerfile:1.7
#
# omadia Admin UI — Next.js standalone build for Docker / Fly.io.
# Multi-stage: install deps → build standalone → copy thin runtime image.
# Final image ~150 MB (node 22 slim + standalone server + static assets).

# --- deps -------------------------------------------------------------------
FROM node:22.23.2-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm's registry fetches are retried harder than the default (2 attempts, short
# backoff) because a dropped connection here fails the whole image build: the
# web-ui edge image died on `npm error code ECONNRESET` mid-`npm ci` while the
# very same commit built fine in the other pipeline minutes later. Retrying in
# npm is strictly cheaper than re-running a Docker job by hand, and it applies
# to `npm rebuild` / `npm install` in this stage too.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN npm ci --no-audit --no-fund

# --- builder ----------------------------------------------------------------
FROM node:22.23.2-slim AS builder
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
FROM node:22.23.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Build identity (#432) — read at request time by app/_lib/appVersion.ts (a
# server component), so this belongs in the RUNTIME stage, not the builder.
# Before this, the help page read web-ui/package.json and printed `0.2.0` on
# every release since the version series left 0.2.
ARG OMADIA_VERSION=
ENV OMADIA_VERSION=${OMADIA_VERSION}
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
