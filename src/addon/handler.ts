import { CatalogResponse, MetaResponse, StreamResponse, DiscoverableItem, Stream } from 'stremio-addon-sdk';
import { hgetall, zrangebyscore } from '../redis';
import { config } from '../config';
import { parseStremioId } from '../utils/stremioIdParser';
import { normalizeTitle } from '../parser/title'; // Assuming normalizeTitle is exported

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
  console.log(`Received catalog request: type=${type}, id=${id}, genre=${genre}, skip=${skip}, search=${searchQuery}`);

  if (type !== 'series' || id !== 'tamil-web-series') {
    return { metas: [] }; // Return empty if catalog ID doesn't match
  }

  // Fetch all show keys from Redis (this might be inefficient for very large datasets)
  // A better approach would be to maintain a sorted set of all show IDs for pagination.
  // For now, let's assume we fetch all and paginate/filter in memory.
  // In a real-world scenario, you'd use ZRANGE or SCAN with patterns.
  const showKeys = await redisClient.keys('show:*'); // Assuming redisClient is imported from '../redis'
  let allShows: DiscoverableItem[] = [];

  for (const key of showKeys) {
    const showData = await hgetall(key);
    if (Object.keys(showData).length > 0) {
      const stremioId = showData.stremioId || `tt${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; // Generate if missing
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
    const normalizedSearchQuery = normalizeTitle(searchQuery); // Use the existing normalizeTitle
    allShows = allShows.filter(show =>
      normalizeTitle(show.name).includes(normalizedSearchQuery)
    );
  }

  // Simple in-memory pagination (for demonstration)
  // In a large-scale app, consider server-side pagination with Redis.
  const paginatedShows = allShows.slice(skip, skip + 100); // Limit to 100 items per page

  console.log(`Returning ${paginatedShows.length} items for catalog.`);
  return { metas: paginatedShows };
}

/**
 * Handles Stremio metadata requests for a specific series.
 * @param type The type of content (e.g., 'series').
 * @param id The Stremio ID of the series (e.g., 'tt12345').
 * @returns A Promise resolving to a MetaResponse.
 */
export async function getMeta(type: string, id: string): Promise<MetaResponse> {
  console.log(`Received meta request: type=${type}, id=${id}`);

  if (type !== 'series') {
    return { meta: null };
  }

  const { showId } = parseStremioId(id); // Parse the Stremio ID

  if (!showId) {
    console.warn(`Invalid Stremio ID format: ${id}`);
    return { meta: null };
  }

  // Fetch show details from Redis
  const showData = await hgetall(`show:${showId}`);

  if (Object.keys(showData).length === 0) {
    console.log(`Show with ID ${showId} not found in Redis.`);
    return { meta: null };
  }

  const seasonsKeyPattern = `season:${showId}:*`;
  // Need to get all season keys for this show.
  // This might involve scanning keys or maintaining a list of seasons for each show.
  // For simplicity, let's assume seasons are directly related to showId
  // and we can fetch them by pattern. (Requires a slight adjustment in Redis schema or usage)
  // Or, a better way is to store season numbers in the show hash.
  const seasonNumbersString = showData.seasons || ''; // Assuming 'seasons' field stores comma-separated season numbers
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
    type: 'series',
    poster: showData.posterUrl || `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(showData.originalTitle || 'No Poster')}`,
    description: showData.description || 'No description available.',
    // Cast, genres, releaseInfo can be added if extracted by the crawler
    background: showData.posterUrl, // Often the same as poster or a higher-res version
    // videos: [], // This will be populated by the streams for seasons/episodes
    videos: seasons.map(s => ({
      id: `${id}:${s.season}`, // Stremio expects video IDs for seasons to include season number
      title: s.title,
      season: s.season,
      released: new Date().toISOString(), // Placeholder, ideally from episode data
      // Populate episodes within each season if available
      // For now, Stremio client will request streams for specific season/episode combinations.
      // this is more for "episode group" not individual episodes.
      // Stremio will then request streams for specific episodes when the user clicks on a season.
      // We will only return streams when /stream endpoint is called for episode.
    }))
  };

  console.log('Returning meta:', meta.id);
  return { meta };
}

/**
 * Handles Stremio stream requests for a specific episode.
 * @param type The type of content (e.g., 'series').
 * @param id The Stremio ID of the episode (e.g., 'tt12345:1:2' for S1E2).
 * @returns A Promise resolving to a StreamResponse.
 */
export async function getStream(type: string, id: string): Promise<StreamResponse> {
  console.log(`Received stream request: type=${type}, id=${id}`);

  if (type !== 'series') {
    return { streams: [] };
  }

  const { showId, seasonNum, episodeNum } = parseStremioId(id);

  if (!showId || seasonNum === undefined || episodeNum === undefined) {
    console.warn(`Invalid Stremio ID format for stream: ${id}`);
    return { streams: [] };
  }

  // Construct the key for the episode data in Redis
  const episodeKey = `episode:season:${showId}:${seasonNum}:${episodeNum}`;
  const episodeData = await hgetall(episodeKey);

  if (Object.keys(episodeData).length === 0) {
    console.log(`No stream data found for ID: ${id} (episodeKey: ${episodeKey})`);
    return { streams: [] };
  }

  // Construct the stream object
  const stream: Stream = {
    name: episodeData.name || config.ADDON_NAME, // e.g., "TamilShows - 720p"
    title: episodeData.title || `S${seasonNum} E${episodeNum}`, // e.g., "Mercy For None | S01 | E01"
    url: episodeData.magnet || '', // The magnet URI
    // behaviorHints can be added if needed, e.g., to indicate direct play
  };

  // Only return the stream if a valid magnet URL exists
  if (stream.url) {
    console.log('Returning stream:', stream.title);
    return { streams: [stream] };
  } else {
    console.warn(`No magnet URL found for episode ID: ${id}`);
    return { streams: [] };
  }
}

/**
 * Handles Stremio search requests.
 * @param query The search query string.
 * @returns A Promise resolving to a CatalogResponse (list of metas).
 */
export async function search(query: string): Promise<CatalogResponse> {
  console.log(`Received search request for query: ${query}`);
  // Reuse the getCatalog logic with the search query
  // For a full implementation, this should trigger fuzzy matching against all show titles
  // stored in Redis.
  return getCatalog('series', 'tamil-web-series', undefined, 0, query);
}

// Re-import redisClient here, as it's used directly in getCatalog
import redisClient from '../redis';
