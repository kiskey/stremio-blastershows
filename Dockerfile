# Stage 1: Build the TypeScript application
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock) to install dependencies
COPY package*.json ./
# Install production dependencies first to leverage Docker layer caching
RUN npm install --only=production
# Install dev dependencies for building
RUN npm install

# Copy the rest of the source code
COPY . .

# Build the TypeScript application
RUN npm run build

# Stage 2: Create the thin production image
FROM node:18-alpine

WORKDIR /app

# Copy only the necessary files from the builder stage
# Copy package.json to install only production dependencies in the final image
COPY --from=builder /app/package*.json ./
# Install only production dependencies
RUN npm install --only=production

# Copy the compiled JavaScript code and the manifest/config files
COPY --from=builder /app/dist ./dist
# Copy the .env file (if it's part of your deployment strategy, though often handled externally)
# It's better to pass environment variables directly when running the container,
# but for local testing convenience, you might copy a default .env
# COPY .env ./.env

# Expose the port the addon will run on (from config.ts)
EXPOSE 7000

# Set environment variables for the application
# These should ideally be passed at runtime for flexibility and security,
# but defining them here provides defaults within the image.
ENV PORT=7000
# ENV REDIS_URL=redis://your-redis-host:6379 # Should be set at runtime
# ENV FORUM_URL=https://www.1tamilblasters.fi/index.php?/forums/forum/63-tamil-new-web-series-tv-shows/ # Should be set at runtime
# ENV PURGE_ON_START=false
# ENV INITIAL_PAGES=2
# ENV CRAWL_INTERVAL=1800
# ENV THREAD_REVISIT_HOURS=24
# ENV MAX_CONCURRENCY=8
# ENV DOMAIN_MONITOR=http://1tamilblasters.net

# Command to run the application
CMD ["node", "dist/index.js"]
