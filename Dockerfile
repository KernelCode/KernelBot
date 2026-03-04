FROM oven/bun:latest

# Install Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libgbm1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    git \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json bun.lock* pnpm-lock.yaml* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create persistent data directory
RUN mkdir -p /root/.kernelbot

VOLUME /root/.kernelbot

CMD ["bun", "run", "bin/kernel.js", "--start"]
