# NEXORA Hub — minimal single-stage image.
# Zero runtime dependencies (see package.json), so no install/build stage is needed.
FROM node:18-slim

ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

# Run as the non-root user already present in the base image.
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
