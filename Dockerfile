FROM oven/bun:latest

# Install base dependencies + Google Chrome for Puppeteer
# (chromium apt package is snap-only on Ubuntu 24.04+, so we use Chrome .deb)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget git \
    libnss3 libgbm1 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation \
    libxshmfence1 libglu1-mesa \
    && (apt-get install -y libasound2t64 || apt-get install -y libasound2) \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chrome instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

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
