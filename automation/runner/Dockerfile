FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "automation/runner/server.mjs"]
