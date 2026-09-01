FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S bitelink && adduser -S -G bitelink bitelink
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER bitelink
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health/ready || exit 1
CMD ["node","src/server.js"]
