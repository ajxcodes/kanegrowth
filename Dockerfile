# Standalone offline-first KaneGrowth Web UI container (nginx-unprivileged on :8080)
FROM node:22-alpine AS build
WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN npm --prefix apps/web ci

COPY apps/web ./apps/web
COPY shared ./shared

ARG VITE_LOCAL_FIRST=true
ARG VITE_STANDALONE_LOCAL=true
ARG VITE_API_ORIGIN=
ENV VITE_LOCAL_FIRST=$VITE_LOCAL_FIRST \
    VITE_STANDALONE_LOCAL=$VITE_STANDALONE_LOCAL \
    VITE_API_ORIGIN=$VITE_API_ORIGIN

RUN npm --prefix apps/web run build:standalone

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
USER root
COPY --from=build /app/dist/frontend /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/health || exit 1
