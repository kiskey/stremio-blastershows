const axios = require('axios');
const cheerio = require('cheerio');
const { config } = require('../config');
const redisClient = require('../redis'); // Import redisClient instance directly
const { processThread, getUniqueThreadId } = require('./processor');
const { logger } = require('../utils/logger');
const { normalizeTitle, parseTitle } = require('../parser/title');

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

// Global variable to hold the current page number for new content crawling
let currentPage = 1;
let isCrawling = false; // Flag to prevent multiple concurrent crawls

// Global variables for best trackers caching
let cachedBestTrackers = [];
let lastTrackerUpdate = 0; // Timestamp of the last successful update in milliseconds

/**
 * Fetches the content of a given URL.
 * @param {string} url The URL to fetch.
 * @param {number} [retries=3] Remaining retries.
 * @returns {Promise<string|null>} The HTML content as a string, or null if fetching fails.
 */
async function fetchHtml(url, retries = 3) {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.5 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15',
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
      validateStatus: (status) => status >= 200 && status < 400
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
    const response = await axios.get(config.NGOSANG_TRACKERS_URL);
    const rawTrackers = response.data.split('\n');

    const formattedTrackers = rawTrackers
      .map(t => t.trim())
      .filter(tracker => !!tracker) // Ensure tracker is not empty string
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
  if (!html) {
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
        // Direct call to redisClient.hgetall
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
                // Direct call to redisClient.hmset
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
 * @param {ThreadContent} data The processed thread content.
 * @returns {Promise<void>}
 */
async function saveThreadData(data) {
  const { title, posterUrl, magnets, timestamp, threadId, originalUrl, threadStartedTime: initialThreadStartedTime } = data;
  
  let finalThreadStartedTime;
  if (typeof initialThreadStartedTime === 'string') {
    finalThreadStartedTime = initialThreadStartedTime;
  } else {
    logger.warn(`threadStartedTime was unexpectedly not a string for threadId ${threadId}. Using current timestamp as fallback.`);
    finalThreadStartedTime = new Date().toISOString(); 
  }
  
  const now = new Date();

  // Parse title to get season, year, and languages for standardized ID
  const { season, languages } = parseTitle(title);
  const year = new Date(finalThreadStartedTime).getFullYear();
  const seasonNum = season || 1; // Default to Season 1 if not parsed

  // Standardized Stremio Movie ID: tt<normalizedTitle>-<year>-s<seasonNum>
  // This ensures unique catalog entries for each series/season combination
  const standardizedTitle = normalizeTitle(title);
  const stremioMovieId = `tt${standardizedTitle}-${year}-s${seasonNum}`;


  const movieKey = `movie:${stremioMovieId}`;
  try {
    // Direct call to redisClient.hmset
    await redisClient.hmset(movieKey, {
      originalTitle: title,
      posterUrl: posterUrl,
      stremioId: stremioMovieId, // Store the standardized Stremio ID
      lastUpdated: now.toISOString(),
      associatedThreadId: threadId,
      threadStartedTime: finalThreadStartedTime
    });
    logger.info(`Saved movie data for ${movieKey} (Stremio ID: ${stremioMovieId}, Started: ${finalThreadStartedTime})`);
  } catch (error) {
    logger.error(`Error saving movie data for ${movieKey}:`, error);
    logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Error saving movie data for key: ${movieKey}`,
        error: error.message,
        url: originalUrl
    });
  }


  // Use parseTitle again for episode details specifically, as it returns episodeStart/End
  const { episodeStart, episodeEnd } = parseTitle(title);
  let episodeCount = (episodeStart !== undefined && episodeEnd !== undefined) ? (episodeEnd - episodeStart + 1) : 1;

  for (let i = 0; i < magnets.length; i++) {
    const magnet = magnets[i];
    if (!magnet || !magnet.url) {
      logger.warn(`Skipping magnet at index ${i} for thread ${threadId} due to missing URL.`);
      continue;
    }

    const infoHash = extractBtihFromMagnet(magnet.url);
    if (!infoHash) {
      logger.warn(`Could not extract BTIH from magnet URL: ${magnet.url}. Skipping stream for thread ${threadId}.`);
      continue;
    }

    const streamName = `TamilShow - ${magnet.resolution || 'Unknown'}`;
    const streamTitle = `${title} | ${magnet.resolution || 'Unknown'} | ${magnet.size || 'Unknown Size'}`;

    const currentEpisodeNum = (episodeStart || 1) + (i % episodeCount);
    // Episode keys include the full standardized stremioMovieId, season, episode, resolution, and infoHash
    const episodeKey = `episode:${stremioMovieId}:s${seasonNum}e${currentEpisodeNum}:${magnet.resolution || 'unknown'}:${infoHash}`;

    try {
        // Direct call to redisClient.hmset
        await redisClient.hmset(episodeKey, {
          infoHash: infoHash,
          sources: JSON.stringify(cachedBestTrackers),
          name: streamName,
          title: streamTitle,
          size: magnet.size || '',
          resolution: magnet.resolution || '',
          timestamp: now.toISOString(),
          threadUrl: originalUrl,
          stremioMovieId: stremioMovieId // Link back to the standardized movie ID
        });
        logger.info(`Saved stream data for ${episodeKey} (InfoHash: ${infoHash.substring(0, 10)}..., Name: "${streamName}", Title: "${streamTitle}")`);
    } catch (error) {
        logger.error(`Error saving stream data for ${episodeKey}:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error saving stream data for key: ${episodeKey}`,
            error: error.message,
            url: originalUrl
        });
    }
  }

  try {
    if (languages && languages.length > 0) {
      // Direct call to redisClient.hgetall and redisClient.hset
      const existingLanguagesString = await redisClient.hgetall(movieKey).then(data => data.languages);
      const existingLanguages = existingLanguagesString ? existingLanguagesString.split(',') : [];
      const mergedLanguages = Array.from(new Set([...existingLanguages, ...languages]));
      await redisClient.hset(movieKey, 'languages', mergedLanguages.join(','));
    }
  } catch (error) {
    logger.error(`Error updating languages for movie ${movieKey}:`, error);
    logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Error updating languages for movie: ${movieKey}`,
        error: error.message,
        url: originalUrl
    });
  }

  try {
    // Direct call to redisClient.hgetall and redisClient.hset
    const existingSeasonsString = await redisClient.hgetall(movieKey).then(data => data.seasons);
    const existingSeasons = existingSeasonsString ? existingSeasonsString.split(',').filter(Boolean).map(Number) : [];
    // Ensure seasonNum is added to existing seasons and sort
    const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
    await redisClient.hset(movieKey, 'seasons', mergedSeasons.join(','));
  } catch (error) {
    logger.error(`Error updating seasons for movie ${movieKey}:`, error);
    logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Error updating seasons for movie: ${movieKey}`,
        error: error.message,
        url: originalUrl
    });
  }
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
  try {
    // Direct call to redisClient.keys
    const threadKeys = await redisClient.keys('thread:*');

    const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000;
    const now = Date.now(); 

    const threadsToRevisit = [];

    for (const key of threadKeys) {
      try {
        // Direct call to redisClient.hgetall
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
      } catch (error) {
        logger.error(`Error fetching thread data for key ${key} during revisit check:`, error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: `Error fetching thread data for key ${key} during revisit check`,
            error: error.message,
            url: key // Using key as URL context
        });
      }
    }

    const processingPromises = [];
    for (const threadUrl of threadsToRevisit) {
      processingPromises.push(
        (async () => {
          try {
            const processedData = await processThread(threadUrl);
            if (processedData) {
              await saveThreadData(processedData);
              // Direct call to redisClient.hmset
              await redisClient.hmset(`thread:${processedData.threadId}`, {
                url: threadUrl,
                timestamp: new Date().toISOString(),
                status: 'processed'
              });
            }
          } catch (error) {
            logger.error(`Error processing revisited thread ${threadUrl}:`, error);
            logger.logToRedisErrorQueue({
                timestamp: new Date().toISOString(),
                level: 'ERROR',
                message: `Error processing revisited thread: ${threadUrl}`,
                error: error.message,
                url: threadUrl
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
  } catch (error) {
    logger.error('Error in revisitExistingThreads:', error);
    logger.logToRedisErrorQueue({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: 'Error in revisitExistingThreads',
        error: error.message
    });
  }
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

  // Initial calls wrapped in an async IIFE to ensure they are awaited
  (async () => {
    try {
        if (config.PURGE_ON_START) { // Only purge if PURGE_ON_START is true
            await redisClient.purgeRedis(); // Assuming purgeRedis is still exported directly from redis.js
        }
        await fetchAndCacheBestTrackers();
        await crawlNewPages();
        await revisitExistingThreads();
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

  // Schedule new page crawls
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

  // Schedule existing thread revisits
  setInterval(async () => {
    logger.info('Scheduled revisit for existing threads triggered.');
    try {
        await revisitExistingThreads();
    } catch (error) { // Added missing catch block
        logger.error('Error during scheduled revisit of existing threads:', error);
        logger.logToRedisErrorQueue({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Error during scheduled revisit of existing threads',
            error: error.message
        });
    }
  }, config.THREAD_REVISIT_HOURS * 60 * 60 * 1000);

  // Schedule periodic tracker updates
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
};
