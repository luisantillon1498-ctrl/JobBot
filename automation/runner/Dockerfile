FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    xvfb x11vnc websockify novnc net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install retail Google Chrome.
# Playwright's bundled Chromium has a JA3/JA4 TLS fingerprint that does not
# match any real Chrome release — detectable by Ashby/Socure at the TCP handshake
# level before any JavaScript runs.  A retail Chrome binary uses the correct
# Google-signed network stack and produces the expected TLS fingerprint.
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DISPLAY=:99
# Point Playwright at the retail Chrome binary instead of bundled Chromium.
# Can be overridden per-environment; if unset, Playwright falls back to Chromium.
ENV CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 8080

CMD ["node", "automation/runner/server.mjs"]
