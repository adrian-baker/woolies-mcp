# Build stage: full dev dependencies, compile to dist/.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.check.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and the compiled output only.
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# node:20-slim ships an unprivileged `node` user; the server needs no write access anywhere.
USER node
EXPOSE 8480
CMD ["node", "dist/http.js"]
