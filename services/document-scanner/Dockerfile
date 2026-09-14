FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav ca-certificates \
  && freshclam \
  && rm -rf /var/lib/apt/lists/* /var/log/clamav/*

WORKDIR /app
COPY --chown=node:node server.mjs /app/server.mjs

ENV NODE_ENV=production \
    SCANNER_MAX_BYTES=20971520 \
    SCANNER_TIMEOUT_MS=25000

USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
