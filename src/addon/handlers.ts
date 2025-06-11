import redisClient from '../../src/redis'; // Direct import of the default exported redisClient instance
import { config } from '../../src/config';
import { logger } from '../../src/utils/logger';
import { normalizeTitle } from '../../src/parser/title'; // Import normalizeTitle
import { fuzzyMatch } from '../../src/parser/title'; // Import fuzzyMatch
import { parseTitle } from '../../src/parser/title'; // Import parseTitle

// In-memory cache for meta items to reduce Redis lookups
const metaCache = new Map<string, any>();
const STREAM_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes for stream cache

/**
 * Interface for a video item as stored in the meta object's videos array.
 */
interface VideoItem {
  id: string;
  title: string;
  released: Date;
  season: number;
  episode: number;
}

/**
 * Interface for a Stremio stream object.
 */
interface StremioStream {
  name?: string;
  title?: string;
  infoHash: string;
  sources?: string[];
  fileIdx?: number;
  url?: string;
  ytId?: string;
  externalUrl?: string;
}

/**
 * Interface for the intermediate stream object used internally for processing,
 * without resolution or score for sorting.
 */
interface TempStreamForProcessing {
  name?: string;
  title?: string;
  infoHash: string;
  sources?: string[];
  // The 'resolution' and 'score' fields are removed as they are not used for sorting here.
  // Original resolution from Redis will still be accessible through streamData for constructing name/title
}

// Removed resolutionOrder map and getResolutionValue helper function

/**
 * Handles catalog requests from Stremio.
 * This fetches movie/series metadata from Redis to display in the Stremio UI.
 * @param type The type of catalog (e.g., 'series').
 * @param id The catalog ID (e.g., 'tamil-web-series').
 * @param extra Stremio extra parameters (e.g., search, skip).
 * @returns A Promise resolving to an array of meta objects.
 */
export async function catalogHandler(type: string, id: string, extra: any): Promise<any> {
  logger.info(`Received catalog request: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  
  if (type !== 'series' || id !== 'tamil-web-series') {
    logger.warn(`Unsupported catalog request: type=${type}, id=${id}`);
    return { metas: [] };
  }

  let movieKeys: string[] = [];
  const searchKeywords = extra.search ? normalizeTitle(extra.search) : null;

  try {
    if (searchKeywords) {
      logger.info(`Performing search for: ${searchKeywords}`);
      // When searching, find keys that match the normalized search keywords
      const keys = await redisClient.keys('movie:*');
      for (const key of keys) {
        const movieData = await redisClient.hgetall(key);
        if (movieData && fuzzyMatch(searchKeywords, normalizeTitle(movieData.originalTitle))) {
          movieKeys.push(key);
        }
      }
    } else {
      // For general catalog, fetch all movie keys
      movieKeys = await redisClient.keys('movie:*');
    }

    const metas = await Promise.all(movieKeys.map(async (key: string) => { // Explicitly type 'key'
      const movieData = await redisClient.hgetall(key);
      if (!movieData) {
        logger.warn(`Missing movie data for key: ${key}`);
        return null;
      }

      // Populate meta object based on Stremio's Meta Preview Object structure
      const meta = {
        id: movieData.stremioId,
        type: 'series', // Assuming all content in this addon is 'series'
        name: movieData.originalTitle,
        poster: movieData.posterUrl,
        posterShape: 'regular',
        background: movieData.posterUrl,
        description: `Source Thread: ${movieData.associatedThreadId || 'N/A'}\nStarted: ${new Date(movieData.threadStartedTime).toLocaleDateString()}`,
        releaseInfo: new Date(movieData.threadStartedTime).getFullYear().toString(),
        imdbRating: 'N/A', // No IMDB rating available from current source
        genres: movieData.languages ? movieData.languages.split(',') : [],
        // Specify available seasons if 'seasons' data is stored
        videos: movieData.seasons ? JSON.parse(movieData.seasons).map((s: number) => ({ season: s })) : [],
      };
      
      // Cache the meta item
      metaCache.set(meta.id, meta);

      return meta;
    }));

    // Filter out any null entries (due to missing data) and sort by lastUpdated (newest first)
    const filteredMetas = metas.filter(Boolean).sort((a: any, b: any) => {
      const dateA = new Date(metaCache.get(a.id)?.lastUpdated || 0).getTime();
      const dateB = new Date(metaCache.get(b.id)?.lastUpdated || 0).getTime();
      return dateB - dateA; // Descending order (newest first)
    });

    logger.info(`Returning ${filteredMetas.length} catalog items.`);
    return { metas: filteredMetas };
  } catch (error) {
    logger.error('Error in catalogHandler:', error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in catalogHandler for type=${type}, id=${id}`,
      error: (error as Error).message
    });
    return { metas: [] };
  }
}

/**
 * Handles meta requests from Stremio.
 * This fetches detailed metadata for a specific movie/series.
 * @param type The type of content.
 * @param id The ID of the content.
 * @returns A Promise resolving to a meta object.
 */
export async function metaHandler(type: string, id: string): Promise<any> {
  logger.info(`Received meta request: type=${type}, id=${id}`);
  
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
    const movieData = await redisClient.hgetall(`movie:${id}`);
    if (!movieData) {
      logger.info(`Movie with Stremio ID ${id} not found in Redis.`);
      return { meta: null };
    }

    const meta: { id: string; type: string; name: string; poster: string; posterShape: string; background: string; description: string; releaseInfo: string; imdbRating: string; genres: string[]; videos: VideoItem[]; } = {
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


    // Fetch all episode streams for this movie/series
    const episodeKeys = await redisClient.keys(`episode:${id}:s*`);
    const videos = await Promise.all(episodeKeys.map(async (key: string) => { // Explicitly type 'key'
      const episodeData = await redisClient.hgetall(key);
      if (!episodeData) {
        logger.warn(`Missing episode data for key: ${key}`);
        return null;
      }
      
      // Parse season and episode from key
      const parts = key.split(':');
      const seasonMatch = parts[2]?.match(/s(\d+)/); // e.g., s1
      const episodeMatch = parts[3]?.match(/e(\d+)/); // e.g., e1

      const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
      const episode = episodeMatch ? parseInt(episodeMatch[1], 10) : 1;

      return {
        id: key, // Unique ID for the video (stream)
        title: episodeData.title,
        released: episodeData.timestamp ? new Date(episodeData.timestamp) : new Date(),
        season: season,
        episode: episode,
      } as VideoItem; // Assert type to VideoItem
    }));

    meta.videos = videos.filter(Boolean).sort((a: VideoItem, b: VideoItem) => { // Explicitly type 'a' and 'b'
      // Sort videos by season then by episode
      if (a.season !== b.season) {
        return a.season - b.season;
      }
      return a.episode - b.episode;
    });

    // Cache the detailed meta item
    metaCache.set(id, meta);

    logger.info(`Returning meta for ID: ${id}`);
    return { meta: meta };
  } catch (error) {
    logger.error(`Error in metaHandler for ID ${id}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in metaHandler for ID: ${id}`,
      error: (error as Error).message,
      url: id // Using ID as URL context for error logging
    });
    return { meta: [] };
  }
}

/**
 * Handles stream requests from Stremio.
 * This fetches stream information (magnets/infoHashes) for a specific video.
 * @param type The type of content.
 * @param id The ID of the content.
 * @returns A Promise resolving to an array of stream objects.
 */
export async function streamHandler(type: string, id: string): Promise<any> {
  logger.info(`Received stream request: type=${type}, id=${id}`);

  // Stremio ID format for streams is usually <stremioMovieId>:s<season>e<episode>:<resolution>:<infoHash>
  // We need to fetch all streams associated with the given Stremio Movie ID (ttXXXX)
  const stremioMovieId = id.split(':')[0]; // Extract the base movie ID from the Stremio stream ID

  try {
    const streamKeys = await redisClient.keys(`episode:${stremioMovieId}:*`);
    
    // Fetch data and create stream objects directly
    const streams: (StremioStream | null)[] = await Promise.all(streamKeys.map(async (key: string) => {
      const streamData = await redisClient.hgetall(key);
      if (!streamData) {
        logger.warn(`Missing stream data for key: ${key}`);
        return null;
      }

      // Parse sources from JSON string stored in Redis
      let sourcesArray: string[] = [];
      try {
        if (streamData.sources) {
          sourcesArray = JSON.parse(streamData.sources);
        }
      } catch (e) {
        logger.error(`Failed to parse sources for key ${key}:`, e);
      }

      // Construct Stremio stream object directly
      const stream: StremioStream = { 
        name: streamData.name,
        title: streamData.title,
        infoHash: streamData.infoHash,
        sources: sourcesArray,
      };
      
      // Ensure that 'infoHash' is present, otherwise the stream is invalid for Stremio
      if (!stream.infoHash) {
          logger.warn(`Stream for key ${key} has no infoHash. Skipping.`);
          return null;
      }

      return stream;
    }));

    // Filter out nulls. No sorting by resolution here as per request.
    const finalStremioStreams: StremioStream[] = streams.filter((s): s is StremioStream => s !== null);

    logger.info(`Returning ${finalStremioStreams.length} streams for movie ID ${stremioMovieId}.`);
    return { streams: finalStremioStreams };
  } catch (error) {
    logger.error(`Error in streamHandler for ID ${id}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Error in streamHandler for ID: ${id}`,
      error: (error as Error).message,
      url: id // Using ID as URL context for error logging
    });
    return { streams: [] };
  }
}

/**
 * Handles search requests from Stremio.
 * This simply delegates to the catalogHandler with the search extra.
 * @param type The type of content.
 * @param id The catalog ID (e.g., 'tamil-web-series').
 * @param extra Stremio extra parameters including search.
 * @returns A Promise resolving to an array of meta objects.
 */
export async function searchHandler(type: string, id: string, extra: any): Promise<any> {
  logger.info(`Received search request: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
  // Delegate search functionality to the catalog handler
  return catalogHandler(type, id, extra);
}
