FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 falls back to node-gyp when no prebuilt binary matches the
# image's Node; slim images lack the toolchain it needs.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build build
COPY --from=build /app/node_modules node_modules
COPY package.json .
EXPOSE 3000
CMD ["node", "build"]
