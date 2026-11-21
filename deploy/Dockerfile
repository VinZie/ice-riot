# ICE RIOT game server image (zero npm dependencies, so no npm install step).
#
# Build from the REPO ROOT (the build context must contain server/, shared/, public/):
#   docker build -f deploy/Dockerfile -t ice-riot .
# Run on its own (publishes the port on the Docker host):
#   docker run --rm --init -p 8765:8765 ice-riot
# Or put it straight on your tailnet with the Tailscale sidecar:
#   docker compose -f deploy/docker-compose.yml up -d --build

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8765

WORKDIR /app

# Only what the server runs and serves. Files stay root-owned, so the runtime user
# below can read them but not modify them.
COPY package.json ./
COPY server/ ./server/
COPY shared/ ./shared/
COPY public/ ./public/

# data/ is the only writable path (career stats, data/stats.json). Mount a volume here to
# keep stats across container rebuilds (docker-compose.yml does).
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# Unprivileged user that ships with the official node image (uid/gid 1000).
USER node

EXPOSE 8765

# GET / must answer 2xx. Uses Node's built-in fetch, so it honours a custom PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/server.js", "--host", "0.0.0.0"]
