// Use 'import type' for type-only imports to avoid TS2709 errors
import type { CatalogResponse, MetaResponse, StreamResponse, DiscoverableItem, Stream } from 'stremio-addon-sdk';
import { hgetall, zrangebyscore } from '../redis';
import { config } from '../config';
import { parseStremioId } from '../utils/stremioIdParser';
import { normalizeTitle } from '../parser/title';
import { logger } from '../utils/logger'; // Import the centralized logger
import redisClient from '../redis'; // Import redisClient for direct use

/**
 * Handles Stremio catalog requests.
 * Fetches and returns a list of series for the catalog.
 * @param type The type of content (e.g., 'series').
 * @param id The catalog ID (e.g., 'tamil-web-series').
 * @param genre The genre filter (not used in current spec, but good to have).
 * @param skip The number of items to skip for pagination.
 * @param search The search query for catalog filtering.
 * @returns A Promise resolving to a CatalogResponse.
 */
export async function getCatalog(
  type: string,
  id: string,
  genre?: string,
  skip: number = 0,
  searchQuery?: string
): Promise<CatalogResponse> {
  logger.info(`Received catalog request: type=${type}, id=${id}, genre=${genre}, skip=${skip}, search=${searchQuery}`);

  if (type !== 'series' || id !== 'tamil-web-series') {
    logger.warn(`Invalid catalog request: type=${type}, id=${id}`);
    return { metas: [] }; // Return empty if catalog ID doesn't match
  }

  // Fetch all show keys from Redis. This can be inefficient for very large datasets.
  // A more scalable approach would be to maintain a sorted set of all show IDs for pagination.
  // For now, let's assume we fetch all and paginate/filter in memory.
  const showKeys = await redisClient.keys('show:*');
  let allShows: DiscoverableItem[] = [];

  for (const key of showKeys) {
    const showData = await hgetall(key);
    if (Object.keys(showData).length > 0) {
      const stremioId = showData.stremioId || `tt${key.replace('show:', '')}`; // Use generated ID or fall back
      const posterUrl = showData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(showData.originalTitle || 'No Poster')}`;
      allShows.push({
        id: stremioId,
        name: showData.originalTitle || 'Unknown Title',
        type: 'series',
        poster: posterUrl,
      });
    }
  }

  // Apply search filtering if a query is present
  if (searchQuery) {
    const normalizedSearchQuery = normalizeTitle(searchQuery);
    allShows = allShows.filter(show =>
      normalizeTitle(show.name).includes(normalizedSearchQuery)
    );
    logger.debug(`Catalog search for "${searchQuery}" returned ${allShows.length} results.`);
  }

  // Simple in-memory pagination (for demonstration)
  const paginatedShows = allShows.slice(skip, skip + 100); // Limit to 100 items per page

  logger.info(`Returning ${paginatedShows.length} items for catalog.`);
  return { metas: paginatedShows };
}

/**
 * Handles Stremio metadata requests for a specific series.
 * @param type The type of content (e.g., 'series').
 * @param id The Stremio ID of the series (e.g., 'tt12345').
 * @returns A Promise resolving to a MetaResponse.
 */
export async function getMeta(type: string, id: string): Promise<MetaResponse> {
  logger.info(`Received meta request: type=${type}, id=${id}`);

  if (type !== 'series') {
    logger.warn(`Invalid meta request type: ${type}`);
    return { meta: null };
  }

  const { showId } = parseStremioId(id);

  if (!showId) {
    logger.warn(`Invalid Stremio ID format for meta request: ${id}`);
    return { meta: null };
  }

  // Fetch show details from Redis
  const showData = await hgetall(`show:${showId.replace('tt', '')}`); // Remove 'tt' prefix for Redis key

  if (Object.keys(showData).length === 0) {
    logger.info(`Show with ID ${showId} not found in Redis.`);
    return { meta: null };
  }

  const seasonNumbersString = showData.seasons || '';
  const seasonNumbers = seasonNumbersString.split(',').filter(Boolean).map(Number).sort((a,b) => a - b);

  const seasons: { season: number; title: string }[] = [];
  for (const seasonNum of seasonNumbers) {
    seasons.push({
      season: seasonNum,
      title: `Season ${seasonNum}`,
    });
  }

  // Construct the meta object
  const meta = {
    id: id,
    name: showData.originalTitle || 'Unknown Title',
    type: 'series' as const, // Explicitly cast to 'series' literal type
    poster: showData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(showData.originalTitle || 'No Poster')}`,
    description: showData.description || 'No description available.',
    background: showData.posterUrl,
    videos: seasons.map(s => ({
      id: `${id}:${s.season}`,
      title: s.title,
      season: s.season,
      released: new Date().toISOString(), // Placeholder, ideally from episode data
    }))
  };

  logger.info(`Returning meta for ${meta.id}.`);
  return { meta };
}

/**
 * Handles Stremio stream requests for a specific episode.
 * @param type The type of content (e.g., 'series').
 * @param id The Stremio ID of the episode (e.g., 'tt12345:1:2' for S1E2).
 * @returns A Promise resolving to a StreamResponse.
 */
export async function getStream(type: string, id: string): Promise<StreamResponse> {
  logger.info(`Received stream request: type=${type}, id=${id}`);

  if (type !== 'series') {
    logger.warn(`Invalid stream request type: ${type}`);
    return { streams: [] };
  }

  const { showId, seasonNum, episodeNum } = parseStremioId(id);

  if (!showId || seasonNum === undefined || episodeNum === undefined) {
    logger.warn(`Invalid Stremio ID format for stream: ${id}`);
    return { streams: [] };
  }

  // Construct the key for the episode data in Redis
  const episodeKey = `episode:season:${showId.replace('tt', '')}:${seasonNum}:${episodeNum}`;
  const episodeData = await hgetall(episodeKey);

  if (Object.keys(episodeData).length === 0) {
    logger.info(`No stream data found for ID: ${id} (episodeKey: ${episodeKey})`);
    return { streams: [] };
  }

  // Construct the stream object
  const stream: Stream = {
    name: episodeData.name || config.ADDON_NAME,
    title: episodeData.title || `S${seasonNum} E${episodeNum}`,
    url: episodeData.magnet || '',
  };

  // Only return the stream if a valid magnet URL exists
  if (stream.url) {
    logger.info(`Returning stream for ${stream.title}.`);
    return { streams: [stream] };
  } else {
    logger.warn(`No magnet URL found for episode ID: ${id}`);
    return { streams: [] };
  }
}

/**
 * Handles Stremio search requests.
 * @param query The search query string.
 * @returns A Promise resolving to a CatalogResponse (list of metas).
 */
export async function search(query: string): Promise<CatalogResponse> {
  logger.info(`Received search request for query: ${query}`);
  // Reuse the getCatalog logic with the search query
  return getCatalog('series', 'tamil-web-series', undefined, 0, query);
}
