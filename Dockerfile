# Stage 1: Build the JavaScript application
# Using a single stage for plain JavaScript as no compilation is needed.
FROM node:20-alpine

WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock) to install dependencies
COPY package*.json ./

# Update npm to the latest version to avoid potential resolution issues
RUN npm install -g npm@latest

# Install production dependencies
# This is typically sufficient for runtime.
RUN npm install --only=production

# Copy all application source code from src/ to /app/src
COPY src ./src

# No 'npm run build' step as there's no TypeScript to compile.

# Expose the port the addon will run on (from config.js)
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
# ENV ADDON_ID=community.tamilshows-addon
# ENV ADDON_NAME="TamilShows Web Series"
# ENV ADDON_DESCRIPTION="Auto-updating Tamil web series catalog"
# ENV LOG_LEVEL=INFO
# ENV TRACKER_UPDATE_INTERVAL_HOURS=6
# ENV NGOSANG_TRACKERS_URL=https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt


# Command to run the application
CMD ["node", "src/index.js"] # Point directly to the main JS file inside src/
