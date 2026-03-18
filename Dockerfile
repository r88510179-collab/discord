FROM node:20-slim

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Create data directory for SQLite persistence
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/bettracker.db

CMD ["node", "bot.js"]
