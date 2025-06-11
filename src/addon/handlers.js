const redisClient = require('../../src/redis'); // Import redisClient instance directly
const { config } = require('../../src/config');
const { logger } = require('../../src/utils/logger');
const { normalizeTitle, fuzzyMatch } = require('../../src/parser/title');

// In-memory cache for meta items to reduce Redis lookups
const metaCache = new Map();
const STREAM_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes for stream cache

/**
 * @typedef {object} VideoItem
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

// Removed resolutionOrder map and getResolutionValue helper function (not used for sorting anymore)


/**
 * Handles catalog requests from Stremio.
 * This includes handling search requests via the 'extra.search' parameter.
 * @param {string} type The type of catalog (e.g., 'series').
 * @param {string} id The catalog ID (e.g., 'tamil-web-series').
 * @param {object} extra Stremio extra parameters (e.g., search, skip).
 * @returns {Promise<object>} A Promise resolving to an array of meta objects.
 */
async function catalogHandler(type, id, extra) {
  logger.info(`Received catalog request: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  
  if (type !== 'series' || id !== 'tamil-web-series') {
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
        if (movieData && fuzzyMatch(searchKeywords, normalizeTitle(movieData.originalTitle))) {
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
          id: movieData.stremioId,
          type: 'series',
          name: movieData.originalTitle,
          poster: movieData.posterUrl,
          posterShape: 'regular',
          background: movieData.posterUrl,
          description: `Source Thread: ${movieData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieData.threadStartedTime).toLocaleDateString()}`,
          releaseInfo: new Date(movieData.threadStartedTime).getFullYear().toString(),
          imdbRating: 'N/A',
          genres: movieData.languages ? movieData.languages.split(',') : [],
          videos: movieData.seasons ? JSON.parse(movieData.seasons).map(s => ({ season: s })) : [],
        };
        
        metaCache.set(meta.id, meta);
        return meta;
      } catch (error) {
        logger.error(`Error processing movie data for key ${key} in catalogHandler:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error processing movie data for catalog key: ${key}`,
            error: error.message
        });
        return null;
      }
    }));

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
 * @param {string} type The type of content.
 * @param {string} id The ID of the content.
 * @returns {Promise<object>} A Promise resolving to a meta object.
 */
async function metaHandler(type, id) {
  logger.info(`Received meta request: type=${type}, id=${id}`);
  
  // The 'id' for meta requests now follows the standardized format: tt<normalizedTitle>-<year>-s<seasonNum>
  // Ensure we check for 'series' type and correct ID format
  if (type !== 'series' || !id.startsWith('tt')) {
    logger.warn(`Unsupported meta request: type=${type}, id=${id}`);
    return { meta: null };
  }

  // Try to retrieve from cache first
  if (metaCache.has(id)) {
    logger.info(`Returning meta from cache for ID: ${id}`);
    return { meta: metaCache.get(id) };
  }

  try {
    const movieData = await redisClient.hgetall(`movie:${id}`); // Use the standardized ID here
    if (!movieData) {
      logger.info(`Movie with Stremio ID ${id} not found in Redis.`);
      return { meta: null };
    }

    const meta = {
      id: movieData.stremioId,
      type: 'series',
      name: movieData.originalTitle,
      poster: movieData.posterUrl,
      posterShape: 'regular',
      background: movieData.posterUrl,
      description: `Source Thread: ${movieData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieData.threadStartedTime).toLocaleDateString()}`,
      releaseInfo: new Date(movieData.threadStartedTime).getFullYear().toString(),
      imdbRating: 'N/A',
      genres: movieData.languages ? movieData.languages.split(',') : [],
      videos: [], // Will be populated with episode details
    };


    // Fetch all episode streams for this movie/series using the standardized movie ID prefix
    const episodeKeys = await redisClient.keys(`episode:${id}:s*`); // Keys now match the standardized movie ID
    const videos = await Promise.all(episodeKeys.map(async (key) => {
      try {
        const episodeData = await redisClient.hgetall(key);
        if (!episodeData) {
          logger.warn(`Missing episode data for key: ${key}`);
          return null;
        }
        
        // Parse season and episode from the episodeKey which includes standardized parts
        // e.g., episode:ttnormalizedtitle-year-sseasonnum:s<season>e<episode>:<resolution>:<infoHash>
        const parts = key.split(':');
        const seasonMatch = parts[3]?.match(/s(\d+)/); // Parts[3] now contains s<season>e<episode>
        const episodeMatch = parts[3]?.match(/e(\d+)/);

        const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
        const episode = episodeMatch ? parseInt(episodeMatch[1], 10) : 1;

        return {
          id: key, // Unique ID for the video (stream)
          title: episodeData.title,
          released: episodeData.timestamp ? new Date(episodeData.timestamp) : new Date(),
          season: season,
          episode: episode,
        };
      } catch (error) {
        logger.error(`Error processing episode data for key ${key} in metaHandler:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error processing episode data for meta key: ${key}`,
            error: error.message
        });
        return null;
      }
    }));

    meta.videos = videos.filter(Boolean).sort((a, b) => {
      if (a.season !== b.season) {
        return a.season - b.season;
      }
      return a.episode - b.episode;
    });

    metaCache.set(id, meta);

    logger.info(`Returning meta for ID: ${id}`);
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
 * @param {string} type The type of content.
 * @param {string} id The ID of the content.
 * @returns {Promise<object>} A Promise resolving to an array of stream objects.
 */
async function streamHandler(type, id) {
  logger.info(`Received stream request: type=${type}, id=${id}`);

  // The 'id' for stream requests now directly corresponds to the full episodeKey,
  // e.g., episode:ttnormalizedtitle-year-sseasonnum:s<season>e<episode>:<resolution>:<infoHash>
  // We need to fetch the stream data for this exact key.
  // The 'id' parameter is the full 'episodeKey' as stored in Redis.

  try {
    const streamData = await redisClient.hgetall(id); // Fetch using the full 'id' directly
    if (!streamData) {
      logger.warn(`Stream data not found for ID: ${id}.`);
      return { streams: [] };
    }

    let sourcesArray = [];
    try {
      if (streamData.sources) {
        sourcesArray = JSON.parse(streamData.sources);
      }
    } catch (e) {
      logger.error(`Failed to parse sources for key ${id}:`, e);
      logger.logToRedisErrorQueue({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          message: `Failed to parse sources JSON for key: ${id}`,
          error: e.message
      });
    }

    // Construct Stremio stream object
    const stream = { 
      name: streamData.name,
      title: streamData.title,
      infoHash: streamData.infoHash,
      sources: sourcesArray,
      // fileIdx, url, ytId, externalUrl are optional and not currently stored/used
    };
    
    if (!stream.infoHash) {
        logger.warn(`Stream for ID ${id} has no infoHash. Skipping.`);
        return { streams: [] }; // Return empty if no infoHash
    }

    logger.info(`Returning stream for ID: ${id}.`);
    return { streams: [stream] }; // Return an array with the single stream
  } catch (error) {
    logger.error(`Error in streamHandler for ID ${id}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in streamHandler for ID: ${id}`,
      error: error.message,
      url: id
    });
    return { streams: [] };
  }
}

/**
 * Handles search requests from Stremio.
 * This is effectively absorbed into catalogHandler, but kept for clarity if needed.
 * @param {string} type The type of content.
 * @param {string} id The catalog ID (e.g., 'tamil-web-series').
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
  // searchHandler is no longer directly exposed, its logic is within catalogHandler
  // if you need a separate searchHandler that *only* handles search, you can keep it
  // and map the express route to it. For now, catalogHandler handles it.
};
