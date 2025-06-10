import axios from 'axios';
import cheerio from 'cheerio';
import { config } from '../config';
import redisClient, { hgetall, hset, hmset, zadd, zrangebyscore, del } from '../redis';
import { processThread } from './processor';

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
  timestamp: string; // ISO8601 format
  threadId: string; // Unique ID for the thread
  originalUrl: string; // The URL of the thread page
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
            console.warn(`Redirect detected from ${url} to ${redirectUrl}.`);
            // You might want to update config.FORUM_URL if the domain changes permanently.
            // For now, axios follows redirects automatically.
        }
    }

    return response.data;
  } catch (error: any) {
    console.error(`Error fetching ${url}:`, error.message);
    if (retries > 0) {
      const delay = Math.pow(2, (3 - retries)) * 1000; // Exponential backoff
      console.log(`Retrying ${url} in ${delay / 1000} seconds... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchHtml(url, retries - 1);
    }
    console.error(`Failed to fetch ${url} after multiple retries.`);
    // Log error to Redis error queue (as per requirement)
    redisClient.lpush('error_queue', JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Failed to fetch URL: ${url}`,
      error: error.message
    }));
    return null;
  }
}

/**
 * Discovers thread URLs from a forum page.
 * @param html The HTML content of the forum page.
 * @param baseUrl The base URL to resolve relative links.
 * @returns An array of discovered thread URLs.
 */
function discoverThreadUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const threadUrls: string[] = [];

  // Parse <a class="" data-ipshover> elements as specified in requirements.
  $('a[data-ipshover]').each((index, element) => {
    const href = $(element).attr('href');
    if (href) {
      // Resolve relative URLs to absolute URLs
      const absoluteUrl = new URL(href, baseUrl).href;
      threadUrls.push(absoluteUrl);
    }
  });
  return threadUrls;
}

/**
 * Crawls a single forum page to discover new threads.
 * @param pageNum The page number to crawl.
 * @returns True if the page was successfully crawled and new threads were found, false otherwise.
 */
async function crawlForumPage(pageNum: number): Promise<boolean> {
  const url = `${config.FORUM_URL}${pageNum > 1 ? `page/${pageNum}/` : ''}`;
  console.log(`Crawling forum page: ${url}`);

  const html = await fetchHtml(url);
  if (!html) {
    console.warn(`Could not fetch HTML for page ${pageNum}. Assuming end of pagination.`);
    return false; // Indicates end of pagination or critical error
  }

  const threadUrls = discoverThreadUrls(html, url);
  console.log(`Discovered ${threadUrls.length} threads on page ${pageNum}.`);

  if (threadUrls.length === 0) {
    console.log(`No new threads found on page ${pageNum}. Ending new page crawl.`);
    return false; // No threads means likely end of new pages or structure changed
  }

  const newThreadsCount = 0;
  // Use a worker thread pool for parallel processing if MAX_CONCURRENCY > 1
  const processingPromises: Promise<void>[] = [];
  for (const threadUrl of threadUrls) {
    const threadId = new URL(threadUrl).pathname.split('/').pop()?.split('-')[0] || Buffer.from(threadUrl).toString('base64'); // Simple ID for tracking
    // Check if thread already processed or updated recently (using thread:{threadId} hash)
    const lastProcessed = await hgetall(`thread:${threadId}`);
    const now = new Date().toISOString();

    // If the thread has not been processed or needs re-visiting
    const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000; // hours to ms
    const lastModifiedTimestamp = lastProcessed.timestamp ? new Date(lastProcessed.timestamp).getTime() : 0;

    if (!lastProcessed.timestamp || (Date.now() - lastModifiedTimestamp) > revisitThreshold) {
      console.log(`Processing new or updated thread: ${threadUrl}`);
      processingPromises.push(
        (async () => {
          const processedData = await processThread(threadUrl);
          if (processedData) {
            // Store processed data in Redis (show, season, episode, thread hashes)
            await saveThreadData(processedData);
            // Update thread tracking hash
            await hmset(`thread:${threadId}`, {
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
      console.log(`Thread ${threadUrl} recently processed. Skipping.`);
    }
  }

  // Await any remaining processing promises
  await Promise.all(processingPromises);

  return newThreadsCount > 0 || threadUrls.length > 0;
}

/**
 * Saves processed thread data into Redis according to the defined schema.
 * @param data The processed thread content.
 */
async function saveThreadData(data: ThreadContent): Promise<void> {
  const { title, posterUrl, magnets, timestamp, threadId, originalUrl } = data;
  const now = new Date();

  // Basic normalization for show title for the show:{normalizedTitle} key
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, ''); // Simplified for now

  // Store show details
  await hmset(`show:${normalizedTitle}`, {
    originalTitle: title,
    posterUrl: posterUrl,
    // Add other fields as needed, like languages, description, etc.
    stremioId: `tt${normalizedTitle}`, // Example Stremio ID linking to normalized title
    lastUpdated: now.toISOString()
  });

  // Store season and episode information
  // This part needs to be more sophisticated, integrating with the title parser
  // to extract season and episode numbers. For now, assuming a simple structure.
  // The actual requirements specify `season:{showId}:{seasonNum} - Sorted Set`
  // and `episode:{seasonKey}:{epNum} - Hash`.
  // We'll simulate this by adding a placeholder season/episode.

  // Using the title parser to get more structured data
  const { season, episodeStart, episodeEnd, languages, resolution, qualityTags } = await (async () => {
    // Dynamically import to avoid circular dependency if title.ts depends on redis
    const { parseTitle } = await import('../parser/title');
    return parseTitle(title);
  })();

  const showId = `tt${normalizedTitle}`; // Use the generated Stremio ID for consistency

  let seasonNum = season || 1; // Default to Season 1 if not parsed
  let episodeCount = 1;

  if (episodeStart !== undefined && episodeEnd !== undefined) {
    episodeCount = episodeEnd - episodeStart + 1;
  }

  for (let i = 0; i < episodeCount; i++) {
    const currentEpisodeNum = (episodeStart || 1) + i;
    const seasonKey = `season:${showId}:${seasonNum}`;
    const episodeKey = `episode:${seasonKey}:${currentEpisodeNum}`;

    // Add to sorted set for timestamp-based updates and discovery
    // member format: "threadId:resolution:language"
    await zadd(seasonKey, now.getTime(), `${threadId}:${resolution || 'unknown'}:${(languages || []).join(',')}`);

    const magnet = magnets[0]?.url || ''; // Assuming one magnet per episode for now, or handle multiple
    const magnetName = magnets[0]?.name || '';
    const magnetSize = magnets[0]?.size || '';

    await hmset(episodeKey, {
      magnet: magnet,
      name: magnetName,
      title: `${title} | S${seasonNum} | E${currentEpisodeNum} ${resolution ? `[${resolution}]` : ''} ${languages.length ? `[${languages.join('/')}]` : ''}`,
      size: magnetSize,
      timestamp: now.toISOString(),
      threadUrl: originalUrl // Store the original thread URL for debugging/reference
    });

    console.log(`Saved episode data for ${episodeKey}`);
  }

  // Update languages for the show hash if new languages are found
  if (languages && languages.length > 0) {
    const existingLanguagesString = await hgetall(`show:${normalizedTitle}`).then(data => data.languages);
    const existingLanguages = existingLanguagesString ? existingLanguagesString.split(',') : [];
    const mergedLanguages = Array.from(new Set([...existingLanguages, ...languages]));
    await hset(`show:${normalizedTitle}`, 'languages', mergedLanguages.join(','));
  }

  // Update seasons field in show hash to record discovered seasons
  const existingSeasonsString = await hgetall(`show:${normalizedTitle}`).then(data => data.seasons);
  const existingSeasons = existingSeasonsString ? existingSeasonsString.split(',').filter(Boolean).map(Number) : [];
  const mergedSeasons = Array.from(new Set([...existingSeasons, seasonNum])).sort((a,b) => a - b);
  await hset(`show:${normalizedTitle}`, 'seasons', mergedSeasons.join(','));
}

/**
 * Periodically crawls new forum pages to discover new content.
 */
async function crawlNewPages(): Promise<void> {
  console.log('Starting new page crawl...');
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
      console.log(`Ended new page crawl at page ${pageCounter}.`);
    }
  }
  console.log('New page crawl finished.');
}

/**
 * Periodically re-visits existing threads to check for updates.
 * This function will fetch threads that were last updated X hours ago.
 */
async function revisitExistingThreads(): Promise<void> {
  console.log('Starting existing thread revisit...');
  // Get all thread keys
  const threadKeys = await redisClient.keys('thread:*');

  const revisitThreshold = config.THREAD_REVISIT_HOURS * 60 * 60 * 1000; // hours to ms
  const now = Date.now();

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
          const threadId = new URL(threadUrl).pathname.split('/').pop()?.split('-')[0] || Buffer.from(threadUrl).toString('base64');
          await hmset(`thread:${threadId}`, {
            url: threadUrl,
            timestamp: new Date().toISOString(),
            status: 'revisited'
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
  console.log(`Revisited ${threadsToRevisit.length} existing threads.`);
}

/**
 * Starts the main crawler loop.
 * This function initiates scheduled crawling for new pages and existing threads.
 */
export function startCrawler(): void {
  if (isCrawling) {
    console.log('Crawler is already running.');
    return;
  }
  isCrawling = true;
  console.log('Stremio Addon Crawler started.');

  // Initial crawl on startup
  (async () => {
    await crawlNewPages();
    await revisitExistingThreads();
  })();

  // Schedule new page crawls
  setInterval(async () => {
    console.log('Scheduled crawl for new pages triggered.');
    await crawlNewPages();
  }, config.CRAWL_INTERVAL * 1000); // Convert seconds to milliseconds

  // Schedule existing thread revisits
  setInterval(async () => {
    console.log('Scheduled revisit for existing threads triggered.');
    await revisitExistingThreads();
  }, config.THREAD_REVISIT_HOURS * 60 * 60 * 1000); // Convert hours to milliseconds
}
