# Build context is the repo root (see docs/DEPLOYMENT.md) because the server
# imports packages/shared straight from source, not as a published/built package.
FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer is cached as long as no package.json changes.
# All workspace package.json files must be present for `npm ci` to match the
# root package-lock.json, even though we only run the server from this image.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/client/package.json apps/client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/server apps/server

ENV NODE_ENV=production
EXPOSE 2567

CMD ["npm", "start", "-w", "apps/server"]
