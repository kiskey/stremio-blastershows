const axios = require('axios');
const cheerio = require('cheerio');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const { parseTitle } = require('../parser/title'); // Import parseTitle
const { logger } = require('../utils/logger'); // Import the centralized logger

/**
 * @typedef {object} MagnetData
 * @property {string} url - The magnet URI.
 * @property {string} name - Full descriptive name (from ipsAttachLink_title or magnet DN).
 * @property {string} [size] - The size of the content (e.g., "7GB").
 * @property {string} [resolution] - The resolution of the content (e.g., "1080p").
 */

/**
 * @typedef {object} ThreadContent
 * @property {string} title - The main title of the thread.
 * @property {string} posterUrl - URL to the poster/image.
 * @property {MagnetData[]} magnets - Array of extracted magnet data.
 * @property {string} timestamp - ISO8601 format (last modified by crawler).
 * @property {string} threadId - Unique ID for the forum thread.
 * @property {string} originalUrl - The original URL of the thread page.
 * @property {string} threadStartedTime - ISO8601 format (initial post time on forum).
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
      maxRedirects: 10,
      validateStatus: (status) => status >= 200 && status < 400
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
      const delay = Math.pow(2, (3 - retries)) * 1000;
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
      return decodeURIComponent(dn.replace(/\+/g, ' '));
    }
  } catch (error) {
    logger.debug(`Error parsing 'dn' from magnet URI: ${magnetUri}`, error);
  }
  return null;
}

/**
 * Extracts a unique numerical thread ID from a forum topic URL.
 * @param {string} threadUrl The URL of the forum thread.
 * @returns {string} The numerical thread ID as a string, or a base64 encoded URL if no ID is found.
 */
function getUniqueThreadId(threadUrl) {
  const url = new URL(threadUrl);
  const pathSegments = url.pathname.split('/');
  const topicSegment = pathSegments.find(segment => /^\d+-/.test(segment));

  if (topicSegment) {
    return topicSegment.split('-')[0];
  } else {
    logger.warn(`Could not extract numerical thread ID from URL: ${threadUrl}. Using base64 encoding.`);
    return Buffer.from(threadUrl).toString('base64');
  }
}

/**
 * Parses resolution and size from a magnet name/filename.
 * @param {string} magnetName The name extracted from the magnet URI's 'dn' parameter or torrent title.
 * @returns {{resolution?: string, size?: string}} An object containing parsed resolution and size, or null if not found.
 */
function parseResolutionAndSizeFromMagnetName(magnetName) {
  const result = {};

  const resolutionMatch = magnetName.match(/(\d{3,4}p|4K)/i);
  if (resolutionMatch) {
    result.resolution = resolutionMatch[1];
  }

  const sizeMatch = magnetName.match(/(\d+\.?\d*\s*[KMGT]?B)/i);
  if (sizeMatch) {
    result.size = sizeMatch[1];
  }

  return result;
}

/**
 * Processes a single forum thread page to extract relevant content.
 * @param {string} threadUrl The URL of the forum thread page.
 * @returns {Promise<ThreadContent|null>} A Promise resolving to ThreadContent object or null if processing fails.
 */
async function processThread(threadUrl) {
  logger.info(`Processing thread: ${threadUrl}`);
  const html = await fetchHtmlForProcessing(threadUrl);
  if (!html) {
    return null;
  }

  const $ = cheerio.load(html);

  const window = new JSDOM('').window;
  const purify = createDOMPurify(window);

  const titleElement = $('span.ipsType_break.ipsContained').first();
  let title = titleElement.text().trim();
  if (!title) {
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
  title = purify.sanitize(title, { USE_PROFILES: { html: false } });

  const posterElement = $('div.ipsType_normal.ipsType_richText img.ipsImage').first();
  let posterUrl = posterElement.attr('src') || '';
  if (!posterUrl) {
    posterUrl = $('meta[property="og:image"]').attr('content') || '';
    if (!posterUrl) {
        logger.warn(`No specific poster URL found for ${threadUrl}. Using placeholder.`);
        posterUrl = `https://placehold.co/200x300/101010/E0E0E0?text=${encodeURIComponent(title || 'No Poster')}`;
    }
  }

  const threadStartedTimeElement = $('span.ipsType_light time').first();
  let threadStartedTime = threadStartedTimeElement.attr('datetime') || new Date().toISOString();

  if (!threadStartedTime || isNaN(new Date(threadStartedTime).getTime())) {
    logger.warn(`Could not parse valid thread started time for ${threadUrl}. Using current time.`);
    threadStartedTime = new Date().toISOString();
  }

  const timestamp = new Date().toISOString();
  const threadId = getUniqueThreadId(threadUrl);

  /** @type {MagnetData[]} */
  const magnets = [];
  
  $('a.magnet-plugin').each((_index, magnetLinkElement) => {
      const magnetUrl = $(magnetLinkElement).attr('href');
      if (magnetUrl && validateMagnetUri(magnetUrl)) {
          let descriptiveName = null;
          
          const prevAttachLink = $(magnetLinkElement).prevAll('a.ipsAttachLink_block').first();
          if (prevAttachLink.length > 0) {
            descriptiveName = prevAttachLink.find('span.ipsAttachLink_title').text().trim();
          }

          if (!descriptiveName) {
            descriptiveName = parseDnFromMagnetUri(magnetUrl);
          }

          if (!descriptiveName || descriptiveName === 'Magnet Link') { // Check for common fallback string
            descriptiveName = $(magnetLinkElement).text().trim();
            if (descriptiveName === 'Magnet Link' || !descriptiveName) {
                descriptiveName = 'Unknown Quality Magnet';
            }
          }
          
          const { resolution, size } = parseResolutionAndSizeFromMagnetName(descriptiveName);
          
          const btih = extractBtihFromMagnet(magnetUrl);

          if (btih) {
            magnets.push({
                url: magnetUrl,
                name: descriptiveName,
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

  /** @type {ThreadContent} */
  const processedContent = {
    title: title,
    posterUrl: posterUrl,
    magnets: magnets,
    timestamp: timestamp,
    threadId: threadId,
    originalUrl: threadUrl,
    threadStartedTime: threadStartedTime
  };

  logger.info(`Processed thread ${threadUrl}: Title="${processedContent.title}", Magnets: ${processedContent.magnets.length}`);
  return processedContent;
}

module.exports = {
  processThread,
  getUniqueThreadId // Export for engine.js
};
