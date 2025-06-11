const express = require('express');
const cors = require('cors');
const { config, LogLevel } = require('./config');
const { logger } = require('./utils/logger');
const { getManifest } = require('./addon/manifest'); // Directly import manifest
const { catalogHandler, metaHandler, streamHandler } = require('./addon/handlers'); // Import handlers
const { startCrawler } = require('./crawler/engine');
const redisClient = require('./redis');

// Set the logger's level based on config
logger.setLogLevel(config.LOG_LEVEL);

// Get the addon manifest
const manifest = getManifest();

// Create our own Express app instance
const app = express();

// Enable CORS for all routes - IMPORTANT for Stremio to access the addon
app.use(cors());

// Middleware to parse JSON request bodies
app.use(express.json());

// --- Helper to parse Stremio URL extras (e.g., skip=0/search=query) ---
// This function will parse path segments like "skip=0" or "search=value"
function parseStremioExtra(extraPathSegment) {
    const extra = {};
    if (extraPathSegment) {
        extraPathSegment.split('/').forEach(part => {
            const [key, value] = part.split('=');
            if (key && value) {
                extra[key] = decodeURIComponent(value);
            }
        });
    }
    return extra;
}

// --- Standard Stremio Addon Endpoints ---

// 1. Manifest Endpoint
app.get('/manifest.json', (req, res) => {
    logger.info('Serving manifest.json');
    res.json(manifest);
});

// 2. Catalog Endpoint (Handles variations for search and skip)
// General pattern: /catalog/:type/:id/:extraParams?.json
// :extraParams? is an optional path segment that can contain key=value pairs separated by /
app.get('/catalog/:type/:id/:extraParams?.json', async (req, res) => {
    logger.debug(`Handling catalog request for type: ${req.params.type}, id: ${req.params.id}, extraParams: ${req.params.extraParams}`);
    
    const { type, id } = req.params;
    const extra = parseStremioExtra(req.params.extraParams); // Parse search/skip from path

    try {
        const result = await catalogHandler(type, id, extra);
        res.json(result);
    } catch (error) {
        logger.error(`Error in catalog endpoint for ${id}:`, error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error in catalog endpoint for type=${type}, id=${id}`,
            error: error.message,
            url: req.originalUrl
        });
    }
});

// 3. Meta Endpoint
app.get('/meta/:type/:id.json', async (req, res) => {
    logger.debug(`Handling meta request for type: ${req.params.type}, id: ${req.params.id}`);
    const { type, id } = req.params;

    try {
        const result = await metaHandler(type, id);
        if (!result || !result.meta) {
            return res.status(404).json({ error: 'Not Found', message: 'Meta item not found.' });
        }
        res.json(result);
    } catch (error) {
        logger.error(`Error in meta endpoint for ${id}:`, error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error in meta endpoint for type=${type}, id=${id}`,
            error: error.message,
            url: req.originalUrl
        });
    }
});

// 4. Stream Endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    logger.debug(`Handling stream request for type: ${req.params.type}, id: ${req.params.id}`);
    const { type, id } = req.params;

    try {
        // The 'id' for streams is the full episodeKey in this architecture
        const result = await streamHandler(type, id);
        if (!result || !result.streams || result.streams.length === 0) {
            return res.status(404).json({ error: 'Not Found', message: 'Stream not found.' });
        }
        res.json(result);
    } catch (error) {
        logger.error(`Error in stream endpoint for ${id}:`, error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error in stream endpoint for type=${type}, id=${id}`,
            error: error.message,
            url: req.originalUrl
        });
    }
});


// --- Custom Debug and Root Endpoints ---

// Root route
app.get('/', (req, res) => {
    res.send(`<h1>${manifest.name} Stremio Addon is running!</h1><p>Visit /manifest.json for the addon manifest.</p><p>Visit /debug/crawl-data for crawl debugging.</p>`);
});

// Debug endpoint for crawl data
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


// Start the HTTP server
app.listen(config.PORT, () => {
    logger.info(`Stremio Addon server running on port ${config.PORT}`);
    // Start the crawler once the server is listening
    startCrawler();
});
