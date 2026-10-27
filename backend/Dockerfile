FROM node:20-alpine AS deps
WORKDIR /app

# Copy ai-module first and install its dependencies
COPY ai-module ./ai-module
WORKDIR /app/ai-module
RUN npm install --only=production

# Copy backend package files (excluding ai-module from package.json temporarily)
WORKDIR /app
COPY backend/package*.json ./backend/
WORKDIR /app/backend

# Install backend dependencies (this will ignore the missing local ai-module)
RUN npm ci --only=production --ignore-scripts || npm install --only=production --ignore-scripts

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy backend node_modules first
COPY --from=deps /app/backend/node_modules ./node_modules

# Copy ai-module directly into node_modules
COPY --from=deps /app/ai-module ./node_modules/ai-module

# Copy backend source code
COPY backend/ .

EXPOSE 3000
CMD ["node", "index.js"]
