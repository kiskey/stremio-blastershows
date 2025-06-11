const { jaroWinkler } = require('js-levenshtein');
const { logger } = require('../utils/logger');

/**
 * @typedef {object} ParsedTitleMetadata
 * @property {string} title - The main, cleaned title of the series/movie.
 * @property {number} [year] - The release year.
 * @property {number} [season] - The season number (optional).
 * @property {number} [episodeStart] - The starting episode number (optional).
 * @property {number} [episodeEnd] - The ending episode number (optional, for multi-episode releases).
 * @property {string[]} languages - e.g., ["ta", "ml"]
 * @property {string[]} resolutions - e.g., ["720p", "1080p"]
 * @property {string[]} qualityTags - e.g., ["HQ HDRip", "WEB-DL"]
 * @property {string[]} codecs - e.g., ["x264", "x265", "HEVC"]
 * @property {string[]} audioCodecs - e.g., ["AAC", "DD5.1", "AC3"]
 * @property {string[]} sizes - e.g., ["1.2GB", "600MB"]
 * @property {boolean} [hasESub] - True if English subtitles are indicated.
 * @property {string} originalTitle - The original raw title string.
 */

// Regex patterns for extracting various metadata components
const YEAR_PATTERN = /\(?(\d{4})\)?/; // Matches (YYYY) or YYYY
const SEASON_EPISODE_PATTERN = /(?:S(\d+)(?:E(?:P)?(\d+)(?:-(\d+))?)?|Season\s*(\d+)(?:\s*Episode(?:s)?\s*(\d+)(?:-(\d+))?)?|s(\d+)(?:e(\d+))|complete series|season\s*pack)/i;
const RESOLUTION_PATTERN = /(\d{3,4}p|4K)/ig; // Global flag to find all
const QUALITY_TAGS_PATTERN = /(?:HQ\s*HDRip|WEB-DL|HDRip|BluRay|HDTV|WEBRip)/ig; // More specific quality tags
const CODEC_PATTERN = /(x264|x265|HEVC|AVC)/ig;
const AUDIO_CODEC_PATTERN = /(AAC|DD5\.1|AC3|DTS)/ig;
const LANGUAGE_PATTERN = /(?:\[\s*(?:(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por)\s*[+\s]*)+\s*\]|(?:tam|tel|kan|hin|eng|mal|kor|chi|por))/ig; // Matches languages in brackets or short codes
const SIZE_PATTERN = /(\d+\.?\d*\s*[KMGT]?B)/ig; // Matches sizes like 1.2GB, 600MB
const SUBTITLE_PATTERN = /(ESub|Subtitles?)/i;

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
};

/**
 * Normalizes a string for fuzzy matching by removing special characters,
 * converting to lowercase, replacing synonyms, and trimming.
 * @param {string} text The input string to normalize.
 * @returns {string} The normalized string.
 */
function normalizeTitle(text) {
  if (!text) return '';
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[^a-z0-9\s]/g, ''); // Remove special characters
  normalized = normalized.replace(/\bseason\b/g, 's');
  normalized = normalized.replace(/\bepisode\b/g, 'ep');
  normalized = normalized.replace(/\bpart\b/g, 'p');
  normalized = normalized.replace(/\bvol\b/g, 'v');
  normalized = normalized.replace(/s\b/g, ''); // Simple plural removal
  normalized = normalized.replace(/\s+/g, ' ').trim();
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

  let cleanTitleCandidate = titleString; // Start with full title

  // 1. Extract Year
  const yearMatch = titleString.match(YEAR_PATTERN);
  if (yearMatch) {
    metadata.year = parseInt(yearMatch[1], 10);
    // Remove year pattern from candidate string
    cleanTitleCandidate = cleanTitleCandidate.replace(yearMatch[0], '');
  }

  // 2. Extract Season and Episode
  const seMatch = titleString.match(SEASON_EPISODE_PATTERN);
  if (seMatch) {
    // Handling multiple capture groups for various formats
    if (seMatch[1]) metadata.season = parseInt(seMatch[1], 10); // S<digits>
    else if (seMatch[4]) metadata.season = parseInt(seMatch[4], 10); // Season <digits>
    else if (seMatch[7]) metadata.season = parseInt(seMatch[7], 10); // s<digits>

    if (seMatch[2]) metadata.episodeStart = parseInt(seMatch[2], 10); // EP<digits>
    else if (seMatch[5]) metadata.episodeStart = parseInt(seMatch[5], 10); // Episode <digits>
    else if (seMatch[8]) metadata.episodeStart = parseInt(seMatch[8], 10); // e<digits>

    if (seMatch[3]) metadata.episodeEnd = parseInt(seMatch[3], 10); // -(digits) for range
    else if (seMatch[6]) metadata.episodeEnd = parseInt(seMatch[6], 10); // -(digits) for range

    if (seMatch[0].toLowerCase().includes('complete series') || seMatch[0].toLowerCase().includes('season pack')) {
      // For season packs or complete series, assume first episode of season 1, end episode is undefined
      if (!metadata.season) metadata.season = 1;
      if (!metadata.episodeStart) metadata.episodeStart = 1;
    }

    if (metadata.episodeStart && !metadata.episodeEnd) {
      metadata.episodeEnd = metadata.episodeStart; // Single episode
    }
    
    // Remove season/episode pattern from candidate string
    cleanTitleCandidate = cleanTitleCandidate.replace(seMatch[0], '');
  }

  // 3. Extract Resolutions
  const resolutionsMatches = [...titleString.matchAll(RESOLUTION_PATTERN)];
  metadata.resolutions = Array.from(new Set(resolutionsMatches.map(m => m[1])));
  resolutionsMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 4. Extract Quality Tags
  const qualityTagsMatches = [...titleString.matchAll(QUALITY_TAGS_PATTERN)];
  metadata.qualityTags = Array.from(new Set(qualityTagsMatches.map(m => m[0].trim())));
  qualityTagsMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 5. Extract Codecs
  const codecMatches = [...titleString.matchAll(CODEC_PATTERN)];
  metadata.codecs = Array.from(new Set(codecMatches.map(m => m[1].trim())));
  codecMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 6. Extract Audio Codecs
  const audioCodecMatches = [...titleString.matchAll(AUDIO_CODEC_PATTERN)];
  metadata.audioCodecs = Array.from(new Set(audioCodecMatches.map(m => m[1].trim())));
  audioCodecMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 7. Extract Languages
  const languageMatches = [...titleString.matchAll(LANGUAGE_PATTERN)];
  const extractedLanguages = [];
  languageMatches.forEach(match => {
    // Split by '+' if found, otherwise just use the matched string
    const parts = match[0].replace(/[\[\]]/g, '').split(/[+\s]/).filter(Boolean);
    parts.forEach(p => {
        const mappedLang = LANGUAGE_MAP[p.toLowerCase()];
        if (mappedLang && !extractedLanguages.includes(mappedLang)) {
            extractedLanguages.push(mappedLang);
        }
    });
  });
  metadata.languages = extractedLanguages;
  languageMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 8. Extract Sizes
  const sizeMatches = [...titleString.matchAll(SIZE_PATTERN)];
  metadata.sizes = Array.from(new Set(sizeMatches.map(m => m[1].trim())));
  sizeMatches.forEach(match => cleanTitleCandidate = cleanTitleCandidate.replace(match[0], ''));


  // 9. Extract Subtitle info
  metadata.hasESub = SUBTITLE_PATTERN.test(titleString);
  if (metadata.hasESub) {
      cleanTitleCandidate = cleanTitleCandidate.replace(SUBTITLE_PATTERN, '');
  }

  // Final cleaning of the title candidate
  metadata.title = cleanTitleCandidate.replace(/[-_.,()[\]{}]+/g, ' ') // Replace common separators with spaces
                                      .replace(/\s+/g, ' ') // Reduce multiple spaces to single
                                      .trim(); // Trim leading/trailing spaces
  
  // If no year was explicitly found, try to infer it from the original title for display purposes
  // This is a fallback and might not be accurate if the year is not clearly marked.
  if (!metadata.year) {
      const fallbackYearMatch = titleString.match(YEAR_PATTERN);
      if (fallbackYearMatch) {
          metadata.year = parseInt(fallbackYearMatch[1], 10);
      }
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
