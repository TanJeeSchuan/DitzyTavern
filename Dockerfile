FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG DISTRIBUTION=custom
ARG BUILD_NUMBER
ARG SOURCE_REVISION
RUN bun scripts/write-build-metadata.ts
RUN bun run build

FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14 AS runtime
ARG DISTRIBUTION=custom
ARG BUILD_NUMBER
ARG SOURCE_REVISION
LABEL io.ditzytavern.distribution=$DISTRIBUTION io.ditzytavern.build-number=$BUILD_NUMBER org.opencontainers.image.revision=$SOURCE_REVISION org.opencontainers.image.source="https://github.com/TanJeeSchuan/DitzyTavern"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/src/server/build-metadata.json ./src/server/build-metadata.json
RUN mkdir data && chown bun:bun data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD bun -e 'const response = await fetch("http://127.0.0.1:3000/api/health"); process.exit(response.ok ? 0 : 1)'
CMD ["bun", "src/server/index.ts"]
