# Build from repository root: docker build -f desktop/local/Dockerfile -t schafferai-desktop .
# Run on a Linux host with host networking so the listener stays loopback-only.
FROM node:24-alpine
WORKDIR /app/desktop/local
COPY desktop/local/package.json desktop/local/package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY desktop/local/server.js ./server.js
COPY desktop/relay/src/index.js /app/desktop/relay/src/index.js
USER node
EXPOSE 8794
CMD ["node", "server.js", "--config", "/run/secrets/desktop-relay.json", "--port", "8794"]
