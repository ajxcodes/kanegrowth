# Single-container KaneGrowth: frontend (nginx) + self-hosted backend (Axum) on :8080.
# nginx serves the built SPA and reverse-proxies /api + /health to the in-container backend.

# ---------- Stage 1: build frontend ----------
FROM node:22-alpine AS frontend-build
WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN npm --prefix apps/web ci

COPY apps/web ./apps/web
COPY shared ./shared

ARG VITE_LOCAL_FIRST=true
ARG VITE_STANDALONE_LOCAL=false
ARG VITE_API_ORIGIN=
ENV VITE_LOCAL_FIRST=$VITE_LOCAL_FIRST \
    VITE_STANDALONE_LOCAL=$VITE_STANDALONE_LOCAL \
    VITE_API_ORIGIN=$VITE_API_ORIGIN

RUN npm --prefix apps/web run build

# ---------- Stage 2: build backend (static musl for Alpine runtime) ----------
FROM rust:1-slim AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/web/src-tauri ./apps/web/src-tauri
COPY apps/web/src/platform/db/migrations ./apps/web/src/platform/db/migrations

RUN cargo build -p kanegrowth-api --release --target x86_64-unknown-linux-musl

# ---------- Stage 3: runtime ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
LABEL org.opencontainers.image.title="KaneGrowth" \
      org.opencontainers.image.description="KaneGrowth — self-hosted personal finance (web + sync server)." \
      org.opencontainers.image.source="https://github.com/ajxcodes/kanegrowth" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

USER root
# backend runtime deps
RUN apk add --no-cache ca-certificates curl tini
# backend binary
COPY --from=backend-build /app/target/x86_64-unknown-linux-musl/release/kanegrowth-api /usr/local/bin/kanegrowth-api
# frontend static
COPY --from=frontend-build /app/dist/frontend /usr/share/nginx/html
# nginx config + entrypoint
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# persistent data dir writable by nginx user
RUN mkdir -p /data && chown -R nginx:nginx /data

ENV KANEGROWTH_BIND=127.0.0.1:5000 \
    KANEGROWTH_DB_PATH=/data/kanegrowth.db \
    KANEGROWTH_JWT_SECRET=change-me-in-production \
    KANEGROWTH_CORS_ORIGINS=http://localhost:8080

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD curl -sf http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
