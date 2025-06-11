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
const YEAR_PATTERN = /\(?(\d{4})\)?/; // Matches (YYYY) or Wiesbaden
// More comprehensive season/episode patterns, including ranges and "complete series" / "season pack"
const SEASON_EPISODE_PATTERN = /(?:S(\d+)(?:E(?:P)?(\d+)(?:-(\d+))?)?|Season\s*(\d+)(?:\s*Episode(?:s)?\s*(\d+)(?:-(\d+))?)?|s(\d+)(?:e(\d+))|complete series|season\s*pack|full\s*season)/i;
const RESOLUTION_PATTERN = /(\d{3,4}p|4K)/ig; // Global flag to find all
const QUALITY_TAGS_PATTERN = /(?:HQ\s*HDRip|WEB-DL|HDRip|BluRay|HDTV|WEBRip|BDRip|DVDRip|AVC)/ig; // More specific quality tags
const CODEC_PATTERN = /(x264|x265|HEVC)/ig; // x264, x265, HEVC
const AUDIO_CODEC_PATTERN = /(AAC|DD5\.1|AC3|DTS)/ig; // AAC, DD5.1, AC3, DTS
// Updated Language pattern to correctly capture multiple languages and variations
const LANGUAGE_PATTERN = /(?:\[\s*(?:(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi)\s*(?:[+\s]\s*(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi))*)\s*\]|(?:tam|tel|kan|hin|eng|mal|kor|chi|por)\b)/ig;
const SIZE_PATTERN = /(\d+\.?\d*\s*[KMGT]?B)/ig; // Matches sizes like 1.2GB, 600MB, 42GB, 980MB
const SUBTITLE_PATTERN = /(ESub|Subtitles?)/i; // Matches ESub or Subtitles

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

  // Helper to extract matches and remove them from the temporary title
  const extractAndStrip = (pattern, mapFunc, unique = true) => {
    const matches = [...tempTitle.matchAll(pattern)];
    const extracted = unique ? new Set() : [];
    matches.forEach(match => {
        const value = mapFunc(match);
        if (value) {
            if (unique) extracted.add(value);
            else extracted.push(value);
        }
        // Replace the matched part in tempTitle. Use a global replace for all occurrences.
        tempTitle = tempTitle.replace(match[0], ' '); // Replace with space to avoid merging words
    });
    return unique ? Array.from(extracted) : extracted;
  };
  
  // 1. Extract and strip Year
  const yearMatch = tempTitle.match(YEAR_PATTERN);
  if (yearMatch) {
    metadata.year = parseInt(yearMatch[1], 10);
    tempTitle = tempTitle.replace(yearMatch[0], ' ');
  }

  // 2. Extract and strip Season and Episode
  const seMatch = tempTitle.match(SEASON_EPISODE_PATTERN);
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

    if (seMatch[0].toLowerCase().includes('complete series') || seMatch[0].toLowerCase().includes('season pack') || seMatch[0].toLowerCase().includes('full season')) {
      if (!metadata.season) metadata.season = 1; // Default to Season 1 for season packs
      if (!metadata.episodeStart) metadata.episodeStart = 1; // Default to Episode 1 for season packs
    }

    if (metadata.episodeStart && !metadata.episodeEnd) {
      metadata.episodeEnd = metadata.episodeStart; // Single episode
    }
    
    tempTitle = tempTitle.replace(seMatch[0], ' ');
  }

  // 3. Extract Resolutions
  metadata.resolutions = extractAndStrip(RESOLUTION_PATTERN, m => m[1].trim());

  // 4. Extract Quality Tags
  metadata.qualityTags = extractAndStrip(QUALITY_TAGS_PATTERN, m => m[0].trim());

  // 5. Extract Codecs
  metadata.codecs = extractAndStrip(CODEC_PATTERN, m => m[1].trim());

  // 6. Extract Audio Codecs
  metadata.audioCodecs = extractAndStrip(AUDIO_CODEC_PATTERN, m => m[1].trim());

  // 7. Extract Languages
  const tempExtractedLanguages = extractAndStrip(LANGUAGE_PATTERN, m => {
    // Split by '+' or space, then map to canonical language codes
    const parts = m[0].replace(/[\[\]]/g, '').split(/[+\s]/).filter(Boolean);
    return parts.map(p => LANGUAGE_MAP[p.toLowerCase()] || p.toLowerCase());
  }, false); // Not unique initially for extraction, then flatten and unique
  metadata.languages = Array.from(new Set(tempExtractedLanguages.flat()));


  // 8. Extract Sizes
  metadata.sizes = extractAndStrip(SIZE_PATTERN, m => m[1].trim());

  // 9. Extract Subtitle info
  metadata.hasESub = SUBTITLE_PATTERN.test(tempTitle);
  if (metadata.hasESub) {
      tempTitle = tempTitle.replace(SUBTITLE_PATTERN, ' ');
  }

  // Final cleaning of the title candidate: remove extra spaces, special chars that might remain
  let finalCleanedTitle = tempTitle.replace(/[-_.,()[\]{}|]+/g, ' ') // Replace common separators with spaces
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
  // If it's a specific episode range and not a season pack, append episode range
  // This part is for the display title, not for the ID.
  if (metadata.episodeStart && metadata.episodeEnd && (metadata.episodeStart !== metadata.episodeEnd)) {
      reconstructedTitleParts.push(`EP(${metadata.episodeStart.toString().padStart(2, '0')}-${metadata.episodeEnd.toString().padStart(2, '0')})`);
  } else if (metadata.episodeStart) {
      reconstructedTitleParts.push(`EP${metadata.episodeStart.toString().padStart(2, '0')}`);
  }

  metadata.title = reconstructedTitleParts.join(' ').replace(/\s+/g, ' ').trim(); // Final clean-up

  // If after all stripping and reconstruction, the title is empty or just year/season/episode info,
  // revert to a simpler title by stripping only common meta tags, or use the originalTitle as a fallback.
  if (!metadata.title || metadata.title.match(/^(\(\d{4}\)|\s*S\d{2}|\s*EP\d{2}(-\d{2})?\s*)+$/)) {
      // Fallback: Strip only common bracketed/parenthesized meta tags and clean spaces
      metadata.title = titleString.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim() || titleString;
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
