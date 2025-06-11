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
const RESOLUTION_PATTERN = /(\d{3,4}p|4K)/ig; // Global flag to find all
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
 * Normalizes a string for fuzzy matching and ID generation.
 * Removes all non-alphanumeric characters (except spaces for initial cleaning)
 * and then replaces spaces with hyphens.
 * @param {string} text The input string to normalize.
 * @returns {string} The normalized string.
 */
function normalizeTitle(text) {
  if (!text) return '';
  let normalized = text.toLowerCase();

  // Remove specific common terms that shouldn't be part of the base title for ID generation
  normalized = normalized.replace(/\b(complete series|season pack|full season|ep\d+(-\d+)?)\b/g, '');

  // Remove all non-alphanumeric characters (except spaces temporarily)
  normalized = normalized.replace(/[^a-z0-9\s]/g, ''); 

  // Replace synonyms for seasons/episodes if they remain
  normalized = normalized.replace(/\bseason\b/g, 's');
  normalized = normalized.replace(/\bepisode\b/g, 'ep');
  normalized = normalized.replace(/\bpart\b/g, 'p');
  normalized = normalized.replace(/\bvol\b/g, 'v');
  normalized = normalized.replace(/s\b/g, ''); // Simple plural removal

  // Reduce multiple spaces to single, then replace spaces with hyphens for ID readiness
  normalized = normalized.replace(/\s+/g, '-').trim();

  // Remove any leading/trailing hyphens that might result from replacements
  normalized = normalized.replace(/^-+|-+$/g, '');

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
    // Prioritize non-undefined capture groups from the pattern
    metadata.season = parseInt(groups[1] || groups[4] || groups[7] || '1', 10);
    metadata.episodeStart = parseInt(groups[2] || groups[5] || groups[8] || '1', 10);
    metadata.episodeEnd = parseInt(groups[3] || groups[6] || (metadata.episodeStart ? metadata.episodeStart.toString() : '1'), 10);

    // Special handling for "complete series" / "season pack"
    if (seMatch[0][0].toLowerCase().includes('complete series') || seMatch[0][0].toLowerCase().includes('season pack') || seMatch[0][0].toLowerCase().includes('full season')) {
      if (!metadata.season) metadata.season = 1;
      if (!metadata.episodeStart) metadata.episodeStart = 1;
      // episodeEnd might remain undefined, implying all episodes of the season or series
    }
    
    tempTitle = tempTitle.replace(SEASON_EPISODE_PATTERN, ' ');
  } else {
    // If no season/episode pattern found, default to S1E1 for consistency
    metadata.season = 1;
    metadata.episodeStart = 1;
    metadata.episodeEnd = 1;
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
        } else if (part) { // Add original part if no mapping, but is not empty
            extractedLanguages.add(part.toLowerCase());
        }
    });
  });
  metadata.languages = Array.from(extractedLanguages);
  tempTitle = tempTitle.replace(LANGUAGE_PATTERN, ' '); // Strip languages

  // 8. Extract Sizes
  metadata.sizes = extractAndStrip(SIZE_PATTERN, m => m[1].trim());

  // 9. Extract Subtitle info
  resetRegex(SUBTITLE_PATTERN);
  metadata.hasESub = SUBTITLE_PATTERN.test(tempTitle);
  tempTitle = tempTitle.replace(SUBTITLE_PATTERN, ' '); // Strip subtitles


  // Final cleaning of the base title: remove extra spaces and any remaining stray special chars
  let finalCleanedBaseTitle = tempTitle.replace(/[-_.,()[\]{}|]/g, ' ') // Replace common separators with spaces
                                      .replace(/\s+/g, ' ') // Reduce multiple spaces to single
                                      .trim(); // Trim leading/trailing spaces
  
  // Reconstruct the `title` field for Stremio display as "Base Title (YEAR) SXX EP(YY-ZZ)"
  let reconstructedDisplayTitleParts = [finalCleanedBaseTitle];
  if (metadata.year) {
      reconstructedDisplayTitleParts.push(`(${metadata.year})`);
  }
  if (metadata.season) {
      reconstructedDisplayTitleParts.push(`S${metadata.season.toString().padStart(2, '0')}`);
  }
  // Append episode range/single if applicable and distinct from season
  if (metadata.episodeStart && (metadata.episodeStart !== 1 || metadata.episodeEnd !== 1 || (finalCleanedBaseTitle.toLowerCase().includes('episode') && metadata.season === 1 && metadata.episodeStart === 1 && metadata.episodeEnd === 1))) {
      if (metadata.episodeEnd && (metadata.episodeStart !== metadata.episodeEnd)) {
          reconstructedDisplayTitleParts.push(`EP(${metadata.episodeStart.toString().padStart(2, '0')}-${metadata.episodeEnd.toString().padStart(2, '0')})`);
      } else {
          reconstructedDisplayTitleParts.push(`EP${metadata.episodeStart.toString().padStart(2, '0')}`);
      }
  }

  // Set the final display title
  metadata.title = reconstructedDisplayTitleParts.join(' ').replace(/\s+/g, ' ').trim();

  // Fallback for cases where parsing might result in an empty or malformed title
  if (!metadata.title || metadata.title.match(/^(\(\d{4}\)|\s*S\d{2}|\s*EP\d{2}(-\d{2})?\s*)+$/)) {
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

/**
 * Cleans a stream file name/display name to produce a concise title for catalog display.
 * This function will remove website domains, bracketed content, file extensions,
 * and common codec/quality strings, along with "TamilShow - resolution -" prefixes.
 *
 * Example: "TamilShow - 1080p - www.1TamilBlasters.earth - Cooku With Comali (2025) S06E05 [Tamil - 1080p HD AVC UNTOUCHED - x264 - AAC -1.7GB].mkv - AVC - x264 - AAC"
 * Should become: "Cooku With Comali (2025) S06E05"
 *
 * @param {string} fileName The stream file name or display name.
 * @returns {string} The cleaned title for catalog display.
 */
function cleanStreamFileNameForCatalogTitle(fileName) {
    if (!fileName) return '';

    let cleaned = fileName;

    // 1. Remove streamname prefix "TamilShow - resolution - " (e.g., "TamilShow - 1080p - ")
    // This targets both "TamilShow - XXXp -" and "TamilShow - Unknown Res -"
    cleaned = cleaned.replace(/TamilShow\s*-\s*(?:\d{3,4}p|4K|Unknown Res)\s*-\s*/gi, ' ');

    // 2. Remove website domains (e.g., www.1TamilBlasters.earth, www.example.com, .net, .org, .fi, etc.)
    // More robust pattern to catch various TLDs and subdomains.
    cleaned = cleaned.replace(/\b(www\.[a-zA-Z0-9-]+\.(?:[a-z]{2,}|[a-z]{2,}(?:\.[a-z]{2,})+))\b/gi, ' ');

    // 3. Remove content within square brackets (e.g., [Tamil - 1080p HD AVC UNTOUCHED - x264 - AAC -1.7GB].mkv)
    cleaned = cleaned.replace(/\[.*?\]/g, ' ');

    // 4. Remove sizes (e.g., " - 600MB", " - 1.7GB") - specifically target trailing sizes
    cleaned = cleaned.replace(/-\s*\d+\.?\d*\s*[KMGT]?B\b/gi, ' ');

    // 5. Remove subtitle indicators (e.g., " - ESub]", " - ESub")
    cleaned = cleaned.replace(/-\s*ESub\b|Subtitles?\]?/gi, ' '); // Handles trailing ']' and common subtitle terms

    // 6. Remove any file extensions (e.g., .mkv, .mp4, .avi) at the end of the string
    cleaned = cleaned.replace(/\.\w{2,4}\s*$/, ' ');

    // 7. Remove common codec/quality strings that might remain, especially if they are hyphen-prefixed
    // Add more comprehensive list and target them globally.
    cleaned = cleaned.replace(/(?:\s*-\s*(?:AVC|x264|x265|HEVC|AAC|DD5\.1|AC3|DTS|HDRip|WEB-DL|BluRay|HDTV|WEBRip|BDRip|DVDRip|UNTOUCHED|HDR|DDP|WEB|RIP|BR))*/gi, ' ');

    // 8. Remove stray hyphens or pluses that might remain from previous removals, especially at ends
    cleaned = cleaned.replace(/[-\+]+/g, ' ');

    // 9. Final cleanup: reduce multiple spaces to single space and trim leading/trailing spaces/hyphens
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^-+|-+$/g, '').trim(); // Remove any lingering leading/trailing hyphens

    return cleaned;
}


module.exports = {
  normalizeTitle,
  parseTitle,
  fuzzyMatch,
  cleanStreamFileNameForCatalogTitle // Export the new function
};
