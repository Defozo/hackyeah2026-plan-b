# Manifest digest verified from registry-1.docker.io on 2026-10-03.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS build
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV RAYON_NUM_THREADS=2
RUN pnpm assets:prepare && pnpm build
RUN pnpm exec tsc -p apps/api/tsconfig.build.json
RUN mkdir -p dist/api/fixtures && cp apps/api/fixtures/polish-note.wav dist/api/fixtures/polish-note.wav

FROM build AS production-deps
RUN pnpm prune --prod

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS runtime
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8791 SERVE_WEB=true BUDGET_DB_PATH=/app/data/budget.sqlite AI_ENABLED=false ALLOW_PERSONAL_DATA_TO_AI=false
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/api ./dist/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8791/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/api/main.js"]
