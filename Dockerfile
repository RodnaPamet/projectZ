# syntax=docker/dockerfile:1.7

# ── deps ────────────────────────────────────────────────────────────
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --prefer-offline --no-audit

# ── build ───────────────────────────────────────────────────────────
FROM node:25-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1
RUN npx prisma generate && npm run build

# ── runtime ─────────────────────────────────────────────────────────
FROM node:25-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as a NON-ROOT user. A container that runs as root turns any RCE in a
# dependency into root on the container — and with a shared kernel, that is
# one namespace escape away from the host.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# ── Remove npm from the RUNTIME image ───────────────────────────────
#
# Two reasons, and the second is the one that actually bit us:
#
#  1. A production container has no business shipping a package manager.
#     npm can reach the network and write to disk; if an RCE lands in the
#     app, npm is a ready-made download-and-execute primitive.
#
#  2. npm BUNDLES ITS OWN dependency tree, and the node:24-alpine base
#     image's npm bundles undici 6.26.0 — CVE-2026-12151, a HIGH-severity
#     DoS. No `overrides` entry in OUR package.json can fix that, because
#     it is not in our tree. Trivy's IMAGE scan found it; the filesystem
#     scan structurally cannot see it.
#
# The app does not need npm to run: Next is invoked directly.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Liveness does NOT touch the database. A health check that queries Postgres
# reports the DATABASE's health, not the pod's — so a brief database blip
# makes the orchestrator kill every healthy pod at once, turning a
# recoverable incident into an outage.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Invoke Next directly — `npm run start` would need the npm we just removed.
CMD ["./node_modules/.bin/next", "start"]
