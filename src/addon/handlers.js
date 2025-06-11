const redisClient = require('../../src/redis'); // Import redisClient instance directly
const { config } = require('../../src/config');
const { logger } = require('../../src/utils/logger');
const { normalizeTitle, fuzzyMatch } = require('../../src/parser/title');

// In-memory cache for meta items to reduce Redis lookups
const metaCache = new Map();
const STREAM_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes for stream cache

/**
 * @typedef {object} VideoItem // This typedef is now primarily for documentation, not directly used for movie type metas.
 * @property {string} id
 * @property {string} title
 * @property {Date} released
 * @property {number} season
 * @property {number} episode
 */

/**
 * @typedef {object} StremioStream
 * @property {string} [name]
 * @property {string} [title]
 * @property {string} infoHash
 * @property {string[]} [sources]
 * @property {number} [fileIdx]
 * @property {string} [url]
 * @property {string} [ytId]
 * @property {string} [externalUrl]
 */

/**
 * Handles catalog requests from Stremio.
 * This will now return individual episodes as "movie" metas.
 * @param {string} type The type of catalog (expected 'movie').
 * @param {string} id The catalog ID (e.g., 'tamil-content').
 * @param {object} extra Stremio extra parameters (e.g., search, skip).
 * @returns {Promise<object>} A Promise resolving to an array of meta objects.
*/
async function catalogHandler(type, id, extra) {
  logger.info(`Received catalog request: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  
  // Catalog type should now be 'movie'
  if (type !== 'movie' || id !== 'tamil-content') {
    logger.warn(`Unsupported catalog request: type=${type}, id=${id}`);
    return { metas: [] };
  }

  let movieKeys = [];
  const searchKeywords = extra.search ? normalizeTitle(extra.search) : null;

  try {
    if (searchKeywords) {
      logger.info(`Performing search for: ${searchKeywords}`);
      const keys = await redisClient.keys('movie:*');
      for (const key of keys) {
        const movieData = await redisClient.hgetall(key);
        // Fuzzy match against the originalTitle which now includes episode info
        if (movieData && fuzzyMatch(searchKeywords, movieData.originalTitle)) {
          movieKeys.push(key);
        }
      }
    } else {
      movieKeys = await redisClient.keys('movie:*');
    }

    const metas = await Promise.all(movieKeys.map(async (key) => {
      try {
        const movieData = await redisClient.hgetall(key);
        if (!movieData) {
          logger.warn(`Missing movie data for key: ${key}`);
          return null;
        }

        const meta = {
          id: movieData.stremioId, // This is now the unique ID for each episode/stream
          type: 'movie', // Content type is "movie"
          name: movieData.originalTitle, // This is the full episode display title
          poster: movieData.posterUrl,
          posterShape: 'regular',
          background: movieData.posterUrl,
          description: `Source Thread: ${movieData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieData.threadStartedTime).toLocaleDateString()}`,
          releaseInfo: new Date(movieData.threadStartedTime).getFullYear().toString(),
          imdbRating: 'N/A',
          genres: movieData.languages ? JSON.parse(movieData.languages) : [],
          // 'videos' property is not applicable for 'movie' type and should be omitted or empty
        };
        
        metaCache.set(meta.id, meta); // Cache the meta item
        return meta;
      } catch (error) {
        logger.error(`Error processing movie (episode) data for key ${key} in catalogHandler:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error processing movie (episode) data for catalog key: ${key}`,
            error: error.message
        });
        return null;
      }
    }));

    // Sort the metas by last updated timestamp for fresh content first
    const filteredMetas = metas.filter(Boolean).sort((a, b) => {
      const dateA = new Date(metaCache.get(a.id)?.lastUpdated || 0).getTime();
      const dateB = new Date(metaCache.get(b.id)?.lastUpdated || 0).getTime();
      return dateB - dateA;
    });

    logger.info(`Returning ${filteredMetas.length} catalog items.`);
    return { metas: filteredMetas };
  } catch (error) {
    logger.error('Error in catalogHandler:', error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in catalogHandler for type=${type}, id=${id}`,
      error: error.message
    });
    return { metas: [] };
  }
}

/**
 * Handles meta requests from Stremio.
 * Expected ID is the unique episode-specific stremioMovieId.
 * @param {string} type The type of content (expected 'movie').
 * @param {string} id The ID of the content (expected the unique episode stremioMovieId).
 * @returns {Promise<object>} A Promise resolving to a meta object.
 */
async function metaHandler(type, id) {
  logger.info(`Received meta request: type=${type}, id=${id}`);
  
  // Type should be 'movie' and ID should start with 'tt'
  if (type !== 'movie' || !id.startsWith('tt')) {
    logger.warn(`Unsupported meta request: type=${type}, id=${id}`);
    return { meta: null };
  }

  // Try to retrieve from cache first
  if (metaCache.has(id)) {
    logger.info(`Returning meta from cache for ID: ${id}`);
    return { meta: metaCache.get(id) };
  }

  try {
    const movieData = await redisClient.hgetall(`movie:${id}`); // Fetch the specific episode's movie data
    if (!movieData) {
      logger.info(`Movie (episode) with Stremio ID ${id} not found in Redis.`);
      return { meta: null };
    }

    const meta = {
      id: movieData.stremioId,
      type: 'movie', // Content type is "movie"
      name: movieData.originalTitle, // Full episode display title
      poster: movieData.posterUrl,
      posterShape: 'regular',
      background: movieData.posterUrl,
      description: `Source Thread: ${movieData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieData.threadStartedTime).toLocaleDateString()}\nSeason: ${movieData.seasonNumber || 'N/A'}, Episode: ${movieData.episodeNumber || 'N/A'}`,
      releaseInfo: new Date(movieData.threadStartedTime).getFullYear().toString(),
      imdbRating: 'N/A',
      genres: movieData.languages ? JSON.parse(movieData.languages) : [],
      // 'videos' property is not used for 'movie' type
      videos: []
    };

    metaCache.set(id, meta); // Cache the meta item

    logger.info(`Returning meta for ID: ${id}.`);
    return { meta: meta };
  } catch (error) {
    logger.error(`Error in metaHandler for ID ${id}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in metaHandler for ID: ${id}`,
      error: error.message,
      url: id
    });
    return { meta: null };
  }
}

/**
 * Handles stream requests from Stremio.
 * Expected 'id' is the unique episode-specific stremioMovieId.
 * @param {string} type The type of content (expected 'movie').
 * @param {string} id The ID of the content (expected the unique episode stremioMovieId).
 * @returns {Promise<object>} A Promise resolving to an array of stream objects.
 */
async function streamHandler(type, id) {
  logger.info(`Received stream request: type=${type}, id=${id}`);
  logger.debug(`Stream request ID received by streamHandler: ${id}`);

  // Type should be 'movie'
  if (type !== 'movie' || !id.startsWith('tt')) {
      logger.warn(`Unsupported stream request: type=${type}, id=${id}`);
      return { streams: [] };
  }

  const streams = [];
  try {
      const streamData = await redisClient.hgetall(`movie:${id}`); // Fetch the specific episode's movie data
      logger.debug(`Retrieved streamData for ${id}:`, streamData); 

      if (!streamData || !streamData.infoHash) {
          logger.warn(`Stream data or infoHash not found for movie ID: ${id}. Skipping.`);
          logger.logToRedisErrorQueue({
              timestamp: new Date().toISOString(),
              level: 'WARN',
              message: `Movie ID ${id} has no infoHash or missing data`,
              url: id
          });
          return { streams: [] };
      }

      let sourcesArray = [];
      try {
        if (streamData.sources) {
          sourcesArray = JSON.parse(streamData.sources);
        }
      } catch (e) {
        logger.error(`Failed to parse sources for movie ID ${id}:`, e);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Failed to parse sources JSON for movie ID: ${id}`,
            error: e.message
        });
      }

      // Construct Stremio stream object from the movieData
      const stream = { 
        name: streamData.streamName, // Use streamName field from stored data
        title: streamData.streamTitle, // Use streamTitle field from stored data
        infoHash: streamData.infoHash,
        sources: sourcesArray,
      };
      
      streams.push(stream);
      logger.info(`Added stream for movie ID: ${id}.`);
  } catch (error) {
      logger.error(`Error processing stream data for movie ID ${id} in streamHandler:`, error);
      logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Error processing stream data for movie ID: ${id}`,
        error: error.message,
        url: id
      });
  }

  logger.info(`Returning ${streams.length} streams for movie ID: ${id}.`);
  return { streams: streams }; 
}

/**
 * Handles search requests from Stremio.
 * This is effectively absorbed into catalogHandler, but kept for clarity if needed.
 * @param {string} type The type of content.
 * @param {string} id The catalog ID (e.g., 'tamil-content').
 * @param {object} extra Stremio extra parameters including search.
 * @returns {Promise<object>} A Promise resolving to an array of meta objects.
 */
async function searchHandler(type, id, extra) {
  logger.info(`Received search request (delegated to catalogHandler): type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  return catalogHandler(type, id, extra);
}

module.exports = {
  catalogHandler,
  metaHandler,
  streamHandler,
};
