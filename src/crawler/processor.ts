import axios from 'axios';
import * as cheerio from 'cheerio'; // Changed import for Cheerio
import { ThreadContent, MagnetData } from './engine'; // Import interfaces
// Correct import and initialization for DOMPurify with JSDOM
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
// Using js-levenshtein for Jaro-Winkler, as specified in requirements.
import { jaroWinkler } from 'js-levenshtein'; // Still named import, relies on .d.ts
import { parseTitle, normalizeTitle, fuzzyMatch } from '../parser/title'; // Import title parsing functions
import { logger } from '../utils/logger'; // Import the centralized logger

/**
 * Interface for MagnetData as specified in requirements.
 * Updated to include resolution and size for each magnet.
 */
export interface MagnetData {
  url: string;
  name: string; // Full descriptive name from ipsAttachLink_title
  size?: string;
  resolution?: string; // Add resolution here
}

/**
 * Fetches the content of a given URL with error handling and retries.
 * @param url The URL to fetch.
 * @param retries Remaining retries.
 * @returns The HTML content as a string, or null if fetching fails.
 */
async function fetchHtmlForProcessing(url: string, retries: number = 3): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36'
      },
      maxRedirects: 10, // Handle 302 redirects
      validateStatus: (status) => status >= 200 && status < 400 // Accept 2xx and 3xx
    });
    return response.data;
  } catch (error: any) {
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
 * @param uri The magnet URI string.
 * @returns True if the URI is a valid magnet, false otherwise.
 */
function validateMagnetUri(uri: string): boolean {
  // BTIH regex for magnet URI validation
  const btihRegex = /^magnet:\?xt=urn:btih:[a-zA-Z0-9]{40,}.*$/i;
  return btihRegex.test(uri);
}

/**
 * Extracts a unique numerical thread ID from a forum topic URL.
 * Handles URLs like: https://www.1tamilblasters.fi/index.php?/forums/topic/133067-mercy-for-none-s01-...
 * @param threadUrl The URL of the forum thread.
 * @returns The numerical thread ID as a string, or a base64 encoded URL if no ID is found.
 */
function getUniqueThreadId(threadUrl: string): string {
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
 * @param magnetName The name extracted from the magnet URI's 'dn' parameter or torrent title.
 * @returns An object containing parsed resolution and size, or null if not found.
 */
function parseResolutionAndSizeFromMagnetName(magnetName: string): { resolution?: string, size?: string } {
  const result: { resolution?: string, size?: string } = {};

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
 * @param threadUrl The URL of the forum thread page.
 * @returns A Promise resolving to ThreadContent object or null if processing fails.
 */
export async function processThread(threadUrl: string): Promise<ThreadContent | null> {
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

  // Generate a unique thread ID using the robust function
  const threadId = getUniqueThreadId(threadUrl);

  // --- NEW MAGNET EXTRACTION LOGIC ---
  const magnets: MagnetData[] = [];
  // Find all elements that are immediately followed by a magnet-plugin link,
  // and contain the ipsAttachLink_title for the descriptive name.
  // This assumes the structure: ipsAttachLink_block (with title) -> magnet-plugin link
  
  // Find all 'a.ipsAttachLink_block' elements which contain the descriptive titles
  $('a.ipsAttachLink_block').each((index, titleLinkElement) => {
      const descriptiveTitle = $(titleLinkElement).find('span.ipsAttachLink_title').text().trim();
      
      // Find the next sibling that is a 'magnet-plugin' link
      const magnetLinkElement = $(titleLinkElement).nextAll('a.magnet-plugin').first();

      const magnetUrl = magnetLinkElement.attr('href');

      if (magnetUrl && validateMagnetUri(magnetUrl) && descriptiveTitle) {
          const { resolution, size } = parseResolutionAndSizeFromMagnetName(descriptiveTitle);
          magnets.push({
              url: magnetUrl,
              name: descriptiveTitle, // Use the descriptive title from ipsAttachLink_title
              size: size,
              resolution: resolution
          });
      } else if (magnetUrl) {
          logger.warn(`Invalid magnet URI or missing descriptive title for ${magnetUrl} in thread ${threadUrl}`);
          logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'WARN',
            message: `Invalid magnet URI or missing title detected: ${magnetUrl}`,
            url: threadUrl
          });
      }
  });

  // Fallback: If no magnets found by pairing, try to find standalone magnet links
  // (though the primary goal is paired extraction)
  if (magnets.length === 0) {
      $('a.magnet-plugin').each((index, element) => {
          const href = $(element).attr('href');
          if (href && validateMagnetUri(href)) {
              const name = $(element).text().trim() || $(element).attr('title')?.trim() || 'Unknown Magnet';
              const { resolution, size } = parseResolutionAndSizeFromMagnetName(name);
              magnets.push({ url: href, name: name, size: size, resolution: resolution });
          }
      });
  }


  const processedContent: ThreadContent = {
    title: title,
    posterUrl: posterUrl,
    magnets: magnets,
    timestamp: timestamp,
    threadId: threadId, // Ensure the correct unique ID is passed
    originalUrl: threadUrl,
    threadStartedTime: threadStartedTime // Added threadStartedTime
  };

  logger.info(`Processed thread ${threadUrl}: Title="${processedContent.title}", Magnets: ${processedContent.magnets.length}`);
  return processedContent;
}
