FROM node:24-alpine

WORKDIR /app

# Aplikacja jest statyczna - nie ma zależności npm do instalacji.
COPY package.json ./
COPY server ./server
COPY site ./site
COPY data/reference ./data/reference

# Cache odpowiedzi rynkowych (montowany jako wolumen w docker-compose).
RUN mkdir -p /app/cache && chown -R node:node /app/cache

ENV NODE_ENV=production \
    PORT=8080 \
    CACHE_DIR=/app/cache \
    TZ=Europe/Warsaw

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "server/server.js"]
