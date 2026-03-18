FROM node:20-slim

# Native build tools for better-sqlite3 and sharp
RUN apt-get update   && apt-get install -y --no-install-recommends python3 make g++   && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/bettracker.db
ENV PORT=3000

EXPOSE 3000
CMD ["node", "bot.js"]
