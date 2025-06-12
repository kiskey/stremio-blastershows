const axios = require('axios');
const cheerio = require('cheerio');
const { config } = require('../config.js'); // Use .js extension
const redisClient = require('../redis.js'); // Use .js extension; this is the primary Redis client export
const { processThread } = require('./processor.js'); // Use .js extension for local files
const { logger } = require('../utils/logger.js'); // Use .js extension
const { 
  normalizeTitle, 
  parseTitle, 
  fuzzyMatch, 
  cleanBaseTitleForCatalog, 
  cleanStreamDetailsTitle 
} = require('../parser/title.js'); // Use .js extension

/**
 * @typedef {object} MagnetData
 * @property {string} url
 * @property {string} name
 * @property {string} [size]
 * @property {string} [resolution]
 * @property {object} [parsedMetadata]
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

// Global variable to hold the current page number for new content crawling
let currentPage = 1;
let isCrawling = false; // Flag to prevent multiple concurrent crawls

// Global variables for best trackers caching
let cachedBestTrackers = [];
let lastTrackerUpdate = 0; // Timestamp of the last successful update in milliseconds

/**
 * Extracts a unique numerical thread ID from a forum topic URL.
 * Handles URLs like: https://www.1tamilblasters.fi/index.php?/forums/topic/133067-mercy-for-none-s01-...
 * Moved here to be the single source of truth for thread ID generation, used by both engine and processor.
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
 * Fetches the content of a given URL.
 * @param {string} url The URL to fetch.
 * @param {number} [retries=3] Remaining retries.
 * @returns {Promise<string|null>} The HTML content as a string, or null if fetching fails.
 */
async function fetchHtml(url, retries = 3) {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.5 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari:605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:98.0) Gecko/20100101 Firefox/98.0',
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  await new Promise(resolve => setTimeout(resolve, 250));

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br'
      },
      maxRedirects: 10,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 15000 // Added a 15-second timeout for HTML fetches
    });

    if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
            logger.warn(`Redirect detected from ${url} to ${redirectUrl}.`);
        }
    }
    return response.data;
  } catch (error) {
    logger.error(`Error fetching ${url}:`, error);
    if (retries > 0) {
      const delay = Math.pow(2, (3 - retries)) * 1000;
      logger.info(`Retrying ${url} in ${delay / 1000} seconds... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchHtml(url, retries - 1);
    }
    logger.error(`Failed to fetch ${url} after multiple retries.`);
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
 * @param {string} html The HTML content of the forum page.
 * @param {string} baseUrl The base URL to resolve relative links.
 * @returns {string[]} An array of discovered unique thread URLs relevant for processing.
 */
function discoverThreadUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const uniqueThreadUrls = new Set();

  $('a[data-ipshover]').each((index, element) => {
    const href = $(element).attr('href');
    if (href) {
      const absoluteUrl = new URL(href, baseUrl).href;
      if (absoluteUrl.includes('/forums/topic/') && !absoluteUrl.includes('/profile/')) {
        uniqueThreadUrls.add(absoluteUrl);
      } else {
        logger.debug(`Ignoring URL: ${absoluteUrl} (not a topic or is a profile page)`);
      }
    }
  });
  return Array.from(uniqueThreadUrls);
}

/**
 * Fetches the best trackers from ngosang's list and caches them.
 * @returns {Promise<void>}
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
    const response = await axios.get(config.NGOSANG_TRACKERS_URL, {
        timeout: 15000 // Added a 15-second timeout for tracker fetch
    });
    const rawTrackers = response.data.split('\n');

    const formattedTrackers = rawTrackers
      .map(t => t.trim())
      .filter(tracker => !!tracker)
      .map(tracker => `tracker:${tracker}`);
    
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
 * @param {number} pageNum The page number to crawl.
 * @returns {Promise<boolean>} True if the page was successfully crawled and new threads were found, false otherwise.
 */
async function crawlForumPage(pageNum) {
  const url = `${config.FORUM_URL}${pageNum > 1 ? `page/${pageNum}/` : ''}`;
  logger.info(`Crawling forum page: ${url}`);

  const html = await fetchHtml(url);
  if (html) {
    logger.info(`Successfully fetched HTML for page ${pageNum}.`);
  } else {
    logger.warn(`Could not fetch HTML for page ${pageNum}. Assuming end of pagination.`);
    return false;
  }

  const threadUrls = discoverThreadUrls(html, url);
  logger.info(`Discovered ${threadUrls.length} relevant threads on page ${pageNum}.`);

  if (threadUrls.length === 0) {
    logger.info(`No new relevant threads found on page ${pageNum}. Ending new page crawl.`);
    return false;
  }

  const processingPromises = [];
  for (const threadUrl of threadUrls) {
    const threadId = getUniqueThreadId(threadUrl);
    
    try {
        const lastProcessed = await redisClient.hgetall(`thread:${threadId}`); 
        const now = new Date().toISOString();

        const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000;
        const lastModifiedTimestamp = lastProcessed.timestamp ? new Date(lastProcessed.timestamp).getTime() : 0;

        if (!lastProcessed.timestamp || (Date.now() - lastModifiedTimestamp) > revisitThreshold) {
          logger.info(`Processing new or updated thread: ${threadUrl}`);
          processingPromises.push(
            (async () => {
              const processedData = await processThread(threadUrl);
              if (processedData) {
                await saveThreadData(processedData);
                await redisClient.hmset(`thread:${processedData.threadId}`, {
                  url: threadUrl,
                  timestamp: now,
                  status: 'processed'
                });
              }
            })()
          );
          if (processingPromises.length >= config.MAX_CONCURRENCY) {
            await Promise.all(processingPromises);
            processingPromises.length = 0;
          }
        } else {
          logger.info(`Thread ${threadUrl} recently processed. Skipping.`);
        }
    } catch (error) {
        logger.error(`Error checking/processing thread ${threadUrl}:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error in crawlForumPage for thread: ${threadUrl}`,
            error: error.message,
            url: threadUrl
        });
    }
  }

  await Promise.all(processingPromises);
  return threadUrls.length > 0;
}

/**
 * Saves processed thread data into Redis according to the defined schema.
 * This function now groups streams under a series-season "movie" entry.
 * @param {ThreadContent} data The processed thread content.
 * @returns {Promise<void>}
 */
async function saveThreadData(data) {
  const { title, posterUrl, magnets, threadId, originalUrl, threadStartedTime: initialThreadStartedTime } = data;
  
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
    languages: threadLanguages
  } = parsedThreadTitleMetadata;

  const yearNum = threadYear || new Date(finalThreadStartedTime).getFullYear();
  const seasonNum = threadSeason || 1;

  // --- Create/Update "Movie Group" Catalog Entry (represents Series-Season) ---
  const cleanedBaseCatalogTitle = cleanBaseTitleForCatalog(baseShowName, yearNum, seasonNum);
  const normalizedBaseCatalogId = normalizeTitle(cleanedBaseCatalogTitle);
  const stremioMovieGroupId = `tt${normalizedBaseCatalogId}`; 

  const movieKey = `movie:${stremioMovieGroupId}`;

  logger.info(`Identified Movie Key for Catalog: ${movieKey} (Cleaned Title: "${cleanedBaseCatalogTitle}")`);

  try {
    const existingMovieGroupData = await redisClient.hgetall(movieKey);
    if (!existingMovieGroupData || fuzzyMatch(cleanedBaseCatalogTitle, existingMovieGroupData.originalTitle || '', 0.9)) { 
        await redisClient.hmset(movieKey, {
            originalTitle: cleanedBaseCatalogTitle,
            posterUrl: posterUrl,
            stremioId: stremioMovieGroupId,
            lastUpdated: now.toISOString(),
            associatedThreadId: threadId,
            threadStartedTime: finalThreadStartedTime,
            languages: JSON.stringify(threadLanguages),
            seasons: JSON.stringify([seasonNum]),
        });
        logger.info(`Created/Updated movie group data for ${movieKey} (ID: ${stremioMovieGroupId}, Title: "${cleanedBaseCatalogTitle}")`);
    } else {
        await redisClient.hset(movieKey, 'lastUpdated', now.toISOString());
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

    const parsedMagnetMetadata = magnet.parsedMetadata;
    let currentEpisodeNum = parsedMagnetMetadata.episodeStart || (parsedThreadTitleMetadata.episodeStart !== undefined ? (parsedThreadTitleMetadata.episodeStart + i) : 1);
    if (!parsedMagnetMetadata.episodeStart && !parsedThreadTitleMetadata.episodeStart && magnets.length > 1) {
        currentEpisodeNum = i + 1;
    }
    
    const streamName = `TamilShows - ${parsedMagnetMetadata.resolutions[0] || 'Unknown'}${parsedMagnetMetadata.qualityTags.length > 0 ? ' ' + parsedMagnetMetadata.qualityTags[0].toUpperCase() : ''}`; 
    const streamTitle = cleanStreamDetailsTitle(parsedMagnetMetadata); 

    const streamId = `${stremioMovieGroupId}:s${seasonNum}e${currentEpisodeNum}:${normalizeTitle(parsedMagnetMetadata.resolutions[0] || 'unknown')}:${infoHash}`;
    const streamDataKey = `stream:${streamId}`;

    logger.info(`Identified Stream Key: ${streamDataKey} (Stream Title: "${streamTitle}")`);

    try {
        await redisClient.hmset(streamDataKey, {
          parentMovieId: stremioMovieGroupId,
          infoHash: infoHash,
          sources: JSON.stringify(cachedBestTrackers),
          name: streamName, 
          title: streamTitle, 
          size: magnet.size || '', 
          resolution: magnet.resolution || '', 
          timestamp: now.toISOString(),
          threadUrl: originalUrl,
          languages: JSON.stringify(parsedMagnetMetadata.languages),
          qualityTags: JSON.stringify(parsedMagnetMetadata.qualityTags),
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

  if (parsedThreadTitleMetadata.languages && parsedThreadTitleMetadata.languages.length > 0) {
    const existingLanguagesString = await redisClient.hgetall(movieKey).then(data => data.languages);
    const existingLanguages = existingLanguagesString ? JSON.parse(existingLanguagesString) : [];
    const mergedLanguages = Array.from(new Set([...existingLanguages, ...parsedThreadTitleMetadata.languages]));
    await redisClient.hset(movieKey, 'languages', JSON.stringify(mergedLanguages));
  }

  const existingSeasonsString = await redisClient.hgetall(movieKey).then(data => data.seasons);
  const existingSeasons = existingSeasonsString ? JSON.parse(existingSeasonsString) : [];
  const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
  await redisClient.hset(movieKey, 'seasons', JSON.stringify(mergedSeasons));
}

/**
 * Periodically crawls new forum pages to discover new content.
 * @returns {Promise<void>}
 */
async function crawlNewPages() {
  logger.info('Starting new page crawl...');
  let hasMorePages = true;
  let pageCounter = 1;

  while (hasMorePages && (config.INITIAL_PAGES === 0 || pageCounter <= config.INITIAL_PAGES)) {
    hasMorePages = await crawlForumPage(pageCounter);
    if (hasMorePages) {
      currentPage = pageCounter;
      pageCounter++;
    } else {
      logger.info(`Ended new page crawl at page ${pageCounter}.`);
    }
  }
  logger.info('New page crawl finished.');
}

/**
 * Periodically re-visits existing threads to check for updates.
 * @returns {Promise<void>}
 */
async function revisitExistingThreads() {
  logger.info('Starting existing thread revisit...');
  const threadKeys = await redisClient.keys('thread:*');

  const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000;
  const now = Date.now(); 

  const threadsToRevisit = [];

  for (const key of threadKeys) {
    const threadData = await redisClient.hgetall(key);
    if (threadData.timestamp) {
      const lastProcessedTime = new Date(threadData.timestamp).getTime();
      if (now - lastProcessedTime > revisitThreshold) {
        threadsToRevisit.push(threadData.url);
      }
    } else {
      if (threadData.url) {
        threadsToRevisit.push(threadData.url);
      }
    }
  }

  const processingPromises = [];
  for (const threadUrl of threadsToRevisit) {
    processingPromises.push(
      (async () => {
        const processedData = await processThread(threadUrl);
        if (processedData) {
          await saveThreadData(processedData);
          const threadId = getUniqueThreadId(threadUrl);
          await redisClient.hmset(`thread:${threadId}`, {
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
 * @returns {void}
 */
function startCrawler() {
  if (isCrawling) {
    logger.info('Crawler is already running.');
    return;
  }
  isCrawling = true;
  logger.info('Stremio Addon Crawler started.');

  (async () => {
    try {
        if (config.PURGE_ON_START) { 
            logger.info('Initiating Redis purge...');
            await redisClient.purgeRedis(); // Call purgeRedis as a method on the client
            logger.info('Redis purge completed.');
        }
        logger.info('Starting initial fetch and cache of best trackers...');
        await fetchAndCacheBestTrackers();
        logger.info('Initial fetch and cache of best trackers completed.');

        logger.info('Starting initial new page crawl...');
        await crawlNewPages();
        logger.info('Initial new page crawl completed.');

        logger.info('Starting initial revisit of existing threads...');
        await revisitExistingThreads();
        logger.info('Initial revisit of existing threads completed.');

    } catch (error) {
        logger.error('Error during initial crawler startup:', error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Error during initial crawler startup',
            error: error.message
        });
    }
  })();

  setInterval(async () => {
    logger.info('Scheduled crawl for new pages triggered.');
    try {
        await crawlNewPages();
    } catch (error) {
        logger.error('Error during scheduled new page crawl:', error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Error during scheduled new page crawl',
            error: error.message
        });
    }
  }, config.CRAWL_INTERVAL * 1000);

  setInterval(async () => {
    logger.info('Scheduled revisit for existing threads triggered.');
    try {
        await revisitExistingThreads();
    } catch (error) {
        logger.error('Error during scheduled revisit of existing threads:', error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Error during scheduled revisit of existing threads',
            error: error.message
        });
    }
  }, config.THREAD_REVISIT_HOURS * 60 * 60 * 1000);

  setInterval(async () => {
    logger.info('Scheduled best trackers update triggered.');
    try {
        await fetchAndCacheBestTrackers();
    } catch (error) {
        logger.error('Error during scheduled best trackers update:', error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Error during scheduled best trackers update',
            error: error.message
        });
    }
  }, config.TRACKER_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000);
}

module.exports = {
  startCrawler,
  getUniqueThreadId // Export getUniqueThreadId for use in processor.js
};
