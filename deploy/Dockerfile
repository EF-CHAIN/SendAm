# syntax=docker/dockerfile:1
FROM node:22-alpine3.23 AS manifests
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/chat-sim/package.json apps/chat-sim/
COPY apps/landing/package.json apps/landing/
COPY packages/shared/package.json packages/shared/

FROM manifests AS development
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN DATABASE_URL=postgresql://localhost/sendam npm run prisma:generate --workspace=apps/api

FROM manifests AS production-dependencies
RUN npm ci --workspace=apps/api --include-workspace-root=false --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM alpine:3.23 AS runtime
RUN apk add --no-cache ca-certificates libstdc++ openssl \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node
COPY --from=manifests /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/api ./apps/api
COPY --from=development /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY apps/api/src ./apps/api/src
WORKDIR /app/apps/api
USER node
EXPOSE 3002
CMD ["node", "src/server.js"]
