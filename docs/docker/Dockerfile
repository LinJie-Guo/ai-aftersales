FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates ripgrep curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web ./apps/web
COPY server ./apps/server
WORKDIR /app/apps/web
RUN npm ci && npm run typecheck && npm run build
WORKDIR /app/apps/server
RUN npm ci && npm run typecheck && DATA_ROOT=/tmp/aftersale-build-test npm test

FROM node:22-bookworm-slim

ENV WEB_DIST=/app/apps/web/dist
ENV PORT=8080
ENV DATA_ROOT=/data/aftersale
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates ripgrep poppler-utils curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

WORKDIR /app/apps/server
EXPOSE 8080
CMD ["npm", "start"]
