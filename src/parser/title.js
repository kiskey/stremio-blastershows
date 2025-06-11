// Correctly import the jaro-winkler function
const jaroWinkler = require('jaro-winkler');
const { logger } = require('../utils/logger');

/**
 * @typedef {object} ParsedTitleMetadata
 * @property {string} title - The main, cleaned title of the series/movie, reconstructed with year and season.
 * @property {number} [year] - The release year.
 * @property {number} [season] - The season number (optional).
 * @property {number} [episodeStart] - The starting episode number (optional).
 * @property {number} [episodeEnd] - The ending episode number (optional, for multi-episode releases).
 * @property {string[]} languages - e.g., ["ta", "ml"]
 * @property {string[]} resolutions - e.g., ["720p", "1080p", "4K"]
 * @property {string[]} qualityTags - e.g., ["HQ HDRip", "WEB-DL"]
 * @property {string[]} codecs - e.g., ["x264", "x265", "HEVC"]
 * @property {string[]} audioCodecs - e.g., ["AAC", "DD5.1", "AC3", "DTS"]
 * @property {string[]} sizes - e.g., ["1.2GB", "600MB"]
 * @property {boolean} [hasESub] - True if English subtitles are indicated.
 * @property {string} originalTitle - The original raw title string.
 */

// Regex patterns for extracting various metadata components
const YEAR_PATTERN = /\(?(\d{4})\)?/g; // Global flag
const SEASON_EPISODE_PATTERN = /(?:S(\d+)(?:E(?:P)?(\d+)(?:-(\d+))?)?|Season\s*(\d+)(?:\s*Episode(?:s)?\s*(\d+)(?:-(\d+))?)?|s(\d+)(?:e(\d+))|complete series|season\s*pack|full\s*season)/ig; // Global flag
const RESOLUTION_PATTERN = /(\d{3,4}p|4K)/ig; // Global flag
const QUALITY_TAGS_PATTERN = /(?:HQ\s*HDRip|WEB-DL|HDRip|BluRay|HDTV|WEBRip|BDRip|DVDRip|AVC)/ig; // Global flag
const CODEC_PATTERN = /(x264|x265|HEVC)/ig; // Global flag
const AUDIO_CODEC_PATTERN = /(AAC|DD5\.1|AC3|DTS)/ig; // Global flag
const LANGUAGE_PATTERN = /(?:\[\s*(?:(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi)\s*(?:[+\s]\s*(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi))*)\s*\]|(?:tam|tel|kan|hin|eng|mal|kor|chi|por)\b)/ig; // Global flag
const SIZE_PATTERN = /(\d+\.?\d*\s*[KMGT]?B)/ig; // Global flag
const SUBTITLE_PATTERN = /(ESub|Subtitles?)/ig; // Global flag

/**
 * Maps common language codes/names to ISO 639-1 two-letter codes.
 * @type {Object.<string, string>}
 */
const LANGUAGE_MAP = {
  'tamil': 'ta', 'tam': 'ta',
  'telugu': 'te', 'tel': 'te',
  'kannada': 'kn', 'kan': 'kn',
  'hindi': 'hi', 'hin': 'hi',
  'eng': 'en', 'english': 'en',
  'malayalam': 'ml', 'mal': 'ml',
  'korean': 'ko', 'kor': 'ko',
  'chinese': 'zh', 'chi': 'zh',
  'portuguese': 'pt', 'por': 'pt',
  'multi': 'multi' // For multi-language packs
};

/**
 * Normalizes a string for fuzzy matching by removing special characters,
 * converting to lowercase, replacing synonyms, and trimming.
 * This also removes all non-alphanumeric characters except spaces.
 * @param {string} text The input string to normalize.
 * @returns {string} The normalized string.
 */
function normalizeTitle(text) {
  if (!text) return '';
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[^a-z0-9\s]/g, ''); // Remove all special characters for cleaner matching
  normalized = normalized.replace(/\bseason\b/g, 's');
  normalized = normalized.replace(/\bepisode\b/g, 'ep');
  normalized = normalized.replace(/\bpart\b/g, 'p');
  normalized = normalized.replace(/\bvol\b/g, 'v');
  normalized = normalized.replace(/s\b/g, ''); // Simple plural removal (e.g., 'series' -> 'serie')
  normalized = normalized.replace(/\s+/g, ' ').trim(); // Reduce multiple spaces to single
  return normalized;
}

/**
 * Parses the title string and extracts relevant metadata, yielding a clean title.
 * @param {string} titleString The raw title string from the source.
 * @returns {ParsedTitleMetadata} ParsedTitleMetadata object.
 */
function parseTitle(titleString) {
  /** @type {ParsedTitleMetadata} */
  const metadata = {
    title: titleString, // Default to original title
    originalTitle: titleString,
    languages: [],
    resolutions: [],
    qualityTags: [],
    codecs: [],
    audioCodecs: [],
    sizes: [],
    hasESub: false,
  };

  let tempTitle = titleString; // Use a temporary string to strip components

  // Helper to ensure regex lastIndex is reset for global patterns
  const resetRegex = (regex) => {
      if (regex.global) regex.lastIndex = 0;
  };

  // Helper to extract matches and remove them from the temporary title
  const extractAndStrip = (pattern, mapFunc) => {
    resetRegex(pattern); // Reset before using
    const extractedSet = new Set();
    const matches = [...tempTitle.matchAll(pattern)];
    matches.forEach(match => {
        const value = mapFunc(match);
        if (value) {
            extractedSet.add(value);
        }
    });
    // Replace all matched patterns with a space to ensure they are removed from tempTitle
    tempTitle = tempTitle.replace(pattern, ' ');
    return Array.from(extractedSet);
  };
  
  // 1. Extract and strip Year
  resetRegex(YEAR_PATTERN);
  const yearMatch = [...tempTitle.matchAll(YEAR_PATTERN)];
  if (yearMatch.length > 0) {
    metadata.year = parseInt(yearMatch[0][1], 10); // Take the first year found
    tempTitle = tempTitle.replace(YEAR_PATTERN, ' ');
  }

  // 2. Extract and strip Season and Episode
  resetRegex(SEASON_EPISODE_PATTERN);
  const seMatch = [...tempTitle.matchAll(SEASON_EPISODE_PATTERN)];
  if (seMatch.length > 0 && seMatch[0].groups) {
    const groups = seMatch[0].groups;
    if (groups.season) metadata.season = parseInt(groups.season, 10);
    else if (groups[4]) metadata.season = parseInt(groups[4], 10); // Season <digits>
    else if (groups[7]) metadata.season = parseInt(groups[7], 10); // s<digits>

    if (groups.episodeStart) metadata.episodeStart = parseInt(groups.episodeStart, 10);
    else if (groups[5]) metadata.episodeStart = parseInt(groups[5], 10); // Episode <digits>
    else if (groups[8]) metadata.episodeStart = parseInt(groups[8], 10); // e<digits>

    if (groups.episodeEnd) metadata.episodeEnd = parseInt(groups.episodeEnd, 10);
    else if (groups[6]) metadata.episodeEnd = parseInt(groups[6], 10); // -(digits) for range

    if (seMatch[0][0].toLowerCase().includes('complete series') || seMatch[0][0].toLowerCase().includes('season pack') || seMatch[0][0].toLowerCase().includes('full season')) {
      if (!metadata.season) metadata.season = 1; // Default to Season 1 for season packs
      if (!metadata.episodeStart) metadata.episodeStart = 1; // Default to Episode 1 for season packs
    }

    if (metadata.episodeStart && !metadata.episodeEnd) {
      metadata.episodeEnd = metadata.episodeStart; // Single episode
    }
    tempTitle = tempTitle.replace(SEASON_EPISODE_PATTERN, ' ');
  }

  // Define a generic stripper for patterns that don't need extraction to metadata fields
  const stripPattern = (pattern) => {
    resetRegex(pattern);
    tempTitle = tempTitle.replace(pattern, ' ');
  };

  // 3. Extract Resolutions
  metadata.resolutions = extractAndStrip(RESOLUTION_PATTERN, m => m[1].trim());

  // 4. Extract Quality Tags
  metadata.qualityTags = extractAndStrip(QUALITY_TAGS_PATTERN, m => m[0].trim());

  // 5. Extract Codecs (These are often part of quality tags but explicitly extracting)
  metadata.codecs = extractAndStrip(CODEC_PATTERN, m => m[1].trim());

  // 6. Extract Audio Codecs (Similar to codecs)
  metadata.audioCodecs = extractAndStrip(AUDIO_CODEC_PATTERN, m => m[1].trim());

  // 7. Extract Languages
  resetRegex(LANGUAGE_PATTERN);
  const rawLanguageMatches = [...tempTitle.matchAll(LANGUAGE_PATTERN)];
  const extractedLanguages = new Set();
  rawLanguageMatches.forEach(match => {
    const matchedText = match[0];
    const cleanParts = matchedText.replace(/[\[\]]/g, '').split(/[+\s]/).filter(Boolean);
    cleanParts.forEach(part => {
        const mappedLang = LANGUAGE_MAP[part.toLowerCase()];
        if (mappedLang) {
            extractedLanguages.add(mappedLang);
        }
    });
  });
  metadata.languages = Array.from(extractedLanguages);
  stripPattern(LANGUAGE_PATTERN);


  // 8. Extract Sizes
  metadata.sizes = extractAndStrip(SIZE_PATTERN, m => m[1].trim());

  // 9. Extract Subtitle info
  resetRegex(SUBTITLE_PATTERN);
  metadata.hasESub = SUBTITLE_PATTERN.test(tempTitle);
  stripPattern(SUBTITLE_PATTERN);

  // Final cleaning of the title candidate: remove extra spaces, special chars that might remain
  let finalCleanedTitle = tempTitle.replace(/[-_.,()[\]{}|]/g, ' ') // Replace common separators with spaces
                                      .replace(/\s+/g, ' ') // Reduce multiple spaces to single
                                      .trim(); // Trim leading/trailing spaces
  
  // Reconstruct the `title` field for Stremio display as "Base Title (YEAR) SXX"
  let reconstructedTitleParts = [finalCleanedTitle];
  if (metadata.year) {
      reconstructedTitleParts.push(`(${metadata.year})`);
  }
  if (metadata.season) {
      reconstructedTitleParts.push(`S${metadata.season.toString().padStart(2, '0')}`);
  }
  // This part is for the display title, not for the ID.
  if (metadata.episodeStart && metadata.episodeEnd && (metadata.episodeStart !== metadata.episodeEnd)) {
      reconstructedTitleParts.push(`EP(${metadata.episodeStart.toString().padStart(2, '0')}-${metadata.episodeEnd.toString().padStart(2, '0')})`);
  } else if (metadata.episodeStart) {
      reconstructedTitleParts.push(`EP${metadata.episodeStart.toString().padStart(2, '0')}`);
  }

  // If after all stripping and reconstruction, the title is empty or just year/season/episode info,
  // revert to a simpler title by stripping only common meta tags, or use the originalTitle as a fallback.
  if (!finalCleanedTitle || finalCleanedTitle.match(/^(\(\d{4}\)|\s*S\d{2}|\s*EP\d{2}(-\d{2})?\s*)+$/)) {
      // Fallback: Strip only common bracketed/parenthesized meta tags and clean spaces from original title
      metadata.title = titleString.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim() || titleString;
  } else {
      metadata.title = reconstructedTitleParts.join(' ').replace(/\s+/g, ' ').trim();
  }


  logger.debug('Parsed Title Metadata:', JSON.stringify(metadata, null, 2));
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

  // Use the jaroWinkler function directly, which returns a similarity score (0 to 1)
  const similarity = jaroWinkler(normalized1, normalized2); 

  logger.debug(`Fuzzy matching "${title1}" vs "${title2}": Normalized "${normalized1}" vs "${normalized2}"`);
  logger.debug(`Jaro-Winkler Similarity: ${similarity.toFixed(4)} (Threshold: ${threshold})`);

  return similarity >= threshold;
}

module.exports = {
  normalizeTitle,
  parseTitle,
  fuzzyMatch
};
