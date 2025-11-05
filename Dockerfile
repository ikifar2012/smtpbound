# syntax=docker/dockerfile:1.19

# --- Build stage ---
FROM node:24-slim AS build

WORKDIR /app

# Enable corepack and pnpm (uses version from packageManager)
RUN corepack enable pnpm

# Install all deps for build
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

# Copy sources and build
COPY src ./src
RUN pnpm build

# Prune to production dependencies for runtime image
RUN pnpm prune --prod

# --- Runtime stage ---
FROM node:24-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Install minimal runtime tools (ca-certificates for outbound TLS)
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Copy built artifacts and production deps only
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Default env; override at runtime
ENV SMTP_HOST=0.0.0.0
ENV SMTP_PORT=25

# Expose SMTP/SMTPS ports
EXPOSE 25/tcp 465/tcp

ENTRYPOINT ["node", "dist/index.js"]