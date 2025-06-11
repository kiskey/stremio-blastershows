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
const YEAR_PATTERN = /\(?(\d{4})\)?/g; // Global flag added
// More comprehensive season/episode patterns, including ranges and "complete series" / "season pack"
const SEASON_EPISODE_PATTERN = /(?:S(\d+)(?:E(?:P)?(\d+)(?:-(\d+))?)?|Season\s*(\d+)(?:\s*Episode(?:s)?\s*(\d+)(?:-(\d+))?)?|s(\d+)(?:e(\d+))|complete series|season\s*pack|full\s*season)/ig; // Global flag added
const RESOLUTION_PATTERN = /(\d{3,4}p|4K)/ig; // Global flag to find all
const QUALITY_TAGS_PATTERN = /(?:HQ\s*HDRip|WEB-DL|HDRip|BluRay|HDTV|WEBRip|BDRip|DVDRip|AVC|x264|x265|HEVC|AAC|DD5\.1|AC3|DTS)/ig; // Combined common tags for stripping
// Updated Language pattern to correctly capture multiple languages and variations
const LANGUAGE_PATTERN = /(?:\[\s*(?:(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi)\s*(?:[+\s]\s*(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi))*)\s*\]|(?:tam|tel|kan|hin|eng|mal|kor|chi|por)\b)/ig; // Global flag added
const SIZE_PATTERN = /(\d+\.?\d*\s*[KMGT]?B)/ig; // Matches sizes like 1.2GB, 600MB, 42GB, 980MB - Global flag added
const SUBTITLE_PATTERN = /(ESub|Subtitles?)/ig; // Matches ESub or Subtitles - Global flag added

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
  // Ensures global replacement with space and uses new `matchAll` results
  const extractAndStrip = (pattern, mapFunc) => {
    const extractedSet = new Set();
    // Use `split` and `map` to remove all occurrences and build extracted array
    const parts = tempTitle.split(pattern);
    let newTempTitle = '';
    
    parts.forEach((part, index) => {
        if (index > 0 && pattern.lastMatch) { // If there was a match before this part
            const matchValue = pattern.lastMatch;
            const valuesToAdd = mapFunc([matchValue]);
            valuesToAdd.forEach(v => extractedSet.add(v));
        }
        newTempTitle += part;
    });
    tempTitle = newTempTitle; // Update tempTitle after stripping
    return Array.from(extractedSet);
  };
  
  // Reset lastIndex for global patterns before each use with matchAll
  const resetRegex = (regex) => {
      if (regex.global) regex.lastIndex = 0;
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

  // Define a generic stripper that applies a pattern and cleans the tempTitle
  const stripPattern = (pattern) => {
    resetRegex(pattern);
    tempTitle = tempTitle.replace(pattern, ' ');
  };

  // 3. Extract Resolutions
  resetRegex(RESOLUTION_PATTERN);
  metadata.resolutions = [...new Set([...tempTitle.matchAll(RESOLUTION_PATTERN)].map(m => m[1].trim()))];
  stripPattern(RESOLUTION_PATTERN);

  // 4. Extract Quality Tags (and other general metadata for stripping)
  resetRegex(QUALITY_TAGS_PATTERN);
  metadata.qualityTags = [...new Set([...tempTitle.matchAll(QUALITY_TAGS_PATTERN)].map(m => m[0].trim()))];
  stripPattern(QUALITY_TAGS_PATTERN);

  // 5. Extract Codecs (These are often part of quality tags but explicitly extracting)
  resetRegex(CODEC_PATTERN);
  metadata.codecs = [...new Set([...tempTitle.matchAll(CODEC_PATTERN)].map(m => m[1].trim()))];
  // No need to strip again if they are already covered by QUALITY_TAGS_PATTERN

  // 6. Extract Audio Codecs (Similar to codecs)
  resetRegex(AUDIO_CODEC_PATTERN);
  metadata.audioCodecs = [...new Set([...tempTitle.matchAll(AUDIO_CODEC_PATTERN)].map(m => m[1].trim()))];
  // No need to strip again if they are already covered by QUALITY_TAGS_PATTERN


  // 7. Extract Languages
  resetRegex(LANGUAGE_PATTERN);
  const rawLanguageMatches = [...tempTitle.matchAll(LANGUAGE_PATTERN)];
  const extractedLanguages = new Set();
  rawLanguageMatches.forEach(match => {
    // This regex matches "[[...]]" or "ddd" (like "tam")
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
  resetRegex(SIZE_PATTERN);
  metadata.sizes = [...new Set([...tempTitle.matchAll(SIZE_PATTERN)].map(m => m[1].trim()))];
  stripPattern(SIZE_PATTERN);

  // 9. Extract Subtitle info
  resetRegex(SUBTITLE_PATTERN);
  metadata.hasESub = SUBTITLE_PATTERN.test(tempTitle);
  stripPattern(SUBTITLE_PATTERN);

  // Final cleaning of the title candidate: remove extra spaces, special chars that might remain
  let finalCleanedTitle = tempTitle.replace(/[-_.,()[\]{}|]/g, ' ') // Replace common separators with spaces
                                      .replace(/\s+/g, ' ') // Reduce multiple spaces to single
                                      .trim(); // Trim leading/trailing spaces
  
  // Reconstruct the `title` field for Stremio display as "Base Title (YEAR) SXX"
  // This will be the `originalTitle` stored in Redis for the movie hash.
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

  // Ensure title is not empty or just year/season info
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
