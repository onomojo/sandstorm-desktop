FROM node:22

# Electron system dependencies (headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    libgtk-3-0 \
    libdbus-1-3 \
    xvfb \
    xauth \
  && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["xvfb-run", "--auto-servernum", "npm", "run", "dev"]
