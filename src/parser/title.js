const jaroWinkler = require('jaro-winkler');
const { logger } = require('../utils/logger.js'); // Ensure .js extension

/**
 * @typedef {object} ParsedTitleMetadata
 * @property {string} title - The full display title of the series/movie, reconstructed with year, season, and episode.
 * @property {string} baseShowName - The core show name, heavily cleaned, without any year, season, or episode reconstruction.
 * @property {number} [year] - The release year.
 * @property {number} [season] - The season number (optional).
 * @property {number} [episodeStart] - The starting episode number (optional).
 * @property {number} [episodeEnd] - The ending episode number (optional, for multi-episode releases).
 * @property {string[]} languages - e.g., ["ta", "ml"]
 * @property {string[]} resolutions - e.g., ["720p", "1080p", "4K"]
 * @property {string[]} qualityTags - e.g., ["HQ HDRip", "WEB-DL"]
 * @property {string[]} codecs - e.g., ["x264", "x265", "HEVC"]
 * @property {string[]} audioCodecs - e.g., ["AAC", "DD5.1|AC3", "DTS"]
 * @property {string[]} sizes - e.g., ["1.2GB", "600MB"]
 * @property {boolean} [hasESub] - True if English subtitles are indicated.
 * @property {string} originalTitle - The original raw title string.
 */

// --- Regex Patterns ---
const REGEX_YEAR = /\(?(\d{4})\)?/ig;
const REGEX_SEASON = /(?:S(\d+)(?:-\s*S?(\d+))?|Season\s*(\d+)(?:-\s*Season\s*(\d+))?|s(\d+)(?:-s(\d+))?|season\s*(\d+)(?:-(\d+))?|complete series|season\s*pack|full\s*season)/ig;
const REGEX_EPISODE = /(?:E(?:P)?(\d+)(?:-(\d+))?|Episode(?:s)?\s*(\d+)(?:-(\d+))?|e(\d+)(?:-e(\d+))?|ep(\d+)(?:-ep(\d+))?)/ig;
const REGEX_RESOLUTION = /(\d{3,4}p|4K|HD|HQ)/ig;
const REGEX_LANGUAGES = /(?:\[\s*(?:(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi|Tel|ML|Kn|Jap|Kor)\s*(?:[+\s-]\s*(?:Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Por|Multi|Tel|ML|Kn|Jap|Kor))*)\s*\]|(?:tam|tel|kan|hin|eng|mal|kor|chi|por|jap|ml|kn)\b|Tamil|Telugu|Kannada|Hindi|Eng|Malayalam|Korean|Chinese|Portugu\s*ese|Jap|Kor)\b/ig;
const REGEX_CODECS = /(x264|x265|HEVC|AVC|VP9)/ig;
const REGEX_AUDIO_CODECS = /(AAC|DD5\.1|AC3|DTS|Opus|MP3|\b5\.1\b|\b5\s1\b)/ig;
const REGEX_QUALITY_TAGS = /(?:HQ\s*HDRip|WEB-DL|HDRip|BluRay|HDTV|WEBRip|BDRip|DVDRip|UNTOUCHED|HDR|DDP|WEB|RIP|BR|HQRip|HDRip)/ig;
const REGEX_SIZE = /(\d+\.?\d*\s*[KMGT]?B)/ig;
const REGEX_SUBTITLE = /(ESub|Subtitles?)/ig;
const REGEX_FILE_EXTENSION = /\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)\b/ig;
const REGEX_WEBSITE_DOMAIN = /\b(www\.[a-zA-Z0-9-]+\.(?:[a-z]{2,}|[a-z]{2,}(?:\.[a-z]{2,})+))\b/gi;
const REGEX_RELEASE_GROUP = /(?:\[\w+\]|\(\w+\))$/;
const REGEX_JUNK_CHARACTERS = /\s+(?:[A-Z]|\d|\bEP\b|\bS\b|\bE\b|[\+\.])/ig;

// --- Language Map ---
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
  'multi': 'multi',
  'jap': 'ja',
  'ml': 'ml',
  'kn': 'kn',
};

/**
 * Normalizes a string for fuzzy matching and ID generation.
 * @param {string} text The input string to normalize.
 * @returns {string} The normalized string.
 */
function normalizeTitle(text) {
  if (!text) return '';
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/\b(complete series|season pack|full season|ep\d+(-\d+)?)\b/g, '');
  normalized = normalized.replace(/[^a-z0-9\s]/g, ''); 
  normalized = normalized.replace(/\bseason\b/g, 's');
  normalized = normalized.replace(/\bepisode\b/g, 'ep');
  normalized = normalized.replace(/\bpart\b/g, 'p');
  normalized = normalized.replace(/\bvol\b/g, 'v');
  normalized = normalized.replace(/s\b/g, '');
  normalized = normalized.replace(/\s+/g, '-').trim();
  normalized = normalized.replace(/^-+|-+$/g, '');
  return normalized;
}

/**
 * Helper to ensure regex lastIndex is reset for global patterns.
 * @param {RegExp} regex The regex to reset.
 */
const resetRegex = (regex) => {
    if (regex.global) regex.lastIndex = 0;
};

/**
 * Extracts years from a string.
 * @param {string} text
 * @returns {number[]}
 */
function extractYears(text) {
    const years = new Set();
    resetRegex(REGEX_YEAR);
    let match;
    while ((match = REGEX_YEAR.exec(text)) !== null) {
        if (match[1]) years.add(parseInt(match[1], 10));
    }
    return Array.from(years);
}

/**
 * Extracts and normalizes season numbers, handling ranges.
 * @param {string} text
 * @returns {number[]}
 */
function extractSeasons(text) {
    const seasons = new Set();
    resetRegex(REGEX_SEASON);
    let match;
    while ((match = REGEX_SEASON.exec(text)) !== null) {
        if (match[1]) seasons.add(parseInt(match[1], 10)); 
        if (match[2]) seasons.add(parseInt(match[2], 10));
        if (match[3]) seasons.add(parseInt(match[3], 10));
        if (match[4]) seasons.add(parseInt(match[4], 10));
        if (match[5]) seasons.add(parseInt(match[5], 10));
        if (match[6]) seasons.add(parseInt(match[6], 10));
        if (match[7]) seasons.add(parseInt(match[7], 10));
        if (match[8]) seasons.add(parseInt(match[8], 10));
    }
    return Array.from(seasons).sort((a, b) => a - b);
}

/**
 * Extracts episode numbers, handling ranges.
 * @param {string} text
 * @returns {{start: number, end: number}[]}
 */
function extractEpisodes(text) {
    const episodes = [];
    resetRegex(REGEX_EPISODE);
    let match;
    while ((match = REGEX_EPISODE.exec(text)) !== null) {
        let start = null;
        let end = null;
        if (match[1] && match[2]) {
            start = parseInt(match[1], 10);
            end = parseInt(match[2], 10);
        } else if (match[1]) {
            start = parseInt(match[1], 10);
            end = start;
        } else if (match[3] && match[4]) {
            start = parseInt(match[3], 10);
            end = parseInt(match[4], 10);
        } else if (match[3]) {
            start = parseInt(match[3], 10);
            end = start;
        } else if (match[5] && match[6]) {
            start = parseInt(match[5], 10);
            end = parseInt(match[6], 10);
        } else if (match[5]) {
            start = parseInt(match[5], 10);
            end = start;
        } else if (match[7] && match[8]) {
            start = parseInt(match[7], 10);
            end = parseInt(match[8], 10);
        } else if (match[7]) {
            start = parseInt(match[7], 10);
            end = start;
        }
        if (start !== null) {
            episodes.push({ start, end });
        }
    }
    return episodes.sort((a, b) => a.start - b.start);
}

/**
 * Extracts resolutions from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractResolutions(text) {
    const resolutions = new Set();
    resetRegex(REGEX_RESOLUTION);
    let match;
    while ((match = REGEX_RESOLUTION.exec(text)) !== null) {
        if (match[1]) resolutions.add(match[1]);
    }
    return Array.from(resolutions);
}

/**
 * Extracts and normalizes languages from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractLanguages(text) {
    const languages = new Set();
    resetRegex(REGEX_LANGUAGES);
    let match;
    while ((match = REGEX_LANGUAGES.exec(text)) !== null) {
        const matchedText = match[0];
        const cleanParts = matchedText.replace(/[\[\]]/g, '').split(/[+\s-]/).filter(Boolean);
        cleanParts.forEach(part => {
            const mappedLang = LANGUAGE_MAP[part.toLowerCase()];
            if (mappedLang) {
                languages.add(mappedLang);
            } else if (part.length <= 3 && part.match(/^[a-z]{2,3}$/i)) {
                languages.add(part.toLowerCase());
            } else if (part) {
                languages.add(part.toLowerCase());
            }
        });
    }
    return Array.from(languages);
}

/**
 * Extracts video codecs from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractCodecs(text) {
    const codecs = new Set();
    resetRegex(REGEX_CODECS);
    let match;
    while ((match = REGEX_CODECS.exec(text)) !== null) {
        if (match[1]) codecs.add(match[1]);
    }
    return Array.from(codecs);
}

/**
 * Extracts audio codecs from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractAudioCodecs(text) {
    const audioCodecs = new Set();
    resetRegex(REGEX_AUDIO_CODECS);
    let match;
    while ((match = REGEX_AUDIO_CODECS.exec(text)) !== null) {
        if (match[1]) audioCodecs.add(match[1]);
    }
    return Array.from(audioCodecs);
}

/**
 * Extracts quality tags from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractQualityTags(text) {
    const qualityTags = new Set();
    resetRegex(REGEX_QUALITY_TAGS);
    let match;
    while ((match = REGEX_QUALITY_TAGS.exec(text)) !== null) {
        if (match[0]) qualityTags.add(match[0]);
    }
    return Array.from(qualityTags);
}

/**
 * Extracts file extensions from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractFileExtensions(text) {
    const extensions = new Set();
    resetRegex(REGEX_FILE_EXTENSION);
    let match;
    while ((match = REGEX_FILE_EXTENSION.exec(text)) !== null) {
        if (match[1]) extensions.add(`.${match[1]}`);
    }
    return Array.from(extensions);
}

/**
 * Extracts sizes from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractSizes(text) {
    const sizes = new Set();
    resetRegex(REGEX_SIZE);
    let match;
    while ((match = REGEX_SIZE.exec(text)) !== null) {
        if (match[1]) sizes.add(match[1]);
    }
    return Array.from(sizes);
}

/**
 * Extracts subtitle presence.
 * @param {string} text
 * @returns {boolean}
 */
function extractHasESub(text) {
    resetRegex(REGEX_SUBTITLE);
    return REGEX_SUBTITLE.test(text);
}

/**
 * Parses the title string and extracts relevant metadata, yielding a clean title.
 * @param {string} titleString The raw title string from the source.
 * @returns {ParsedTitleMetadata} ParsedTitleMetadata object.
 */
function parseTitle(titleString) {
  /** @type {ParsedTitleMetadata} */
  const metadata = {
    title: titleString,
    baseShowName: '',
    originalTitle: titleString,
    languages: [],
    resolutions: [],
    qualityTags: [],
    codecs: [],
    audioCodecs: [],
    sizes: [],
    hasESub: false,
  };

  let tempTitle = titleString;

  const strippingPatterns = [
    REGEX_WEBSITE_DOMAIN,
    REGEX_FILE_EXTENSION,
    REGEX_RELEASE_GROUP,
    REGEX_SUBTITLE,
    REGEX_SIZE,
    REGEX_AUDIO_CODECS,
    REGEX_CODECS,
    REGEX_QUALITY_TAGS,
    REGEX_RESOLUTION,
    REGEX_LANGUAGES,
    REGEX_EPISODE,
    REGEX_SEASON,
    REGEX_YEAR,
    /TamilShow\s*-\s*(?:\d{3,4}p|4K|Unknown Res)\s*-\s*/gi,
    /[\(\[]\s*(?:[A-Z0-9\s.-]+)\s*[\)\]]/g,
    REGEX_JUNK_CHARACTERS,
    /[\-+\._]/g,
  ];

  metadata.year = extractYears(tempTitle)[0];
  metadata.season = extractSeasons(tempTitle)[0];
  const episodes = extractEpisodes(tempTitle);
  if (episodes.length > 0) {
      metadata.episodeStart = episodes[0].start;
      metadata.episodeEnd = episodes[0].end;
  } else {
      metadata.season = metadata.season || 1;
      metadata.episodeStart = 1;
      metadata.episodeEnd = 1;
  }

  metadata.resolutions = extractResolutions(tempTitle);
  metadata.languages = extractLanguages(tempTitle);
  metadata.codecs = extractCodecs(tempTitle);
  metadata.audioCodecs = extractAudioCodecs(tempTitle);
  metadata.qualityTags = extractQualityTags(tempTitle);
  metadata.sizes = extractSizes(tempTitle);
  metadata.hasESub = extractHasESub(tempTitle);

  for (const pattern of strippingPatterns) {
    resetRegex(pattern);
    tempTitle = tempTitle.replace(pattern, ' ');
  }

  tempTitle = tempTitle.replace(/[^a-zA-Z0-9\s]/g, ' ')
                       .replace(/\s+/g, ' ').trim();

  metadata.baseShowName = tempTitle;

  let reconstructedDisplayTitleParts = [metadata.baseShowName];
  if (metadata.year && metadata.year !== 0) {
      reconstructedDisplayTitleParts.push(`(${metadata.year})`);
  }
  if (metadata.season && metadata.season !== 0) {
      reconstructedDisplayTitleParts.push(`S${metadata.season.toString().padStart(2, '0')}`);
  }
  if (metadata.episodeStart && metadata.episodeStart !== 0) {
      if (metadata.episodeEnd && metadata.episodeStart !== metadata.episodeEnd) {
          reconstructedDisplayTitleParts.push(`EP(${metadata.episodeStart.toString().padStart(2, '0')}-${metadata.episodeEnd.toString().padStart(2, '0')})`);
      } else {
          reconstructedDisplayTitleParts.push(`EP${metadata.episodeStart.toString().padStart(2, '0')}`);
      }
  }
  metadata.title = reconstructedDisplayTitleParts.join(' ').replace(/\s+/g, ' ').trim();

  if (!metadata.baseShowName || metadata.baseShowName.length < 3) {
      metadata.baseShowName = titleString.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim() || titleString;
      metadata.title = metadata.baseShowName;
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

  const similarity = jaroWinkler(normalized1, normalized2); 

  logger.debug(`Fuzzy matching "${title1}" vs "${title2}": Normalized "${normalized1}" vs "${normalized2}"`);
  logger.debug(`Jaro-Winkler Similarity: ${similarity.toFixed(4)} (Threshold: ${threshold})`);

  return similarity >= threshold;
}

/**
 * Cleans a title to be used as the primary catalog entry for a series-season "movie".
 * @param {string} rawBaseShowName The core base show name (from parseTitle.baseShowName).
 * @param {number} year The year of the series/season.
 * @param {number} season The season number.
 * @returns {string} The heavily cleaned series-season title for the catalog.
 */
function cleanBaseTitleForCatalog(rawBaseShowName, year, season) {
  if (!rawBaseShowName) return '';
  let cleaned = rawBaseShowName;
  const formattedSeason = season.toString().padStart(2, '0');
  cleaned = `${cleaned} (${year}) S${formattedSeason}`.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Cleans a stream file name/display name to produce a concise title for individual stream display.
 * @param {ParsedTitleMetadata} metadata The parsed title metadata for the specific stream (from magnet.name).
 * @returns {string} The cleaned episode stream title.
 */
function cleanStreamDetailsTitle(metadata) {
    if (!metadata || !metadata.baseShowName) {
        logger.warn('cleanStreamDetailsTitle received invalid metadata. Returning empty string.');
        return '';
    }

    let parts = [metadata.baseShowName];
    if (metadata.season && metadata.season !== 0) {
        parts.push(`S${metadata.season.toString().padStart(2, '0')}`);
    }
    if (metadata.episodeStart && metadata.episodeStart !== 0) {
        if (metadata.episodeEnd && metadata.episodeStart !== metadata.episodeEnd) {
            parts.push(`EP(${metadata.episodeStart.toString().padStart(2, '0')}-${metadata.episodeEnd.toString().padStart(2, '0')})`);
        } else {
            parts.push(`EP${metadata.episodeStart.toString().padStart(2, '0')}`);
        }
    }

    let cleanedTitle = parts.join(' ').replace(/\s+/g, ' ').trim();

    if (metadata.qualityTags.length > 0) {
        const bestQuality = metadata.qualityTags.find(tag => ['HDRip', 'WEB-DL', 'BluRay', 'HDTV'].includes(tag))
                           || metadata.qualityTags[0];
        if (bestQuality) {
            cleanedTitle += ` - ${bestQuality.toUpperCase()}`;
        }
    } else if (metadata.resolutions.length > 0) {
        const resolution = metadata.resolutions[0];
        const resolutionNum = parseInt(resolution, 10);
        if (resolution === '1080p' || resolution.toLowerCase() === '4k') {
            cleanedTitle += ' - HD';
        } else if (resolution === '720p') {
            cleanedTitle += ' - HQ';
        } else if (resolutionNum <= 480) {
            cleanedTitle += ' - LQ';
        } else {
            cleanedTitle += ` - ${resolution.toUpperCase()}`;
        }
    }
    return cleanedTitle.trim();
}

module.exports = {
  normalizeTitle,
  parseTitle,
  fuzzyMatch,
  cleanBaseTitleForCatalog, 
  cleanStreamDetailsTitle 
};
