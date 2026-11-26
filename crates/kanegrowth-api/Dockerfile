FROM rust:1-slim AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/web/src-tauri ./apps/web/src-tauri
COPY apps/web/src/platform/db/migrations ./apps/web/src/platform/db/migrations

RUN cargo build -p kanegrowth-api --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/kanegrowth-api /usr/local/bin/kanegrowth-api
ENV KANEGROWTH_BIND=0.0.0.0:5000
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD curl -sf http://127.0.0.1:5000/health || exit 1
CMD ["kanegrowth-api"]