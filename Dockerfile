# ── Lead Qualifier (Next.js + Puppeteer Worker) ──
# Multi-stage build for ARM64 (Oracle Cloud Ampere A1) and AMD64
# This image serves BOTH the Next.js app AND the worker.cjs

# ────────────────────────────────────────
# Stage 1: Install dependencies
# ────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ────────────────────────────────────────
# Stage 2: Build Next.js
# ────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js standalone output
RUN npm run build

# ────────────────────────────────────────
# Stage 3: Production runtime
# ────────────────────────────────────────
FROM node:20-slim AS runner

# Install Chromium and dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    procps \
    xvfb \
    x11vnc \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy Next.js standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy worker and scraper files (they run as a separate container from the same image)
COPY --from=builder /app/worker.cjs ./
COPY --from=builder /app/case-study-worker.cjs ./
COPY --from=builder /app/case-study-engine.cjs ./
COPY --from=builder /app/case-study-worker-core.cjs ./
COPY --from=builder /app/puppeteer-scraper.cjs ./
COPY --from=builder /app/voyager-scraper.cjs ./
COPY --from=builder /app/src/lib/prospect-qualification.cjs ./src/lib/
COPY --from=builder /app/src/lib/prospect-research.cjs ./src/lib/
COPY --from=builder /app/src/lib/linkedin-workers.cjs ./src/lib/
COPY --from=builder /app/src/lib/linkedin-session-identity.cjs ./src/lib/
COPY --from=builder /app/src/lib/linkedin-signout.cjs ./src/lib/
COPY --from=builder /app/src/lib/worker-failure.cjs ./src/lib/
COPY --from=builder /app/src/lib/worker-research-store.cjs ./src/lib/
COPY --from=builder /app/scripts/linkedin-worker-supervisor.cjs ./scripts/

# Copy node_modules needed by worker (puppeteer, etc.)
COPY --from=deps /app/node_modules ./node_modules

# Create queue directories
RUN mkdir -p /app/queue /app/queue-results /app/case-study-queue \
    /app/case-study-results /app/scrape-results /app/progress \
    /app/.browser-profiles /app/.browser-profiles-case-study

# Expose Next.js port
EXPOSE 3000

# Health check for the Next.js server
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://127.0.0.1:3000', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Default: run Next.js server (override with `command: node worker.cjs` for worker)
CMD ["node", "server.js"]
