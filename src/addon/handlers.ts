import type { CatalogResponse, MetaResponse, StreamResponse, DiscoverableItem, Stream } from 'stremio-addon-sdk';
import { hgetall, zrangebyscore } from '../redis';
import { config } from '../config';
import { parseStremioId } from '../utils/stremioIdParser';
import { normalizeTitle } from '../parser/title';
import { logger } from '../utils/logger'; // Import the centralized logger
import redisClient from '../redis'; // Import redisClient for direct use

/**
 * Handles Stremio catalog requests.
 * Fetches and returns a list of movies for the catalog.
 * @param type The type of content (must be 'movie').
 * @param id The catalog ID (e.g., 'tamil-web-movies').
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

  if (type !== 'movie' || id !== 'tamil-web-movies') { // Changed type and id checks
    logger.warn(`Invalid catalog request: type=${type}, id=${id}`);
    return { metas: [] }; // Return empty if catalog ID doesn't match
  }

  // Fetch all show keys from Redis.
  // We'll treat each 'show' as a 'movie' for catalog display.
  const showKeys = await redisClient.keys('show:*');
  let allMovies: DiscoverableItem[] = [];

  for (const key of showKeys) {
    const showData = await hgetall(key);
    if (Object.keys(showData).length > 0) {
      // Ensure stremioId is generated consistently as 'tt' + normalized title
      const stremioId = showData.stremioId || `tt${showData.originalTitle?.toLowerCase().replace(/[^a-z0-9]/g, '') || ''}`;
      const posterUrl = showData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(showData.originalTitle || 'No Poster')}`;
      allMovies.push({
        id: stremioId,
        name: showData.originalTitle || 'Unknown Title',
        type: 'movie', // Always 'movie' type for catalog display
        poster: posterUrl,
      });
    }
  }

  // Apply search filtering if a query is present
  if (searchQuery) {
    const normalizedSearchQuery = normalizeTitle(searchQuery);
    allMovies = allMovies.filter(movie =>
      normalizeTitle(movie.name).includes(normalizedSearchQuery)
    );
    logger.debug(`Catalog search for "${searchQuery}" returned ${allMovies.length} results.`);
  }

  // Simple in-memory pagination (for demonstration)
  // Ensure we sort for consistent pagination results
  allMovies.sort((a, b) => a.name.localeCompare(b.name));
  const paginatedMovies = allMovies.slice(skip, skip + 100); // Limit to 100 items per page

  logger.info(`Returning ${paginatedMovies.length} items for catalog. Total available: ${allMovies.length}`);
  return { metas: paginatedMovies };
}

/**
 * Handles Stremio metadata requests for a specific movie (which is a show/series).
 * For 'movie' type, this typically provides details for the single movie entity.
 * @param type The type of content (must be 'movie').
 * @param id The Stremio ID of the movie (e.g., 'ttnormalizedtitle').
 * @returns A Promise resolving to a MetaResponse.
 */
export async function getMeta(type: string, id: string): Promise<MetaResponse> {
  logger.info(`Received meta request: type=${type}, id=${id}`);

  if (type !== 'movie') { // Changed type check
    logger.warn(`Invalid meta request type: ${type}`);
    return { meta: null };
  }

  const { movieId } = parseStremioId(id);

  if (!movieId) {
    logger.warn(`Invalid Stremio ID format for meta request: ${id}`);
    return { meta: null };
  }

  // Fetch show details from Redis using the normalized title as the movie ID
  const showData = await hgetall(`show:${movieId}`);

  if (Object.keys(showData).length === 0) {
    logger.info(`Movie with ID ${movieId} not found in Redis.`);
    return { meta: null };
  }

  // Construct the meta object for the 'movie'.
  // For 'movie' type, the 'videos' array is not typically used for episodes.
  // Streams are fetched via the getStream handler directly.
  const meta = {
    id: id,
    name: showData.originalTitle || 'Unknown Title',
    type: 'movie' as const, // Explicitly cast to 'movie' literal type
    poster: showData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(showData.originalTitle || 'No Poster')}`,
    description: showData.description || 'No description available.',
    background: showData.posterUrl,
    // Do NOT include 'videos' array here as per Stremio's 'movie' type convention
    // and the request to list all episodes/qualities under the 'stream' endpoint.
    // However, if the source contains a single item (like a movie), we might
    // put its primary stream info here. For now, we'll rely on the stream handler.
  };

  logger.info(`Returning meta for ${meta.id}.`);
  return { meta };
}

/**
 * Handles Stremio stream requests for a specific movie.
 * This will aggregate all episode/quality streams for the given movie ID.
 * @param type The type of content (must be 'movie').
 * @param id The Stremio ID of the movie (e.g., 'ttnormalizedtitle').
 * @returns A Promise resolving to a StreamResponse containing all available streams.
 */
export async function getStream(type: string, id: string): Promise<StreamResponse> {
  logger.info(`Received stream request: type=${type}, id=${id}`);

  if (type !== 'movie') { // Changed type check
    logger.warn(`Invalid stream request type: ${type}`);
    return { streams: [] };
  }

  const { movieId } = parseStremioId(id);

  if (!movieId) {
    logger.warn(`Invalid Stremio ID format for stream: ${id}`);
    return { streams: [] };
  }

  const allStreams: Stream[] = [];

  // Find all episode keys associated with this movie ID (normalized title)
  // This involves scanning Redis keys, which can be slow for many entries.
  // A more efficient approach would be to store a sorted set of episode IDs under the show key.
  const episodeKeys = await redisClient.keys(`episode:season:tt${movieId}:*`);

  logger.debug(`Found ${episodeKeys.length} episode keys for movie ID ${movieId}.`);

  for (const episodeKey of episodeKeys) {
    const episodeData = await hgetall(episodeKey);
    if (Object.keys(episodeData).length > 0 && episodeData.magnet) {
      // Extract season and episode from the episodeKey for stream title
      const keyParts = episodeKey.split(':');
      const seasonNum = keyParts[keyParts.length - 2];
      const episodeNum = keyParts[keyParts.length - 1];

      // Extract original show title from the main showData for better stream titles
      const showData = await hgetall(`show:${movieId}`);
      const originalTitle = showData.originalTitle || 'Unknown Title';

      const streamTitle = `${originalTitle} S${seasonNum} E${episodeNum} ${episodeData.size ? `[${episodeData.size}]` : ''} ${episodeData.name ? `(${episodeData.name})` : ''}`.trim();

      allStreams.push({
        name: config.ADDON_NAME, // Or a more specific source name
        title: streamTitle,
        url: episodeData.magnet,
        // Add P2P hint for magnet links
        behaviorHints: {
          p2p: true,
          // You might also add `filename` here if you have it
          filename: `${originalTitle} S${seasonNum} E${episodeNum}.torrent` // Example filename
        }
      });
    }
  }

  logger.info(`Returning ${allStreams.length} streams for movie ID ${id}.`);
  return { streams: allStreams };
}

/**
 * Handles Stremio search requests.
 * @param query The search query string.
 * @returns A Promise resolving to a CatalogResponse (list of metas).
 */
export async function search(query: string): Promise<CatalogResponse> {
  logger.info(`Received search request for query: ${query}`);
  // Reuse the getCatalog logic with the search query, for 'movie' type
  return getCatalog('movie', 'tamil-web-movies', undefined, 0, query);
}
