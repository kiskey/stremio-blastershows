import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../config'; // Import config to access new tracker settings
import redisClient, { hgetall, hset, hmset, zadd, zrangebyscore, del } from '../redis';
import { processThread } from './processor'; // Ensure processThread is imported
import { logger } from '../utils/logger';
import { 
  normalizeTitle, 
  parseTitle, 
  fuzzyMatch, 
  cleanBaseTitleForCatalog, 
  cleanStreamDetailsTitle // Import the updated cleanStreamDetailsTitle
} from '../parser/title';

/**
 * Interface for MagnetData as specified in requirements.
 * Now includes resolution and size for each magnet.
 */
export interface MagnetData {
  url: string;
  name: string; // Full descriptive name from ipsAttachLink_title or magnet DN
  size?: string;
  resolution?: string; // Add resolution here
  parsedMetadata?: any; // NEW: Added parsedMetadata from title.js
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

// Global variables for best trackers caching
let cachedBestTrackers: string[] = [];
let lastTrackerUpdate: number = 0; // Timestamp of the last successful update in milliseconds

/**
 * Fetches the content of a given URL.
 * Implements exponential backoff for failed requests and User-Agent rotation (simple).
 * @param url The URL to fetch.
 * @param retries Remaining retries.
 * @returns The HTML content as a string, or null if fetching fails.
 */
async function fetchHtml(url, retries = 3) {
  // Simple User-Agent rotation (for a more robust solution, use a list of UAs)
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari:605.1.15',
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
  } catch (error) {
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
function discoverThreadUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const uniqueThreadUrls = new Set(); // Use a Set to ensure uniqueness

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
 * Extracts the 40-character BTIH (BitTorrent Info Hash) from a magnet URI.
 * This is a helper function to ensure a consistent way to get BTIH from a magnet URI string.
 * This function is now also present in processor.ts, but kept here for local usage if needed.
 * @param magnetUri The magnet URI string.
 * @returns The 40-character BTIH as a string, or null if not found/invalid.
 */
function extractBtihFromMagnet(magnetUri) {
  const match = magnetUri.match(/urn:btih:([a-zA-Z0-9]{40})/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

/**
 * Fetches the best trackers from ngosang's list and caches them.
 * This function is modified to ensure explicit type handling for compiler stability.
 */
async function fetchAndCacheBestTrackers() {
  const now = Date.now();
  const updateIntervalMs = config.TRACKER_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;

  if (now - lastTrackerUpdate < updateIntervalMs && cachedBestTrackers.length > 0) {
    logger.info('Using cached best trackers. Next update scheduled.');
    return;
  }

  logger.info('Fetching latest best trackers...');
  try {
    const response = await axios.get(config.NGOSANG_TRACKERS_URL);
    // Trackers are typically newline-separated
    const rawTrackers = response.data.split('\n');

    // Process and format trackers with explicit type filtering
    const formattedTrackers = rawTrackers
      .map((t) => t.trim()) // Trim whitespace from each tracker
      .filter((tracker) => !!tracker) // Explicitly filter out empty strings and assert type
      .map((tracker) => `tracker:${tracker}`); // Format as 'tracker:<URL>'
    
    cachedBestTrackers = formattedTrackers;
    lastTrackerUpdate = now;
    logger.info(`Successfully fetched and cached ${cachedBestTrackers.length} best trackers.`);
  } catch (error) {
    logger.error(`Failed to fetch best trackers from ${config.NGOSANG_TRACKERS_URL}:`, error);
    logger.logToRedisErrorQueue({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Failed to fetch best trackers`,
      error: error.message,
      url: config.NGOSANG_TRACKERS_URL
    });
  }
}


/**
 * Crawls a single forum page to discover new threads.
 * @param pageNum The page number to crawl.
 * @returns True if the page was successfully crawled and new threads were found, false otherwise.
 */
async function crawlForumPage(pageNum) {
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
  const processingPromises = [];
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
      // Basic concurrency concurrency control (can be enhanced with a proper queue/worker pool)
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
 * Saves processed thread data into Redis according to the defined schema.
 * Updated to use infoHash and sources for Stremio stream objects.
 * @param data The processed thread content.
 */
async function saveThreadData(data) {
  // Destructure relevant fields, including initialThreadStartedTime for type guarding
  const { title, posterUrl, magnets, timestamp, threadId, originalUrl, threadStartedTime: initialThreadStartedTime } = data;
  
  // Explicitly ensure threadStartedTime is a string, providing a fallback.
  // This robust type guard ensures 'finalThreadStartedTime' is always of type 'string' at compile time.
  let finalThreadStartedTime;
  if (typeof initialThreadStartedTime === 'string') {
    finalThreadStartedTime = initialThreadStartedTime;
  } else {
    logger.warn(`threadStartedTime was unexpectedly not a string for threadId ${threadId}. Using current timestamp as fallback.`);
    finalThreadStartedTime = new Date().toISOString(); 
  }
  
  const now = new Date();

  // Using the title parser to get more structured data (season, episode, etc.) from overall thread title
  const parsedThreadTitleMetadata = parseTitle(title);
  const { 
    baseShowName, 
    year: threadYear, 
    season: threadSeason, 
    episodeStart: threadEpisodeStart, 
    episodeEnd: threadEpisodeEnd,
    languages: threadLanguages
  } = parsedThreadTitleMetadata;

  const yearNum = threadYear || new Date(finalThreadStartedTime).getFullYear(); // Fallback to thread start year if no year parsed
  const seasonNum = threadSeason || 1; // Default to Season 1 if not parsed

  // --- Create/Update "Movie Group" Catalog Entry (represents Series-Season) ---
  // The originalTitle for the catalog item should be "Base Title (Year) SXX"
  const cleanedBaseCatalogTitle = cleanBaseTitleForCatalog(baseShowName, yearNum, seasonNum);
  const normalizedBaseCatalogId = normalizeTitle(cleanedBaseCatalogTitle);
  // This ID is for the catalog item itself, which groups streams
  const stremioMovieGroupId = `tt${normalizedBaseCatalogId}`; 

  const movieKey = `movie:${stremioMovieGroupId}`; // Redis key for the movie group entry

  // Log the identified Movie Key for Catalog
  logger.info(`Identified Movie Key for Catalog: ${movieKey} (Cleaned Title: "${cleanedBaseCatalogTitle}")`);

  try {
    const existingMovieGroupData = await hgetall(movieKey);
    // Only create/update if new or strong fuzzy match for the base title
    if (!existingMovieGroupData || fuzzyMatch(cleanedBaseCatalogTitle, existingMovieGroupData.originalTitle || '', 0.9)) { 
        await hmset(movieKey, {
            originalTitle: cleanedBaseCatalogTitle, // The cleaned series-season title
            posterUrl: posterUrl,
            stremioId: stremioMovieGroupId, // The ID Stremio will use for meta/stream requests
            lastUpdated: now.toISOString(),
            associatedThreadId: threadId, // Link back to the original threadId
            threadStartedTime: finalThreadStartedTime,
            languages: JSON.stringify(threadLanguages),
            seasons: JSON.stringify([seasonNum]), // Store seasons as array
        });
        logger.info(`Created/Updated movie group data for ${movieKey} (ID: ${stremioMovieGroupId}, Title: "${cleanedBaseCatalogTitle}")`);
    } else {
        // Just update lastUpdated if not a new entry or significant change
        await hset(movieKey, 'lastUpdated', now.toISOString());
        logger.info(`Updated existing movie group data timestamp for ${movieKey}.`);
    }
  } catch (error) {
      logger.error(`Error saving movie group data for ${movieKey}:`, error);
      logger.logToRedisErrorQueue({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          message: `Error saving movie group data for key: ${movieKey}`,
          error: error.message,
          url: originalUrl
      });
  }

  // --- Process and save each magnet as a distinct "stream_data" entry ---
  for (let i = 0; i < magnets.length; i++) {
    const magnet = magnets[i];
    if (!magnet || !magnet.url) {
      logger.warn(`Skipping magnet at index ${i} for thread ${threadId} due to missing URL.`);
      continue;
    }

    const infoHash = extractBtihFromMagnet(magnet.url);
    if (!infoHash) {
      logger.warn(`Could not extract BTIH from magnet URL: ${magnet.url}. Skipping stream for thread ${threadId}.`);
      logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: `Magnet URL without BTIH: ${magnet.url}`,
        url: originalUrl
      });
      continue;
    }

    // NEW: Use the parsedMetadata from the magnet itself for stream title and episode number
    const parsedMagnetMetadata = magnet.parsedMetadata;
    let currentEpisodeNum = parsedMagnetMetadata.episodeStart || (threadEpisodeStart !== undefined ? (threadEpisodeStart + i) : 1);
    if (!parsedMagnetMetadata.episodeStart && !threadEpisodeStart && magnets.length > 1) {
        // Fallback to sequential if no episode info found in magnet or thread
        currentEpisodeNum = i + 1;
    }
    
    // Generate streamName and streamTitle using the specific cleaning functions
    // streamName for Stremio UI (e.g., "TamilShows - 720p HD")
    const streamName = `TamilShows - ${parsedMagnetMetadata.resolutions[0] || 'Unknown'}${parsedMagnetMetadata.qualityTags.length > 0 ? ' ' + parsedMagnetMetadata.qualityTags[0].toUpperCase() : ''}`; 
    // streamTitle for Stremio UI (e.g., "Beast Games S01 EP10 - HQ")
    const streamTitle = cleanStreamDetailsTitle(parsedMagnetMetadata); 

    // The unique ID for this specific stream, linked to the movie_group ID
    const streamId = `${stremioMovieGroupId}:s${seasonNum}e${currentEpisodeNum}:${normalizeTitle(parsedMagnetMetadata.resolutions[0] || 'unknown')}:${infoHash}`;
    const streamDataKey = `stream:${streamId}`; // Redis key for the individual stream data

    // Log the stream identified by the fuzzy logic (this is the streamKey)
    logger.info(`Identified Stream Key: ${streamDataKey} (Stream Title: "${streamTitle}")`);

    try {
        await hmset(streamDataKey, {
          parentMovieId: stremioMovieGroupId, // Link back to parent movie group ID
          infoHash: infoHash,
          sources: JSON.stringify(cachedBestTrackers),
          name: streamName, 
          title: streamTitle, 
          size: magnet.size || '', 
          resolution: magnet.resolution || '', 
          timestamp: now.toISOString(),
          threadUrl: originalUrl,
          languages: JSON.stringify(parsedMagnetMetadata.languages), // Use languages from magnet's metadata
          qualityTags: JSON.stringify(parsedMagnetMetadata.qualityTags), // Use qualityTags from magnet's metadata
          codecs: JSON.stringify(parsedMagnetMetadata.codecs),
          audioCodecs: JSON.stringify(parsedMagnetMetadata.audioCodecs),
          hasESub: parsedMagnetMetadata.hasESub ? 'true' : 'false',
          episodeNumber: currentEpisodeNum.toString(),
          seasonNumber: seasonNum.toString(),
        });
        logger.info(`Saved stream data for ${streamDataKey} (Parent ID: ${stremioMovieGroupId}, Stream Title: "${streamTitle}")`);
    } catch (error) {
        logger.error(`Error saving stream data for ${streamDataKey}:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error saving stream data for key: ${streamDataKey}`,
            error: error.message,
            url: originalUrl
        });
    }
  }

  // Update languages for the movie hash if new languages are found
  if (parsedThreadTitleMetadata.languages && parsedThreadTitleMetadata.languages.length > 0) {
    const existingLanguagesString = await hgetall(movieKey).then(data => data.languages);
    const existingLanguages = existingLanguagesString ? JSON.parse(existingLanguagesString) : [];
    const mergedLanguages = Array.from(new Set([...existingLanguages, ...parsedThreadTitleMetadata.languages]));
    await hset(movieKey, 'languages', JSON.stringify(mergedLanguages));
  }

  // Update seasons field in movie hash to record discovered seasons
  const existingSeasonsString = await hgetall(movieKey).then(data => data.seasons);
  const existingSeasons = existingSeasonsString ? JSON.parse(existingSeasonsString) : [];
  const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
  await hset(movieKey, 'seasons', JSON.stringify(mergedSeasons));
}

/**
 * Periodically crawls new forum pages to discover new content.
 */
async function crawlNewPages() {
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
async function revisitExistingThreads() {
  logger.info('Starting existing thread revisit...');
  // Get all thread keys
  const threadKeys = await redisClient.keys('thread:*');

  const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000; // hours to ms
  const now = Date.now(); 

  const threadsToRevisit = [];

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
  const processingPromises = [];
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
export function startCrawler() {
  if (isCrawling) {
    logger.info('Crawler is already running.');
    return;
  }
  isCrawling = true;
  logger.info('Stremio Addon Crawler started.');

  // Initial fetch and schedule for best trackers
  (async () => {
    await fetchAndCacheBestTrackers(); // Fetch trackers on startup
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

  // Schedule periodic tracker updates
  setInterval(async () => {
    logger.info('Scheduled best trackers update triggered.');
    await fetchAndCacheBestTrackers();
  }, config.TRACKER_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000); // Convert hours to milliseconds
}
