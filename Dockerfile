FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/asteria.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY --from=build /app/src/engine.ts /app/src/data.ts /app/src/battle.ts /app/src/hex.ts /app/src/duel-sim.ts /app/src/duel-rules.ts /app/src/neutral.ts /app/src/equipment.ts ./src/
USER node
EXPOSE 3000
CMD ["node","server/index.mjs"]
