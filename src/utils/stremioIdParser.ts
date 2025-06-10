/**
 * Parses a Stremio ID to extract relevant components.
 * For "movie" type, the ID will primarily be `tt<normalizedTitle>`.
 *
 * @param stremioId The Stremio ID string (e.g., "ttnormalizedtitle").
 * @returns An object containing the parsed components.
 */
export function parseStremioId(stremioId: string): { movieId: string | null } {
    const parts = stremioId.split(':');
    let movieId: string | null = null;

    if (parts.length > 0 && parts[0].startsWith('tt')) {
        movieId = parts[0].substring(2); // Remove 'tt' prefix to get the normalized title
    }

    return { movieId };
}
