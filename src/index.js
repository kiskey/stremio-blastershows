const { addonBuilder } = require('stremio-addon-sdk'); // Removed serveHTTP as we will manage the app.listen directly
const { config, LogLevel } = require('./config');
const { logger } = require('./utils/logger');
const { getManifest } = require('./addon/manifest');
const { catalogHandler, metaHandler, streamHandler, searchHandler } = require('./addon/handlers');
const { startCrawler } = require('./crawler/engine');
const redisClient = require('./redis');
const express = require('express');
const cors = require('cors'); // Import the cors middleware

// Set the logger's level based on config
logger.setLogLevel(config.LOG_LEVEL);

// Get the addon manifest
const manifest = getManifest();

// Create our own Express app instance
const app = express();

// Enable CORS for all routes - IMPORTANT for Stremio to access the addon
// Apply CORS middleware before any routes are defined
app.use(cors());

// Initialize the addon builder, passing our Express app to it
// This tells the SDK to use 'app' as its underlying Express instance for Stremio-specific routes
const builder = new addonBuilder(manifest, { app: app });

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

// Search requests are handled by defineCatalogHandler if 'search' is in manifest.catalogs[].extra.
// No need for a separate defineSearchHandler.

// --- Custom Endpoints (added directly to our Express app) ---

// Explicitly serve the manifest.json
app.get('/manifest.json', (req, res) => {
    logger.info('Serving manifest.json');
    res.json(manifest);
});

// Add a basic root route to confirm the server is running
app.get('/', (req, res) => {
    res.send(`<h1>${manifest.name} Stremio Addon is running!</h1><p>Visit /manifest.json for the addon manifest.</p><p>Visit /debug/crawl-data for crawl debugging.</p>`);
});

// Add custom debug endpoint for crawl data
app.get('/debug/crawl-data', async (req, res) => {
    logger.info('Received debug/crawl-data request.');
    try {
        const movieKeys = await redisClient.keys('movie:*');
        const episodeKeys = await redisClient.keys('episode:*');
        const threadKeys = await redisClient.keys('thread:*');
        const errorQueueLength = await redisClient.llen('error_queue');
        const recentErrors = await redisClient.lrange('error_queue', 0, 9);

        const moviesCount = movieKeys.length;
        const streamsCount = episodeKeys.length;
        const threadsCount = threadKeys.length;

        const sampleMovieKeys = movieKeys.slice(0, 5);
        const sampleMovies = await Promise.all(sampleMovieKeys.map(key => redisClient.hgetall(key)));

        const sampleStreamKeys = episodeKeys.slice(0, 5);
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
            recentErrors: recentErrors.map(e => {
                try {
                    return JSON.parse(e);
                } catch (parseError) {
                    logger.error('Failed to parse error log from Redis:', parseError);
                    return { message: 'Corrupted error log', raw: e };
                }
            })
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


// Start the HTTP server for the addon using our custom Express app
app.listen(config.PORT, () => {
    logger.info(`Stremio Addon server running on port ${config.PORT}`);
    // Start the crawler once the server is listening to ensure Redis is available
    startCrawler();
});
