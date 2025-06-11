const redisClient = require('../../src/redis'); // Direct require of the default exported redisClient instance
const { config } = require('../../src/config');
const { logger } = require('../../src/utils/logger');
const { normalizeTitle, fuzzyMatch } = require('../../src/parser/title'); // Import normalizeTitle and fuzzyMatch

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

/**
 * Maps resolution strings to numerical values for sorting purposes.
 * Higher values represent higher quality.
 * @type {Object.<string, number>}
 */
const resolutionOrder = {
  '4K': 4000,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  'unknown': 0
};

/**
 * Helper function to get the numerical value of a resolution for sorting.
 * @param {string|undefined} resolution The resolution string (e.g., '1080p', '4K'), or undefined.
 * @returns {number} The numerical value for sorting, or 0 if unknown.
 */
function getResolutionValue(resolution) {
  let keyToUse;
  if (typeof resolution === 'string' && Object.prototype.hasOwnProperty.call(resolutionOrder, resolution)) {
    keyToUse = resolution;
  } else {
    keyToUse = 'unknown';
  }
  return resolutionOrder[keyToUse];
}


/**
 * Handles catalog requests from Stremio.
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
  
  if (type !== 'series' || !id.startsWith('tt')) {
    logger.warn(`Unsupported meta request: type=${type}, id=${id}`);
    return { meta: null };
  }

  if (metaCache.has(id)) {
    logger.info(`Returning meta from cache for ID: ${id}`);
    return { meta: metaCache.get(id) };
  }

  try {
    const movieData = await redisClient.hgetall(`movie:${id}`);
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
      videos: [],
    };


    const episodeKeys = await redisClient.keys(`episode:${id}:s*`);
    const videos = await Promise.all(episodeKeys.map(async (key) => {
      const episodeData = await redisClient.hgetall(key);
      if (!episodeData) {
        logger.warn(`Missing episode data for key: ${key}`);
        return null;
      }
      
      const parts = key.split(':');
      const seasonMatch = parts[2]?.match(/s(\d+)/);
      const episodeMatch = parts[3]?.match(/e(\d+)/);

      const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
      const episode = episodeMatch ? parseInt(episodeMatch[1], 10) : 1;

      return {
        id: key,
        title: episodeData.title,
        released: episodeData.timestamp ? new Date(episodeData.timestamp) : new Date(),
        season: season,
        episode: episode,
      };
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

  const stremioMovieId = id.split(':')[0];

  try {
    const streamKeys = await redisClient.keys(`episode:${stremioMovieId}:*`);
    
    // Fetch data and create stream objects directly
    const streams = await Promise.all(streamKeys.map(async (key) => {
      const streamData = await redisClient.hgetall(key);
      if (!streamData) {
        logger.warn(`Missing stream data for key: ${key}`);
        return null;
      }

      let sourcesArray = [];
      try {
        if (streamData.sources) {
          sourcesArray = JSON.parse(streamData.sources);
        }
      } catch (e) {
        logger.error(`Failed to parse sources for key ${key}:`, e);
      }

      // Construct Stremio stream object directly
      const stream = { 
        name: streamData.name,
        title: streamData.title,
        infoHash: streamData.infoHash,
        sources: sourcesArray,
      };
      
      if (!stream.infoHash) {
          logger.warn(`Stream for key ${key} has no infoHash. Skipping.`);
          return null;
      }

      return stream;
    }));

    // Filter out nulls. No sorting by resolution here as per request.
    const finalStremioStreams = streams.filter(Boolean);

    logger.info(`Returning ${finalStremioStreams.length} streams for movie ID ${stremioMovieId}.`);
    return { streams: finalStremioStreams };
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
 * @param {string} type The type of content.
 * @param {string} id The catalog ID (e.g., 'tamil-web-series').
 * @param {object} extra Stremio extra parameters including search.
 * @returns {Promise<object>} A Promise resolving to an array of meta objects.
 */
async function searchHandler(type, id, extra) {
  logger.info(`Received search request: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  return catalogHandler(type, id, extra);
}

module.exports = {
  catalogHandler,
  metaHandler,
  streamHandler,
  searchHandler
};
