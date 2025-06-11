const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { config, LogLevel } = require('./config');
const { logger } = require('./utils/logger');
const { getManifest } = require('./addon/manifest');
const { catalogHandler, metaHandler, streamHandler, searchHandler } = require('./addon/handlers');
const { startCrawler } = require('./crawler/engine');
const redisClient = require('./redis'); // Import redisClient instance
const express = require('express'); // Import express to create a custom server

// Set the logger's level based on config
logger.setLogLevel(config.LOG_LEVEL);

// Get the addon manifest
const manifest = getManifest();

// Initialize the addon builder with the manifest
const builder = new addonBuilder(manifest);

// Define handlers for the addon
builder.defineCatalogHandler(async (args) => {
    logger.debug('Handling catalog request...');
    return catalogHandler(args.type, args.id, args.extra);
});

builder.defineMetaHandler(async (args) => {
    logger.debug('Handling meta request...');
    return metaHandler(args.type, args.id);
});

builder.defineStreamHandler(async (args) => {
    logger.debug('Handling stream request...');
    return streamHandler(args.type, args.id);
});

// Define search handler if it's included in the manifest
if (manifest.resources.includes('search')) {
    builder.defineSearchHandler(async (args) => {
        logger.debug('Handling search request...');
        return searchHandler(args.type, args.id, args.extra);
    });
}

// Get the Stremio Addon SDK's Express app (this is how serveHTTP works internally)
const addonApp = builder.get(); // Corrected: Removed extra quote and added closing parenthesis

// Create a new Express app to host both the addon and custom debug endpoints
const app = express();

// Use the addon's Express app as a middleware
app.use(addonApp);

// Add custom debug endpoint for crawl data
app.get('/debug/crawl-data', async (req, res) => {
    logger.info('Received debug/crawl-data request.');
    try {
        const movieKeys = await redisClient.keys('movie:*');
        const episodeKeys = await redisClient.keys('episode:*');
        const threadKeys = await redisClient.keys('thread:*');
        const errorQueueLength = await redisClient.llen('error_queue');
        const recentErrors = await redisClient.lrange('error_queue', 0, 9); // Get last 10 errors

        const moviesCount = movieKeys.length;
        const streamsCount = episodeKeys.length;
        const threadsCount = threadKeys.length;

        // Fetch some sample data for a quick overview
        const sampleMovieKeys = movieKeys.slice(0, 5); // Get up to 5 movie keys
        const sampleMovies = await Promise.all(sampleMovieKeys.map(key => redisClient.hgetall(key)));

        const sampleStreamKeys = episodeKeys.slice(0, 5); // Get up to 5 stream keys
        const sampleStreams = await Promise.all(sampleStreamKeys.map(key => redisClient.hgetall(key)));

        res.json({
            status: 'success',
            message: 'Crawl data overview',
            counts: {
                movies: moviesCount,
                streams: streamsCount,
                threads: threadsCount,
                errorQueue: errorQueueLength
            },
            samples: {
                movies: sampleMovies,
                streams: sampleStreams
            },
            recentErrors: recentErrors.map(e => JSON.parse(e))
        });
    } catch (error) {
        logger.error('Error fetching debug data:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve debug data',
            error: error.message
        });
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Failed to retrieve debug data via /debug/crawl-data',
            error: error.message
        });
    }
});


// Start the HTTP server for the addon
// Use app.listen instead of serveHTTP directly to use our custom Express app
app.listen(config.PORT, () => {
    logger.info(`Stremio Addon server running on port ${config.PORT}`);
    // Start the crawler once the server is listening
    startCrawler();
});
