const { addonBuilder } = require('stremio-addon-sdk'); // Removed serveHTTP as we will use app.listen directly
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

// Create our own Express app instance
const app = express();

// Initialize the addon builder, passing our Express app to it
// This tells the SDK to use 'app' as its underlying Express instance
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

// Add custom debug endpoint for crawl data directly to our Express app
app.get('/debug/crawl-data', async (req, res) => {
    logger.info('Received debug/crawl-data request.');
    try {
        // Fetch counts for movies, streams, and threads
        const movieKeys = await redisClient.keys('movie:*');
        const episodeKeys = await redisClient.keys('episode:*');
        const threadKeys = await redisClient.keys('thread:*');
        
        // Fetch error queue length and recent errors
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

        // Send JSON response with collected data
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
            // Parse recent errors from JSON strings before sending
            recentErrors: recentErrors.map(e => {
                try {
                    return JSON.parse(e);
                } catch (parseError) {
                    logger.error('Failed to parse error log from Redis:', parseError);
                    return { message: 'Corrupted error log', raw: e }; // Return raw string if parsing fails
                }
            })
        });
    } catch (error) {
        // Log and respond if an error occurs during debug data fetching
        logger.error('Error fetching debug data:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve debug data',
            error: error.message
        });
        // Also log this error to the Redis error queue
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
