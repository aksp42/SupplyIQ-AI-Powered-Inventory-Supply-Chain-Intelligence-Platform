# ── Backend Dockerfile ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Dependencies are installed before the source is copied so edits to the app do
# not invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4000

# The server refuses nothing at startup, so an unauthenticated GET is enough to
# confirm the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "server.js"]
