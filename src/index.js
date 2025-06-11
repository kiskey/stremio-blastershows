const { addonBuilder, serveHTTP } = require('stremio-addon-sdk'); // Corrected import
const { config, LogLevel } = require('./config');
const { logger } = require('./utils/logger');
const { getManifest } = require('./addon/manifest'); // Renamed import from manifest.ts to manifest.js
const { catalogHandler, metaHandler, streamHandler, searchHandler } = require('./addon/handlers'); // Corrected import names
const { startCrawler } = require('./crawler/engine');
// No direct require of redisClient here, as it's handled internally by redis.js and used in handlers/engine

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

// Start the HTTP server for the addon
serveHTTP(builder.
