import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../config';
import redisClient, { hgetall, hset, hmset, zadd, zrangebyscore, del } from '../redis';
import { processThread } from './processor';
import { logger } from '../utils/logger';
import { normalizeTitle } from '../parser/title'; // Added import for normalizeTitle

/**
 * Interface for MagnetData as specified in requirements.
 */
export interface MagnetData {
  url: string;
  name: string;
  size?: string;
}

/**
 * Interface for ThreadContent extracted from a forum thread page.
 */
export interface ThreadContent {
  title: string;
  posterUrl: string;
  magnets: MagnetData[];
  timestamp: string; // ISO8601 format (last modified)
  threadId: string; // Unique ID for the thread
  originalUrl: string; // The URL of the thread page
  threadStartedTime: string; // ISO8601 format (initial post time)
}

// Global variable to hold the current page number for new content crawling
let currentPage = 1;
let isCrawling = false; // Flag to prevent multiple concurrent crawls

/**
 * Fetches the content of a given URL.
 * Implements exponential backoff for failed requests and User-Agent rotation (simple).
 * @param url The URL to fetch.
 * @param retries Remaining retries.
 * @returns The HTML content as a string, or null if fetching fails.
 */
async function fetchHtml(url: string, retries: number = 3): Promise<string | null> {
  // Simple User-Agent rotation (for a more robust solution, use a list of UAs)
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:98.0) Gecko/20100101 Firefox/98.0',
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  // Request throttling
  await new Promise(resolve => setTimeout(resolve, 250)); // 250ms between calls

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br' // Optimize for smaller response sizes
      },
      maxRedirects: 10, // Handle 302 redirects
      validateStatus: (status) => status >= 200 && status < 400 // Accept 2xx and 3xx
    });

    if (response.status >= 300 && response.status < 400) {
        // Handle redirects if needed, e.g., update base URL
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
            logger.warn(`Redirect detected from ${url} to ${redirectUrl}.`);
            // For now, axios follows redirects automatically.
        }
    }

    return response.data;
  } catch (error: any) {
    logger.error(`Error fetching ${url}:`, error);
    if (retries > 0) {
      const delay = Math.pow(2, (3 - retries)) * 1000; // Exponential backoff
      logger.info(`Retrying ${url} in ${delay / 1000} seconds... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchHtml(url, retries - 1);
    }
    logger.error(`Failed to fetch ${url} after multiple retries.`);
    // Log error to Redis error queue (as per requirement)
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Failed to fetch URL: ${url}`,
      error: error.message,
      url: url
    });
    return null;
  }
}

/**
 * Discovers thread URLs from a forum page.
 * @param html The HTML content of the forum page.
 * @param baseUrl The base URL to resolve relative links.
 * @returns An array of discovered unique thread URLs relevant for processing.
 */
function discoverThreadUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const uniqueThreadUrls = new Set<string>(); // Use a Set to ensure uniqueness

  // Parse <a class="" data-ipshover> elements as specified in requirements.
  $('a[data-ipshover]').each((index, element) => {
    const href = $(element).attr('href');
    if (href) {
      const absoluteUrl = new URL(href, baseUrl).href;
      // Filter out unwanted URLs: only keep those containing "/forums/topic/"
      // and explicitly ignore those containing "/profile/"
      if (absoluteUrl.includes('/forums/topic/') && !absoluteUrl.includes('/profile/')) {
        uniqueThreadUrls.add(absoluteUrl); // Add to Set
      } else {
        logger.debug(`Ignoring URL: ${absoluteUrl} (not a topic or is a profile page)`);
      }
    }
  });
  return Array.from(uniqueThreadUrls); // Convert Set back to Array
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
 * Crawls a single forum page to discover new threads.
 * @param pageNum The page number to crawl.
 * @returns True if the page was successfully crawled and new threads were found, false otherwise.
 */
async function crawlForumPage(pageNum: number): Promise<boolean> {
  const url = `${config.FORUM_URL}${pageNum > 1 ? `page/${pageNum}/` : ''}`;
  logger.info(`Crawling forum page: ${url}`);

  const html = await fetchHtml(url);
  if (!html) {
    logger.warn(`Could not fetch HTML for page ${pageNum}. Assuming end of pagination.`);
    return false; // Indicates end of pagination or critical error, stop crawling this page
  }

  const threadUrls = discoverThreadUrls(html, url);
  logger.info(`Discovered ${threadUrls.length} relevant threads on page ${pageNum}.`);

  if (threadUrls.length === 0) {
    logger.info(`No new relevant threads found on page ${pageNum}. Ending new page crawl.`);
    return false; // No threads means likely end of new pages or structure changed
  }

  // Use a worker thread pool for parallel processing if MAX_CONCURRENCY > 1
  const processingPromises: Promise<void>[] = [];
  for (const threadUrl of threadUrls) {
    // Use the new robust function to get the unique threadId
    const threadId = getUniqueThreadId(threadUrl);
    
    // Check if thread already processed or updated recently (using thread:{threadId} hash)
    const lastProcessed = await hgetall(`thread:${threadId}`);
    const now = new Date().toISOString();

    // If the thread has not been processed or needs re-visiting
    const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000; // hours to ms
    const lastModifiedTimestamp = lastProcessed.timestamp ? new Date(lastProcessed.timestamp).getTime() : 0;

    // The logic here is correct: if not processed before, or if enough time has passed, process it.
    // The "skipping" logs come from threads that WERE processed in the *same batch* and thus had their timestamp updated in Redis.
    if (!lastProcessed.timestamp || (Date.now() - lastModifiedTimestamp) > revisitThreshold) {
      logger.info(`Processing new or updated thread: ${threadUrl}`);
      processingPromises.push(
        (async () => {
          const processedData = await processThread(threadUrl);
          if (processedData) {
            // Store processed data in Redis (movie, episode, thread hashes)
            await saveThreadData(processedData);
            // Update thread tracking hash
            await hmset(`thread:${processedData.threadId}`, { // Use processedData.threadId to ensure consistency
              url: threadUrl,
              timestamp: now,
              status: 'processed'
            });
          }
        })()
      );
      // Basic concurrency control (can be enhanced with a proper queue/worker pool)
      if (processingPromises.length >= config.MAX_CONCURRENCY) {
        await Promise.all(processingPromises);
        processingPromises.length = 0; // Clear the array
      }
    } else {
      logger.info(`Thread ${threadUrl} recently processed. Skipping.`);
    }
  }

  // Await any remaining processing promises
  await Promise.all(processingPromises);

  // Return true if any threads were discovered, even if not new
  return threadUrls.length > 0;
}

/**
 * Parses resolution and size from a magnet name/filename.
 * Example magnet name: "Cooku With Comali (2025) S06E01 [Tamil - 1080p HD AVC UNTOUCHED - x264 - AAC - 7GB].mkv"
 * @param magnetName The name extracted from the magnet URI's 'dn' parameter.
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
 * Saves processed thread data into Redis according to the defined schema.
 * @param data The processed thread content.
 */
async function saveThreadData(data: ThreadContent): Promise<void> {
  const { title, posterUrl, magnets, timestamp, threadId, originalUrl } = data;
  
  // Explicitly ensure threadStartedTime is a string, providing a fallback.
  // This is the most robust type guard for the compiler in this scenario.
  let confirmedThreadStartedTime: string;
  if (typeof data.threadStartedTime === 'string') {
    confirmedThreadStartedTime = data.threadStartedTime;
  } else {
    // This else block should theoretically not be reached if processThread is working correctly
    // but it provides a compile-time guarantee and a runtime fallback.
    logger.warn(`threadStartedTime was unexpectedly not a string for threadId ${threadId}. Using current timestamp as fallback.`);
    confirmedThreadStartedTime = new Date().toISOString(); 
  }
  
  const now = new Date();

  // Basic normalization for show title to create a consistent Stremio ID
  const normalizedTitle = normalizeTitle(title);
  const stremioMovieId = `tt${normalizedTitle}`; // Consistent ID for the logical movie

  // Store main movie details using the stremioMovieId as the primary key.
  // This ensures each unique movie title has a single entry in the catalog.
  const movieKey = `movie:${stremioMovieId}`;
  await hmset(movieKey, {
    originalTitle: title,
    posterUrl: posterUrl,
    stremioId: stremioMovieId, // Store the consistent Stremio ID within the hash
    lastUpdated: now.toISOString(),
    associatedThreadId: threadId, // Link back to the original threadId
    threadStartedTime: confirmedThreadStartedTime // Use the explicitly confirmed string
  });
  logger.info(`Saved movie data for ${movieKey} (Stremio ID: ${stremioMovieId}, Started: ${confirmedThreadStartedTime})`);


  // Using the title parser to get more structured data (season, episode, etc.) from overall title
  const { season, episodeStart, episodeEnd, languages } = await (async () => {
    const { parseTitle } = await import('../parser/title');
    return parseTitle(title);
  })();

  let seasonNum = season || 1; // Default to Season 1 if not parsed
  let episodeCount = (episodeStart !== undefined && episodeEnd !== undefined) ? (episodeEnd - episodeStart + 1) : 1;

  // Process each magnet as a separate stream entry
  for (let i = 0; i < magnets.length; i++) {
    const magnet = magnets[i];
    if (!magnet || !magnet.url) {
      logger.warn(`Skipping magnet at index ${i} for thread ${threadId} due to missing URL.`);
      continue;
    }

    // Try to get resolution and size from magnet name (dn) first
    const { resolution: magnetResolution, size: magnetSize } = parseResolutionAndSizeFromMagnetName(magnet.name);

    // Fallback to thread-level parsed resolution if magnet name doesn't provide it
    const finalResolution = magnetResolution || (await (async () => {
        const { parseTitle } = await import('../parser/title');
        const parsedThreadTitle = parseTitle(title);
        return parsedThreadTitle.resolution;
    })());
    const finalSize = magnetSize || magnet.size || ''; // Use magnet.size if present, otherwise empty

    const currentEpisodeNum = (episodeStart || 1) + (i % episodeCount); // Handle multiple magnets for same episode, incrementing if needed

    // Episode keys are now constructed to link to the stremioMovieId and include S/E/Res.
    // Using a hash of the magnet URL to guarantee unique keys for each stream.
    const magnetHash = Buffer.from(magnet.url).toString('base64').substring(0, 10); // Short hash
    const episodeKey = `episode:${stremioMovieId}:s${seasonNum}e${currentEpisodeNum}:${finalResolution || 'unknown'}:${magnetHash}`;

    // Construct a more descriptive stream title
    const streamTitle = `${title}` +
                        (seasonNum ? ` S${seasonNum}` : '') +
                        (currentEpisodeNum ? ` E${currentEpisodeNum}` : '') +
                        ` ${finalResolution ? `[${finalResolution}]` : ''}` +
                        ` ${languages.length ? `[${languages.join('/')}]` : ''}` +
                        ` ${finalSize ? `(${finalSize})` : ''}` +
                        ` - ${magnet.name}`.trim();


    await hmset(episodeKey, {
      magnet: magnet.url,
      name: magnet.name,
      title: streamTitle,
      size: finalSize,
      resolution: finalResolution,
      timestamp: now.toISOString(),
      threadUrl: originalUrl,
      stremioMovieId: stremioMovieId
    });
    logger.info(`Saved stream data for ${episodeKey} (Magnet: ${magnet.url.substring(0, 30)}...)`);
  }

  // Update languages for the movie hash if new languages are found
  if (languages && languages.length > 0) {
    const existingLanguagesString = await hgetall(movieKey).then(data => data.languages);
    const existingLanguages = existingLanguagesString ? existingLanguagesString.split(',') : [];
    const mergedLanguages = Array.from(new Set([...existingLanguages, ...languages]));
    await hset(movieKey, 'languages', mergedLanguages.join(','));
  }

  // Update seasons field in movie hash to record discovered seasons
  const existingSeasonsString = await hgetall(movieKey).then(data => data.seasons);
  const existingSeasons = existingSeasonsString ? existingSeasonsString.split(',').filter(Boolean).map(Number) : [];
  const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
  // FIX: Corrected variable name from mergedLanguages to mergedSeasons
  await hset(movieKey, 'seasons', mergedSeasons.join(','));
}

/**
 * Periodically crawls new forum pages to discover new content.
 */
async function crawlNewPages(): Promise<void> {
  logger.info('Starting new page crawl...');
  let hasMorePages = true;
  let pageCounter = 1;

  while (hasMorePages && (config.INITIAL_PAGES === 0 || pageCounter <= config.INITIAL_PAGES)) {
    hasMorePages = await crawlForumPage(pageCounter);
    if (hasMorePages) {
      currentPage = pageCounter; // Update current page to the last successfully crawled page
      pageCounter++;
    } else {
      // If a page yields no new threads or an error, stop crawling newer pages.
      // Reset currentPage for the next run if it's the end of content.
      logger.info(`Ended new page crawl at page ${pageCounter}.`);
    }
  }
  logger.info('New page crawl finished.');
}

/**
 * Periodically re-visits existing threads to check for updates.
 * This function will fetch threads that were last updated X hours ago.
 */
async function revisitExistingThreads(): Promise<void> {
  logger.info('Starting existing thread revisit...');
  // Get all thread keys
  const threadKeys = await redisClient.keys('thread:*');

  const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000; // hours to ms
  const now = Date.now(); // Corrected from Date.Now()

  const threadsToRevisit: string[] = [];

  for (const key of threadKeys) {
    const threadData = await hgetall(key);
    if (threadData.timestamp) {
      const lastProcessedTime = new Date(threadData.timestamp).getTime();
      if (now - lastProcessedTime > revisitThreshold) {
        threadsToRevisit.push(threadData.url);
      }
    } else {
      // If timestamp is missing, it's an old entry or improperly stored, revisit it.
      if (threadData.url) {
        threadsToRevisit.push(threadData.url);
      }
    }
  }

  // Process threads to revisit with concurrency
  const processingPromises: Promise<void>[] = [];
  for (const threadUrl of threadsToRevisit) {
    processingPromises.push(
      (async () => {
        const processedData = await processThread(threadUrl);
        if (processedData) {
          await saveThreadData(processedData);
          const threadId = getUniqueThreadId(threadUrl); // Use the robust unique ID function
          await hmset(`thread:${threadId}`, {
            url: threadUrl,
            timestamp: new Date().toISOString(),
            status: 'processed'
          });
        }
      })()
    );
    if (processingPromises.length >= config.MAX_CONCURRENCY) {
      await Promise.all(processingPromises);
      processingPromises.length = 0;
    }
  }
  await Promise.all(processingPromises);
  logger.info(`Revisited ${threadsToRevisit.length} existing threads.`);
}

/**
 * Starts the main crawler loop.
 * This function initiates scheduled crawling for new pages and existing threads.
 */
export function startCrawler(): void {
  if (isCrawling) {
    logger.info('Crawler is already running.');
    return;
  }
  isCrawling = true;
  logger.info('Stremio Addon Crawler started.');

  // Initial crawl on startup
  (async () => {
    await crawlNewPages();
    await revisitExistingThreads();
  })();

  // Schedule new page crawls
  setInterval(async () => {
    logger.info('Scheduled crawl for new pages triggered.');
    await crawlNewPages();
  }, config.CRAWL_INTERVAL * 1000); // Convert seconds to milliseconds

  // Schedule existing thread revisits
  setInterval(async () => {
    logger.info('Scheduled revisit for existing threads triggered.');
    await revisitExistingThreads();
  }, config.THREAD_REVISIT_HOURS * 60 * 60 * 1000); // Convert hours to milliseconds
}
