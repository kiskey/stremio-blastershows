/**
 * Parses a Stremio ID into its component parts: showId, seasonNum, and episodeNum.
 * Stremio IDs for series typically follow the format: {showId}:{seasonNum}:{episodeNum}
 * or just {showId} for meta requests.
 *
 * @param stremioId The Stremio ID string (e.g., 'tt12345:1:2', 'tt12345:1', or 'tt12345').
 * @returns An object containing showId, seasonNum, and episodeNum.
 * `seasonNum` and `episodeNum` will be `undefined` if not present in the ID.
 */
export function parseStremioId(stremioId: string): { showId?: string; seasonNum?: number; episodeNum?: number } {
  if (!stremioId) {
    return {};
  }

  const parts = stremioId.split(':');
  const showId = parts[0];
  const seasonNum = parts.length > 1 ? parseInt(parts[1], 10) : undefined;
  const episodeNum = parts.length > 2 ? parseInt(parts[2], 10) : undefined;

  // Basic validation to ensure showId is not empty and season/episode are valid numbers if present
  if (!showId) {
    return {};
  }

  if (seasonNum !== undefined && isNaN(seasonNum)) {
    return {};
  }

  if (episodeNum !== undefined && isNaN(episodeNum)) {
    return {};
  }

  return { showId, seasonNum, episodeNum };
}
