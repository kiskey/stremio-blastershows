const { jaroWinkler } = require('js-levenshtein'); // Use require for CommonJS module
const { logger } = require('../utils/logger'); // Import the centralized logger

/**
 * @typedef {object} ParsedTitleMetadata
 * @property {string} title - The main title of the series/movie.
 * @property {number} [season] - The season number (optional).
 * @property {number} [episodeStart] - The starting episode number (optional).
 * @property {number} [episodeEnd] - The ending episode number (optional, for multi-episode releases).
 * @property {string[]} languages - e.g., ["ta", "ml"]
 * @property {string} [resolution] - e.g., "720p", "1080p"
 * @property {string[]} qualityTags - e.g., ["x264", "DD5.1"]
 */

/**
 * Regular expression for pattern recognition in titles.
 * This regex is designed to extract title, season, episodes, resolution, and language tags.
 * It's based on the provided regex in the requirements.
 *
 * Groups:
 * - title: The main title of the series/movie.
 * - season: The season number (optional).
 * - episodeStart: The starting episode number (optional).
 * - episodeEnd: The ending episode number (optional, for multi-episode releases).
 * - res: The resolution (e.g., 720p, 1080p).
 * - lang: Language tags (e.g., tam, mal, hin, eng, kor, optionally with + additional tags).
 */
const TITLE_PATTERN = /(?<title>.+?)\s*(?:[[(](?:S(?<season>\d+)))?\s*(?:E(?:P)?(?<episodeStart>\d+)(?:-(?<episodeEnd>\d+))?)?\s*.*?\[(?<res>\d{3,4}p).*?(?<lang>(?:tam|mal|hin|eng|kor)(?:\s?[+]\\s?[a-z]{3})*)\]/i;

/**
 * Maps common language codes to ISO 639-1 two-letter codes.
 * @type {Object.<string, string>}
 */
const LANGUAGE_MAP = {
  'tam': 'ta',
  'mal': 'ml',
  'hin': 'hi',
  'eng': 'en',
  'kor': 'ko',
  'tel': 'te',
  // Add more as needed
};

/**
 * Normalizes a string for fuzzy matching by:
 * - Removing special characters.
 * - Converting to lowercase.
 * - Replacing common synonyms.
 * - (Optional) Stemming using a simple approach or a library if more robust stemming is needed.
 * @param {string} text The input string to normalize.
 * @returns {string} The normalized string.
 */
function normalizeTitle(text) {
  if (!text) return '';
  let normalized = text.toLowerCase();

  // Remove special characters, keeping alphanumeric and spaces
  normalized = normalized.replace(/[^a-z0-9\s]/g, '');

  // Replace synonyms
  normalized = normalized.replace(/\bseason\b/g, 's');
  normalized = normalized.replace(/\bepisode\b/g, 'ep');
  normalized = normalized.replace(/\bpart\b/g, 'p'); // Example
  normalized = normalized.replace(/\bvol\b/g, 'v'); // Example

  // Simple stemming (could be improved with a proper stemming algorithm if needed)
  normalized = normalized.replace(/s\b/g, ''); // Removes 's' at the end for pluralization

  // Trim multiple spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Parses the title string and extracts relevant metadata.
 * @param {string} titleString The raw title string from the source.
 * @returns {ParsedTitleMetadata} ParsedTitleMetadata object.
 */
function parseTitle(titleString) {
  const match = titleString.match(TITLE_PATTERN);
  /** @type {ParsedTitleMetadata} */
  const metadata = {
    title: titleString, // Default to original title
    languages: [],
    qualityTags: []
  };

  if (match && match.groups) {
    const { title, season, episodeStart, episodeEnd, res, lang } = match.groups;

    // Title
    if (title) {
      metadata.title = title.trim();
    }

    // Season
    if (season) {
      metadata.season = parseInt(season, 10);
    }

    // Episodes
    if (episodeStart) {
      metadata.episodeStart = parseInt(episodeStart, 10);
      if (episodeEnd) {
        metadata.episodeEnd = parseInt(episodeEnd, 10);
      } else {
        metadata.episodeEnd = metadata.episodeStart; // Single episode
      }
    }

    // Resolution
    if (res) {
      metadata.resolution = res;
    }

    // Languages
    if (lang) {
      // Split by '+' and then map to ISO 639-1 codes
      metadata.languages = lang.split(/[+\s]/)
        .map(l => LANGUAGE_MAP[l.toLowerCase()] || l.toLowerCase())
        .filter(Boolean); // Filter out empty strings
    }

    // Quality tags (This part is more heuristic and less regex-driven)
    const remainingText = titleString.replace(match[0], '').toLowerCase();
    if (remainingText.includes('x264')) metadata.qualityTags.push('x264');
    if (remainingText.includes('x265')) metadata.qualityTags.push('x265');
    if (remainingText.includes('hevc')) metadata.qualityTags.push('hevc');
    if (remainingText.includes('dd5.1')) metadata.qualityTags.push('DD5.1');
    if (remainingText.includes('ac3')) metadata.qualityTags.push('AC3');
    if (remainingText.includes('hdr')) metadata.qualityTags.push('HDR');
    if (remainingText.includes('web-dl')) metadata.qualityTags.push('WEB-DL');
    if (remainingText.includes('hdrip')) metadata.qualityTags.push('HDRip');
  }

  return metadata;
}

/**
 * Performs fuzzy matching between two titles using Jaro-Winkler similarity.
 * @param {string} title1 The first title string.
 * @param {string} title2 The second title string.
 * @param {number} [threshold=0.85] The similarity threshold (0.0 to 1.0).
 * @returns {boolean} True if the similarity is above the threshold, false otherwise.
 */
function fuzzyMatch(title1, title2, threshold = 0.85) {
  const normalized1 = normalizeTitle(title1);
  const normalized2 = normalizeTitle(title2);

  if (!normalized1 || !normalized2) return false;

  // jaroWinkler(a, b) returns the distance (0 for identical, 1 for completely different).
  // We need similarity, so 1 - distance.
  const similarity = 1 - jaroWinkler(normalized1, normalized2);

  logger.debug(`Fuzzy matching "${title1}" vs "${title2}": Normalized "${normalized1}" vs "${normalized2}"`);
  logger.debug(`Similarity: ${similarity.toFixed(4)} (Threshold: ${threshold})`);

  return similarity >= threshold;
}

module.exports = {
  normalizeTitle,
  parseTitle,
  fuzzyMatch
};
