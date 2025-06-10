import express from 'express';
import cors from 'cors';
import { config } from './config';
import { getManifest } from './addon/manifest';
// Ensure these imports are correctly resolved and typed by TypeScript
import { getCatalog, getMeta, getStream, search } from './addon/handlers';
import { startCrawler } from './crawler/engine';
import { purgeRedis } from './redis';
import { logger } from './utils/logger'; // Import the centralized logger
import redisClient, { hgetall } from './redis'; // Import redisClient and hgetall for debug endpoint

const app = express();

// Enable CORS for all routes
app.use(cors());
// Parse JSON bodies (if needed for POST requests, though Stremio primarily uses GET)
app.use(express.json());

// Add a healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Stremio Addon Manifest Endpoint
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(getManifest());
});

// Stremio Catalog Endpoint
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const { genre, skip, search } = req.query; // Stremio extra properties
  try {
    const response = await getCatalog(type, id, genre as string, parseInt(skip as string || '0', 10), search as string);
    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  } catch (error: any) {
    logger.error(`Error in getCatalog for type=${type}, id=${id}:`, error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// Stremio Meta Endpoint (for movie metadata)
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  try {
    const response = await getMeta(type, id);
    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  } catch (error: any) {
    logger.error(`Error in getMeta for type=${type}, id=${id}:`, error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// Stremio Stream Endpoint (for movies/episodes)
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  try {
    const response = await getStream(type, id);
    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  } catch (error: any) {
    logger.error(`Error in getStream for type=${type}, id=${id}:`, error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// Stremio Search Endpoint
app.get('/q/:type/:id/search.json', async (req, res) => {
  const { query } = req.query;
  try {
    const response = await search(query as string);
    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  } catch (error: any) {
    logger.error(`Error in search for query=${query}:`, error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// Debug endpoint to list all crawled threads and their magnets
app.get('/debug/crawled-data', async (req, res) => {
  logger.info('Received request for crawled data debug endpoint.');
  try {
    const allThreadKeys = await redisClient.keys('thread:*');
    const allMovieKeys = await redisClient.keys('movie:*'); // Keys are now movie:<stremioMovieId>
    const allEpisodeKeys = await redisClient.keys('episode:*'); // Keys are episode:<stremioMovieId>:s<S>e<E>:<res>:<idx>

    const crawledThreads: { [key: string]: any } = {};
    for (const key of allThreadKeys) {
      const data = await hgetall(key);
      crawledThreads[key] = data;
    }

    const crawledMovies: { [stremioId: string]: any } = {};
    for (const key of allMovieKeys) {
      const data = await hgetall(key);
      if (data.stremioId) {
        crawledMovies[data.stremioId] = {
          originalTitle: data.originalTitle,
          posterUrl: data.posterUrl,
          lastUpdated: data.lastUpdated,
          threadStartedTime: data.threadStartedTime, // Include threadStartedTime
          associatedThreadId: data.associatedThreadId
        };
      }
    }

    const crawledEpisodes: { [stremioMovieId: string]: { [episodeKey: string]: any } } = {};
    for (const key of allEpisodeKeys) {
      const data = await hgetall(key);
      if (data.stremioMovieId && data.magnet) { // Check for stremioMovieId and magnet existence
        if (!crawledEpisodes[data.stremioMovieId]) {
          crawledEpisodes[data.stremioMovieId] = {};
        }
        crawledEpisodes[data.stremioMovieId][key] = {
          title: data.title,
          magnet: data.magnet.startsWith('magnet:?xt=urn:btih:') ? data.magnet : 'INVALID MAGNET LINK', // Validate magnet link
          size: data.size,
          resolution: data.resolution, // Include resolution
          threadUrl: data.threadUrl
        };
      } else if (data.stremioMovieId) {
        if (!crawledEpisodes[data.stremioMovieId]) {
          crawledEpisodes[data.stremioMovieId] = {};
        }
        crawledEpisodes[data.stremioMovieId][key] = {
            title: data.title,
            magnet: 'N/A (missing or invalid)',
            size: data.size,
            resolution: data.resolution, // Include resolution
            threadUrl: data.threadUrl
        };
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.json({
      summary: {
        totalThreadsTracked: allThreadKeys.length,
        totalMoviesDiscovered: Object.keys(crawledMovies).length, // Count unique Stremio movie IDs
        totalEpisodeStreamsDiscovered: allEpisodeKeys.length,
      },
      threadsData: crawledThreads, // Raw thread data by threadId
      moviesInCatalog: crawledMovies, // Movies as they appear in catalog (by Stremio ID)
      episodesByMovie: crawledEpisodes // Episodes grouped by Stremio Movie ID
    });
  } catch (error: any) {
    logger.error('Error fetching crawled data:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});


// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error in Express application:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Start the server
const startServer = async () => {
  try {
    // Purge Redis data on startup if PURGE_ON_START is true
    if (config.PURGE_ON_START) {
      await purgeRedis();
      logger.info('Redis data purged as per configuration.');
    }

    // Start the web server
    app.listen(config.PORT, () => {
      logger.info(`Stremio Addon listening on port ${config.PORT}`);
      logger.info(`Addon manifest available at: http://localhost:${config.PORT}/manifest.json`);
      logger.info(`Debug crawled data available at: http://localhost:${config.PORT}/debug/crawled-data`);
    });

    // Start the crawler engine
    startCrawler();
  } catch (error: any) {
    logger.error('Failed to start the addon:', error);
    process.exit(1); // Exit with a failure code
  }
};

startServer();
