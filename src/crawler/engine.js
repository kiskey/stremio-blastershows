const axios = require('axios');
const cheerio = require('cheerio');
const { config } = require('../config');
const redisClient = require('../redis'); // Import redisClient instance
// Corrected import: 'hgetall' now refers to the wrapper function exported by redis.js
const { hgetall, hset, hmset, zadd, zrangebyscore, del } = require('../redis');
const { processThread, getUniqueThreadId } = require('./processor'); // Ensure processThread is imported
const { logger } = require('../utils/logger');
const { normalizeTitle, parseTitle } = require('../parser/title'); // Added import for normalizeTitle and parseTitle

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
    
    // Use the imported hgetall from redis.js (which now calls redisClient.hgetall)
    const lastProcessed = await hgetall(`thread:${threadId}`); 
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
            await hmset(`thread:${processedData.threadId}`, {
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

  const normalizedTitle = normalizeTitle(title);
  const stremioMovieId = `tt${normalizedTitle}`;

  const movieKey = `movie:${stremioMovieId}`;
  await hmset(movieKey, {
    originalTitle: title,
    posterUrl: posterUrl,
    stremioId: stremioMovieId,
    lastUpdated: now.toISOString(),
    associatedThreadId: threadId,
    threadStartedTime: finalThreadStartedTime
  });
  logger.info(`Saved movie data for ${movieKey} (Stremio ID: ${stremioMovieId}, Started: ${finalThreadStartedTime})`);


  const { season, episodeStart, episodeEnd, languages } = parseTitle(title);

  let seasonNum = season || 1;
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
    const episodeKey = `episode:${stremioMovieId}:s${seasonNum}e${currentEpisodeNum}:${magnet.resolution || 'unknown'}:${infoHash}`;

    await hmset(episodeKey, {
      infoHash: infoHash,
      sources: JSON.stringify(cachedBestTrackers),
      name: streamName,
      title: streamTitle,
      size: magnet.size || '',
      resolution: magnet.resolution || '',
      timestamp: now.toISOString(),
      threadUrl: originalUrl,
      stremioMovieId: stremioMovieId
    });
    logger.info(`Saved stream data for ${episodeKey} (InfoHash: ${infoHash.substring(0, 10)}..., Name: "${streamName}", Title: "${streamTitle}")`);
  }

  if (languages && languages.length > 0) {
    const existingLanguagesString = await hgetall(movieKey).then(data => data.languages);
    const existingLanguages = existingLanguagesString ? existingLanguagesString.split(',') : [];
    const mergedLanguages = Array.from(new Set([...existingLanguages, ...languages]));
    await hset(movieKey, 'languages', mergedLanguages.join(','));
  }

  const existingSeasonsString = await hgetall(movieKey).then(data => data.seasons);
  const existingSeasons = existingSeasonsString ? existingSeasonsString.split(',').filter(Boolean).map(Number) : [];
  const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
  await hset(movieKey, 'seasons', mergedSeasons.join(','));
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
    // Use the imported hgetall from redis.js
    const threadData = await hgetall(key);
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
    await fetchAndCacheBestTrackers();
    await crawlNewPages();
    await revisitExistingThreads();
  })();

  setInterval(async () => {
    logger.info('Scheduled crawl for new pages triggered.');
    await crawlNewPages();
  }, config.CRAWL_INTERVAL * 1000);

  setInterval(async () => {
    logger.info('Scheduled revisit for existing threads triggered.');
    await revisitExistingThreads();
  }, config.THREAD_REVISIT_HOURS * 60 * 60 * 1000);

  setInterval(async () => {
    logger.info('Scheduled best trackers update triggered.');
    await fetchAndCacheBestTrackers();
  }, config.TRACKER_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000);
}

module.exports = {
  startCrawler,
};
