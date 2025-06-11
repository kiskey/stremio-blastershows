const axios = require('axios');
const cheerio = require('cheerio'); // Changed import for Cheerio
// Import MagnetData and ThreadContent interfaces from engine.ts (single source of truth)
// No longer importing type definitions from a .ts file as we are in .js environment now.
// The types are for documentation purposes.

// Correct import and initialization for DOMPurify with JSDOM
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const { parseTitle, normalizeTitle, fuzzyMatch } = require('../parser/title'); // Import title parsing functions
const { logger } = require('../utils/logger'); // Import the centralized logger

/**
 * @typedef {object} MagnetData
 * @property {string} url - The magnet URI.
 * @property {string} name - Full descriptive name.
 * @property {string} [size] - Size of the content.
 * @property {string} [resolution] - Resolution of the content.
 */

/**
 * @typedef {object} ThreadContent
 * @property {string} title
 * @property {string} posterUrl
 * @property {MagnetData[]} magnets
 * @property {string} timestamp
 * @property {string} threadId
 * @property {string} originalUrl
 * @property {string} threadStartedTime
 */

/**
 * Fetches the content of a given URL with error handling and retries.
 * @param {string} url The URL to fetch.
 * @param {number} [retries=3] Remaining retries.
 * @returns {Promise<string|null>} The HTML content as a string, or null if fetching fails.
 */
async function fetchHtmlForProcessing(url, retries = 3) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36'
      },
      maxRedirects: 10, // Handle 302 redirects
      validateStatus: (status) => status >= 200 && status < 400 // Accept 2xx and 3xx
    });
    return response.data;
  } catch (error) {
    logger.error(`Error fetching thread URL ${url}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Failed to fetch thread URL: ${url}`,
      error: error.message,
      url: url
    });

    if (retries > 0) {
      const delay = Math.pow(2, (3 - retries)) * 1000; // Exponential backoff
      logger.warn(`Retrying thread ${url} in ${delay / 1000} seconds... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchHtmlForProcessing(url, retries - 1);
    }
    logger.error(`Failed to fetch thread ${url} after multiple retries.`);
    return null;
  }
}

/**
 * Validates a magnet URI using a BTIH regex.
 * @param {string} uri The magnet URI string.
 * @returns {boolean} True if the URI is a valid magnet, false otherwise.
 */
function validateMagnetUri(uri) {
  // BTIH regex for magnet URI validation
  const btihRegex = /^magnet:\?xt=urn:btih:[a-zA-Z0-9]{40,}.*$/i;
  return btihRegex.test(uri);
}

/**
 * Extracts the 40-character BTIH (BitTorrent Info Hash) from a magnet URI.
 * @param {string} magnetUri The magnet URI string.
 * @returns {string|null} The 40-character BTIH as a string, or null if not found/invalid.
 */
function extractBtihFromMagnet(magnetUri) {
  const match = magnetUri.match(/urn:btih:([a-zA-Z0-9]{40})/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

/**
 * Parses the 'dn' (display name) parameter from a magnet URI.
 * @param {string} magnetUri The magnet URI string.
 * @returns {string|null} The decoded display name string, or null if not found.
 */
function parseDnFromMagnetUri(magnetUri) {
  try {
    const url = new URL(magnetUri);
    const dn = url.searchParams.get('dn');
    if (dn) {
      return decodeURIComponent(dn.replace(/\+/g, ' ')); // Decode URI component and replace '+' with spaces
    }
  } catch (error) {
    logger.debug(`Error parsing 'dn' from magnet URI: ${magnetUri}`, error);
  }
  return null;
}

/**
 * Extracts a unique numerical thread ID from a forum topic URL.
 * Handles URLs like: https://www.1tamilblasters.fi/index.php?/forums/topic/133067-mercy-for-none-s01-...
 * @param {string} threadUrl The URL of the forum thread.
 * @returns {string} The numerical thread ID as a string, or a base64 encoded URL if no ID is found.
 */
function getUniqueThreadId(threadUrl) {
  const url = new URL(threadUrl);
  // Expected path format: /index.php?/forums/topic/<NUMBER>-<TITLE>/
  const pathSegments = url.pathname.split('/');
  // Find the segment that starts with a number and contains a hyphen
  // e.g., "133067-mercy-for-none-s01-..."
  const topicSegment = pathSegments.find(segment => /^\d+-/.test(segment));

  if (topicSegment) {
    return topicSegment.split('-')[0]; // Extract just the number
  } else {
    // Fallback if the numerical ID pattern is not found
    logger.warn(`Could not extract numerical thread ID from URL: ${threadUrl}. Using base64 encoding.`);
    return Buffer.from(threadUrl).toString('base64');
  }
}

/**
 * Parses resolution and size from a magnet name/filename.
 * Example magnet name: "Cooku With Comali (2025) S06E01 [Tamil - 1080p HD AVC UNTOUCHED - x264 - AAC - 7GB].mkv"
 * @param {string} magnetName The name extracted from the magnet URI's 'dn' parameter or torrent title.
 * @returns {{ resolution?: string, size?: string }} An object containing parsed resolution and size, or null if not found.
 */
function parseResolutionAndSizeFromMagnetName(magnetName) {
  const result = {};

  // Regex for resolution (e.g., 1080p, 720p, 480p, 4K)
  const resolutionMatch = magnetName.match(/(\d{3,4}p|4K)/i);
  if (resolutionMatch) {
    result.resolution = resolutionMatch[1];
  }

  // Regex for size (e.g., 7GB, 550MB, 2.4GB)
  const sizeMatch = magnetName.match(/(\d+\.?\d*\s*[KMGT]?B)/i);
  if (sizeMatch) {
    result.size = sizeMatch[1];
  }

  return result;
}


/**
 * Processes a single forum thread page to extract relevant content.
 * @param {string} threadUrl The URL of the forum thread page.
 * @returns {Promise<ThreadContent | null>} A Promise resolving to ThreadContent object or null if processing fails.
 */
async function processThread(threadUrl) {
  logger.info(`Processing thread: ${threadUrl}`);
  const html = await fetchHtmlForProcessing(threadUrl);
  if (!html) {
    return null;
  }

  const $ = cheerio.load(html);

  // Initialize DOMPurify with a JSDOM window for Node.js environment
  const window = new JSDOM('').window;
  const purify = createDOMPurify(window); // Corrected initialization for DOMPurify


  // Extract title: <span class="ipsType_break ipsContained"> text
  // Using .first() to ensure we get the first match in case of multiple
  const titleElement = $('span.ipsType_break.ipsContained').first();
  let title = titleElement.text().trim();
  if (!title) {
    // Fallback parsing: Try other common title elements if the main one fails
    logger.warn(`Could not find primary title element for ${threadUrl}. Trying fallback.`);
    title = $('meta[property="og:title"]').attr('content')?.trim() || $('title').text().trim();
    if (!title) {
      logger.error(`Failed to extract title from ${threadUrl} using fallbacks.`);
      logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Failed to extract title from thread: ${threadUrl}`,
        url: threadUrl
      });
      return null;
    }
  }
  // Sanitize title to prevent XSS
  title = purify.sanitize(title, { USE_PROFILES: { html: false } });


  // Extract posterUrl: <img class="ipsImage"> src attribute (first image in the post content)
  // This might need refinement based on exact forum structure.
  const posterElement = $('div.ipsType_normal.ipsType_richText img.ipsImage').first();
  let posterUrl = posterElement.attr('src') || '';
  if (!posterUrl) {
    // Fallback: Check for meta og:image or a common placeholder
    posterUrl = $('meta[property="og:image"]').attr('content') || '';
    if (!posterUrl) {
        logger.warn(`No specific poster URL found for ${threadUrl}. Using placeholder.`);
        // Placeholder for missing poster URL
        posterUrl = `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(title || 'No Poster')}`;
    }
  }

  // Extract threadStartedTime: from <time datetime="ISO8601"> within <span class="ipsType_light">
  const threadStartedTimeElement = $('span.ipsType_light time').first();
  let threadStartedTime = threadStartedTimeElement.attr('datetime') || new Date().toISOString();

  if (!threadStartedTime || isNaN(new Date(threadStartedTime).getTime())) {
    logger.warn(`Could not parse valid thread started time for ${threadUrl}. Using current time.`);
    threadStartedTime = new Date().toISOString();
  }

  // Declare timestamp for when this thread was processed/last updated by the crawler
  const timestamp = new Date().toISOString();

  // Generate a unique thread ID using the robust function
  const threadId = getUniqueThreadId(threadUrl);

  // --- REVISED MAGNET EXTRACTION LOGIC ---
  const magnets = [];
  
  // Iterate over all magnet-plugin links
  $('a.magnet-plugin').each((_index, magnetLinkElement) => {
      const magnetUrl = $(magnetLinkElement).attr('href');
      logger.debug(`Found potential magnet URL: ${magnetUrl}`); // Debug log for every found magnet URL

      if (magnetUrl && validateMagnetUri(magnetUrl)) {
          let descriptiveName = null;
          
          // Try to find the closest preceding ipsAttachLink_block sibling
          const prevAttachLink = $(magnetLinkElement).prevAll('a.ipsAttachLink_block').first();
          if (prevAttachLink.length > 0) {
            descriptiveName = prevAttachLink.find('span.ipsAttachLink_title').text().trim();
          }

          // Fallback to parsing 'dn' parameter from magnet URI if no descriptive title found
          if (!descriptiveName) {
            descriptiveName = parseDnFromMagnetUri(magnetUrl);
          }

          // Final fallback if 'dn' is also not found or empty
          if (!descriptiveName) {
            descriptiveName = $(magnetLinkElement).text().trim(); // Might be "Magnet Link"
            if (descriptiveName === 'Magnet Link' || !descriptiveName) {
                descriptiveName = 'Unknown Quality Magnet'; // Generic fallback
            }
          }
          
          const { resolution, size } = parseResolutionAndSizeFromMagnetName(descriptiveName);
          
          // Ensure a unique BTIH for the stream key
          const btih = extractBtihFromMagnet(magnetUrl);

          if (btih) {
            magnets.push({
                url: magnetUrl,
                name: descriptiveName, // Use the extracted descriptive name
                size: size,
                resolution: resolution
            });
          } else {
            logger.warn(`Could not extract BTIH for magnet: ${magnetUrl} in thread ${threadUrl}`);
             logger.logToRedisErrorQueue({
                timestamp: new Date().toISOString(),
                level: 'WARN',
                message: `Magnet URI without BTIH: ${magnetUrl}`,
                url: threadUrl
              });
          }
      } else if (magnetUrl) {
          logger.warn(`Invalid magnet URI detected: ${magnetUrl} in thread ${threadUrl}`);
          logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'WARN',
            message: `Invalid magnet URI detected: ${magnetUrl}`,
            url: threadUrl
          });
      }
  });


  const processedContent = {
    title: title,
    posterUrl: posterUrl,
    magnets: magnets,
    timestamp: timestamp, // Use the newly declared 'timestamp' for processing time
    threadId: threadId, // Ensure the correct unique ID is passed
    originalUrl: threadUrl,
    threadStartedTime: threadStartedTime // Use the 'threadStartedTime' parsed from the forum
  };

  logger.info(`Processed thread ${threadUrl}: Title="${processedContent.title}", Magnets: ${processedContent.magnets.length}`);
  return processedContent;
}

module.exports = {
  processThread,
  getUniqueThreadId, // Export if needed elsewhere
  extractBtihFromMagnet // Export if needed elsewhere
};
