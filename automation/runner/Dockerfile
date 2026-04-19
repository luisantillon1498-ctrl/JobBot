FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    xvfb x11vnc websockify novnc net-tools \
    && rm -rf /var/lib/apt/lists/*

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DISPLAY=:99

EXPOSE 8080

CMD ["node", "automation/runner/server.mjs"]
