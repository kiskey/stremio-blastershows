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

  // Fetch all movie keys from Redis. These keys are now based on stremioMovieId: movie:<stremioMovieId>
  const movieKeys = await redisClient.keys('movie:*');
  let allMovies: (DiscoverableItem & { threadStartedTime?: string })[] = []; // Add threadStartedTime for sorting

  for (const key of movieKeys) {
    const movieData = await hgetall(key); // Fetch data for movie:<stremioMovieId>
    if (Object.keys(movieData).length > 0 && movieData.stremioId && movieData.originalTitle) {
      // Use the stored stremioId and originalTitle
      const stremioId = movieData.stremioId;
      const originalTitle = movieData.originalTitle;
      const posterUrl = movieData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(originalTitle || 'No Poster')}`;
      allMovies.push({
        id: stremioId,
        name: originalTitle,
        type: 'movie', // Always 'movie' type for catalog display
        poster: posterUrl,
        threadStartedTime: movieData.threadStartedTime // Add for sorting
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

  // Sort by threadStartedTime in descending order (latest first)
  allMovies.sort((a, b) => {
    const dateA = new Date(a.threadStartedTime || 0).getTime();
    const dateB = new Date(b.threadStartedTime || 0).getTime();
    return dateB - dateA; // Descending order
  });

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

  const { movieId } = parseStremioId(id); // movieId is the normalized title string without 'tt'

  if (!movieId) {
    logger.warn(`Invalid Stremio ID format for meta request: ${id}`);
    return { meta: null };
  }

  // Directly fetch movie data using the Stremio ID as the Redis key
  const movieData = await hgetall(`movie:${id}`); // Key is movie:<stremioMovieId>

  if (Object.keys(movieData).length === 0) {
    logger.info(`Movie with Stremio ID ${id} not found in Redis.`);
    return { meta: null };
  }

  // Construct the meta object for the 'movie'.
  const meta = {
    id: id,
    name: movieData.originalTitle || 'Unknown Title',
    type: 'movie' as const, // Explicitly cast to 'movie' literal type
    poster: movieData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(movieData.originalTitle || 'No Poster')}`,
    description: movieData.description || 'No description available.',
    background: movieData.posterUrl,
    // Do NOT include 'videos' array here as per Stremio's 'movie' type convention
    // and the request to list all episodes/qualities under the 'stream' endpoint.
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

  const { movieId } = parseStremioId(id); // movieId is the normalized title string without 'tt'

  if (!movieId) {
    logger.warn(`Invalid Stremio ID format for stream: ${id}`);
    return { streams: [] };
  }

  const allStreams: Stream[] = [];

  // Find all episode keys associated with this stremioMovieId
  // The pattern should match: episode:<stremioMovieId>:s<S>e<E>:<resolutionTag>:<hash>
  const episodeKeys = await redisClient.keys(`episode:${id}:*`); // Use the full 'id' (stremioMovieId) for consistency

  logger.debug(`Found ${episodeKeys.length} episode keys for movie ID ${id}.`);

  // Get the original show title from the main movie data for better stream titles
  let originalShowTitle = 'Unknown Title';
  const movieData = await hgetall(`movie:${id}`); // Fetch directly using the Stremio ID
  if (movieData && movieData.originalTitle) {
      originalShowTitle = movieData.originalTitle;
  }


  for (const episodeKey of episodeKeys) {
    const episodeData = await hgetall(episodeKey);
    if (Object.keys(episodeData).length > 0 && episodeData.magnet) {
      // Extract season, episode, and resolution from the episodeKey for stream title
      // Example key: episode:ttmovietitle:s1e1:720p:HASH
      const keyParts = episodeKey.split(':');
      // keyParts will be: [0: "episode", 1: "ttmovietitle", 2: "s1e1", 3: "720p", 4: "HASH"]
      const seasonEpisodePart = keyParts[2]; // e.g., s1e1
      const resolutionPart = keyParts[3]; // e.g., 720p

      const seasonMatch = seasonEpisodePart.match(/s(\d+)/i);
      const episodeMatch = seasonEpisodePart.match(/e(\d+)/i);

      const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : undefined;
      const episodeNum = episodeMatch ? parseInt(episodeMatch[1], 10) : undefined;

      const streamTitle = `${originalShowTitle}` +
                          (seasonNum ? ` S${seasonNum}` : '') +
                          (episodeNum ? ` E${episodeNum}` : '') +
                          ` ${resolutionPart ? `[${resolutionPart}]` : ''}` +
                          ` ${episodeData.size ? `(${episodeData.size})` : ''}` +
                          ` ${episodeData.name ? ` - ${episodeData.name}` : ''}`.trim();

      allStreams.push({
        name: config.ADDON_NAME, // Or a more specific source name
        title: streamTitle,
        url: episodeData.magnet,
        // Add P2P hint for magnet links as per Stremio guide
        behaviorHints: {
          p2p: true, // Crucial for torrents
          filename: `${originalShowTitle}` +
                    (seasonNum ? ` S${seasonNum}` : '') +
                    (episodeNum ? ` E${episodeNum}` : '') +
                    `.torrent` // Example filename for torrent client
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
