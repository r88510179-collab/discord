FROM node:20-slim

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ sqlite3 sqlite3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Create data directory for SQLite persistence
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/bettracker.db

# --expose-gc allows manual GC hints after large image buffer allocations
# --max-old-space-size=400 caps V8 heap to 400MB (leaves 112MB for buffers/stack)
CMD ["node", "--expose-gc", "--max-old-space-size=400", "bot.js"]
