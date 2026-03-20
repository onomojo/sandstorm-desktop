# Sandstorm — Claude Code workspace container.
#
# A lightweight workspace with Claude Code, git, and GitHub CLI.
# Sits alongside project services on the Docker network.

FROM debian:bookworm-slim

# Core dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    sudo \
    gosu \
    jq \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Docker CLI (for exec'ing into other stack containers to run tests, etc.)
RUN curl -fsSL https://get.docker.com | sh && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 (required by chrome-devtools-mcp)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Headless Chromium for browser automation via Chrome DevTools MCP
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Non-root claude user (added to docker group for socket access)
RUN useradd -m -s /bin/bash claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    usermod -aG docker claude

# Claude Code CLI (installed as the claude user)
RUN su claude -c "curl -fsSL https://claude.ai/install.sh | bash"
ENV PATH="/home/claude/.local/bin:$PATH"

# Pre-install Chrome DevTools MCP server (avoids npx cold-start)
RUN npm install -g chrome-devtools-mcp@latest

# Entrypoint, task runner, and inner Claude instructions
COPY docker/entrypoint.sh /usr/bin/sandstorm-entrypoint.sh
COPY docker/task-runner.sh /usr/bin/sandstorm-task-runner.sh
COPY docker/SANDSTORM_INNER.md /usr/bin/SANDSTORM_INNER.md
RUN chmod +x /usr/bin/sandstorm-entrypoint.sh /usr/bin/sandstorm-task-runner.sh

WORKDIR /app

ENTRYPOINT ["/usr/bin/sandstorm-entrypoint.sh"]
