FROM node:20-slim

# better-sqlite3 needs build tools for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (need typescript for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Copy knowledge base and schema
COPY knowledge/ ./knowledge/
COPY src/db/schema.sql ./dist/db/schema.sql

# Create data directory for SQLite
RUN mkdir -p data

ENV NODE_ENV=production
ENV KB_PATH=./knowledge
ENV DATABASE_PATH=./data/seo-engine.db

EXPOSE 3000

CMD ["node", "dist/index.js"]
