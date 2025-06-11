const redisClient = require('../../src/redis'); // Import redisClient instance directly
const { config } = require('../../src/config');
const { logger } = require('../utils/logger');
const { normalizeTitle, fuzzyMatch } = require('../../src/parser/title');

// In-memory cache for meta items to reduce Redis lookups
const metaCache = new Map();
const STREAM_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes for stream cache

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
 * This will now return series-season entries as "movie" metas.
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

  let movieGroupKeys = [];
  const searchKeywords = extra.search ? normalizeTitle(extra.search) : null;

  try {
    if (searchKeywords) {
      logger.info(`Performing search for: ${searchKeywords}`);
      // CHANGED: Search for 'movie:*' keys
      const keys = await redisClient.keys('movie:*'); 
      for (const key of keys) {
        const movieGroupData = await redisClient.hgetall(key);
        // Fuzzy match against the originalTitle of the movie group (e.g., "Suits LA (2025) S01")
        if (movieGroupData && fuzzyMatch(searchKeywords, movieGroupData.originalTitle)) {
          movieGroupKeys.push(key);
        }
      }
    } else {
      // CHANGED: Get all 'movie:*' keys
      movieGroupKeys = await redisClient.keys('movie:*'); 
    }

    const metas = await Promise.all(movieGroupKeys.map(async (key) => {
      try {
        const movieGroupData = await redisClient.hgetall(key);
        if (!movieGroupData) {
          logger.warn(`Missing movie group data for key: ${key}`);
          return null;
        }

        let genres = [];
        if (movieGroupData.languages) {
            try {
                genres = JSON.parse(movieGroupData.languages);
                if (!Array.isArray(genres)) {
                    logger.warn(`Parsed genres for key ${key} is not an array. Resetting to empty array.`);
                    genres = [];
                }
            } catch (e) {
                logger.error(`Failed to parse languages JSON for key ${key} in catalogHandler:`, e);
                logger.logToRedisErrorQueue({
                    timestamp: new Date().toISOString(),
                    level: 'ERROR',
                    message: `Failed to parse languages JSON for key: ${key} in catalogHandler`,
                    error: e.message
                });
                genres = []; // Reset to empty array on parsing error
            }
        }

        const meta = {
          id: movieGroupData.stremioId, // This is the unique ID for each series-season (e.g., ttsuits-la-2025-s01)
          type: 'movie', // Content type is "movie"
          name: movieGroupData.originalTitle, // The cleaned series-season display title
          poster: movieGroupData.posterUrl,
          posterShape: 'regular',
          background: movieGroupData.posterUrl,
          description: `Source Thread: ${movieGroupData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieGroupData.threadStartedTime).toLocaleDateString()}`,
          releaseInfo: new Date(movieGroupData.threadStartedTime).getFullYear().toString(),
          imdbRating: 'N/A',
          genres: genres, // Use the safely parsed genres
          // 'videos' property is NOT applicable for 'movie' type. Streams will be returned by streamHandler.
        };
        
        metaCache.set(meta.id, meta); // Cache the meta item
        return meta;
      } catch (error) {
        logger.error(`Error processing movie group data for key ${key} in catalogHandler:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error processing movie group data for catalog key: ${key}`,
            error: error.message
        });
        return null;
      }
    }));

    // Sort the metas by last updated timestamp for fresh content first
    const filteredMetas = metas.filter(Boolean).sort((a, b) => {
      const dateA = new Date(metaCache.get(a.id)?.lastUpdated || 0).getTime();
      // Ensure 'b' has lastUpdated if available, otherwise default to 0
      const bLastUpdated = metaCache.has(b.id) && metaCache.get(b.id)?.lastUpdated ? new Date(metaCache.get(b.id).lastUpdated).getTime() : 0;
      return bLastUpdated - dateA;
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
 * Expected ID is the unique series-season ID (e.g., ttsuits-la-2025-s01).
 * @param {string} type The type of content (expected 'movie').
 * @param {string} id The ID of the content (expected the unique movie group ID).
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
    // CHANGED: Fetch from 'movie:' prefix
    const movieGroupData = await redisClient.hgetall(`movie:${id}`); 
    if (!movieGroupData) {
      logger.info(`Movie group with Stremio ID ${id} not found in Redis.`);
      return { meta: null };
    }

    let genres = [];
    if (movieGroupData.languages) {
        try {
            genres = JSON.parse(movieGroupData.languages);
            if (!Array.isArray(genres)) {
                logger.warn(`Parsed genres for ID ${id} is not an array. Resetting to empty array.`);
                genres = [];
            }
        } catch (e) {
            logger.error(`Failed to parse languages JSON for ID ${id} in metaHandler:`, e);
            logger.logToRedisErrorQueue({
                timestamp: new Date().toISOString(),
                level: 'ERROR',
                message: `Failed to parse languages JSON for ID: ${id} in metaHandler`,
                error: e.message
            });
            genres = []; // Reset to empty array on parsing error
        }
    }

    const meta = {
      id: movieGroupData.stremioId,
      type: 'movie', // Content type is "movie"
      name: movieGroupData.originalTitle, // Cleaned series-season display title
      poster: movieGroupData.posterUrl,
      posterShape: 'regular',
      background: movieGroupData.posterUrl,
      description: `Source Thread: ${movieGroupData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieGroupData.threadStartedTime).toLocaleDateString()}`,
      releaseInfo: new Date(movieGroupData.threadStartedTime).getFullYear().toString(),
      imdbRating: 'N/A',
      genres: genres, // Use the safely parsed genres
      videos: [] // Must be empty for movie type
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
 * Expected 'id' is the unique series-season ID (e.g., ttsuits-la-2025-s01).
 * @param {string} type The type of content (expected 'movie').
 * @param {string} id The ID of the content (expected the unique movie group ID).
 * @returns {Promise<object>} A Promise resolving to an array of stream objects.
 */
async function streamHandler(type, id) {
  logger.info(`Received stream request: type=${type}, id=${id}`);
  logger.debug(`Stream request ID received by streamHandler: ${id}`);

  // Type should be 'movie' and ID should start with 'tt'
  if (type !== 'movie' || !id.startsWith('tt')) {
      logger.warn(`Unsupported stream request: type=${type}, id=${id}`);
      return { streams: [] };
  }

  const streams = [];
  try {
      // Fetch ALL individual streams associated with this movie group ID
      // CHANGED: Query for 'stream:' prefix
      const streamDataKeys = await redisClient.keys(`stream:${id}:*`); 
      logger.debug(`Found ${streamDataKeys.length} stream data keys for movie group ID ${id}: ${JSON.stringify(streamDataKeys)}`);

      if (streamDataKeys.length === 0) {
          logger.warn(`No stream data found for movie group ID: ${id}.`);
          return { streams: [] };
      }

      // Fetch details for all found stream data keys
      for (const streamDataKey of streamDataKeys) {
        try {
            // CHANGED: Fetch from 'stream:' prefix
            const streamData = await redisClient.hgetall(streamDataKey); 
            logger.debug(`Retrieved streamData for ${streamDataKey}:`, streamData); 

            if (!streamData || !streamData.infoHash) {
                logger.warn(`Stream data or infoHash not found for stream key: ${streamDataKey}. Skipping.`);
                logger.logToRedisErrorQueue({
                    timestamp: new Date().toISOString(),
                    level: 'WARN',
                    message: `Stream key ${streamDataKey} has no infoHash or missing data`,
                    url: streamDataKey
                });
                continue; // Skip to next if data not found or infoHash missing
            }

            let sourcesArray = [];
            try {
              if (streamData.sources) {
                sourcesArray = JSON.parse(streamData.sources);
                  if (!Array.isArray(sourcesArray)) {
                      logger.warn(`Parsed sources for stream key ${streamDataKey} is not an array. Resetting to empty array.`);
                      sourcesArray = [];
                  }
              }
            } catch (e) {
              logger.error(`Failed to parse sources for stream key ${streamDataKey}:`, e);
              logger.logToRedisErrorQueue({
                  timestamp: new Date().toISOString(),
                  level: 'ERROR',
                  message: `Failed to parse sources JSON for stream key: ${streamDataKey}`,
                  error: e.message
              });
              sourcesArray = []; // Reset to empty array on parsing error
            }

            // Construct Stremio stream object from the streamData
            const stream = { 
              name: streamData.name, // Use streamData.name (e.g., "TamilShows - 1080p")
              title: streamData.title, // Use streamData.title (e.g., "Suits LA (2025) S01 EP11 - LQ")
              infoHash: streamData.infoHash,
              sources: sourcesArray,
            };
            
            streams.push(stream);
            logger.info(`Added stream for stream key: ${streamDataKey}.`);
        } catch (error) {
            logger.error(`Error processing stream data for stream key ${streamDataKey} in streamHandler:`, error);
            logger.logToRedisErrorQueue({
              timestamp: new Date().toISOString(),
              level: 'ERROR',
              message: `Error processing stream data for stream key: ${streamDataKey}`,
              error: error.message,
              url: streamDataKey
            });
        }
      }
  } catch (error) {
      logger.error(`Error fetching stream data keys for movie group ID ${id} in streamHandler:`, error);
      logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Error fetching stream data keys for movie group ID: ${id}`,
        error: error.message,
        url: id
      });
  }

  logger.info(`Returning ${streams.length} streams for movie group ID: ${id}.`);
  // Sort streams if desired (e.g., by episode number, then resolution)
  streams.sort((a, b) => {
    // Assuming stream.title contains 'SXX EPYY' or similar for sorting
    const getEpisodeSortKey = (title) => {
        const match = title.match(/S(\d+)\s*EP\(?(\d+)/i);
        if (match) {
            return parseInt(match[1]) * 1000 + parseInt(match[2]); // Season * 1000 + Episode
        }
        return 0; // Default for non-matching titles
    };
    const getResolutionValue = (name) => {
        const resMatch = name.match(/(\d{3,4}p|4K)/i);
        if (resMatch) {
            const res = resMatch[1].toLowerCase();
            if (res === '4k') return 4000;
            return parseInt(res.replace('p', ''));
        }
        return 0; // Default
    };

    const episodeA = getEpisodeSortKey(a.title);
    const episodeB = getEpisodeSortKey(b.title);

    if (episodeA !== episodeB) {
        return episodeA - episodeB;
    }

    // If episodes are the same, sort by resolution (descending)
    return getResolutionValue(b.name) - getResolutionValue(a.name);
  });
  return { streams: streams }; 
}

/**
 * Handles search requests from Stremio.
 * @param {string} type The type of content (expected 'movie').
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
  searchHandler,
};
