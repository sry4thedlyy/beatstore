# Verification environment only; deployment uses the system services.
FROM node:22.20.0-bookworm AS node
FROM caddy:2 AS caddy
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 beatstore
COPY --from=node /usr/local/ /usr/local/
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
WORKDIR /app
COPY --chown=beatstore:beatstore . .
ENV PG_BIN_DIR=/usr/lib/postgresql/16/bin CADDY_BIN=/usr/local/bin/caddy NEXT_TELEMETRY_DISABLED=1
USER beatstore
CMD ["node", "--import", "tsx", "scripts/acceptance.ts", "--capacity"]
