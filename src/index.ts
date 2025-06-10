import express from 'express';
import cors from 'cors';
import { config } from './config';
import { getManifest } from './addon/manifest';
import { getCatalog, getMeta, getStream, search } from './addon/handlers';
import { startCrawler } from './crawler/engine';
import { purgeRedis } from './redis';

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
  const response = await getCatalog(type, id, genre as string, parseInt(skip as string || '0', 10), search as string);
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// Stremio Meta Endpoint (for series metadata)
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const response = await getMeta(type, id);
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// Stremio Stream Endpoint (for episodes/movies)
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const response = await getStream(type, id);
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// Stremio Search Endpoint
app.get('/q/:type/:id/search.json', async (req, res) => {
  const { query } = req.query;
  const response = await search(query as string);
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Start the server
const startServer = async () => {
  try {
    // Purge Redis data on startup if PURGE_ON_START is true
    if (config.PURGE_ON_START) {
      await purgeRedis();
      console.log('Redis data purged as per configuration.');
    }

    // Start the web server
    app.listen(config.PORT, () => {
      console.log(`Stremio Addon listening on port ${config.PORT}`);
      console.log(`Addon manifest available at: http://localhost:${config.PORT}/manifest.json`);
    });

    // Start the crawler engine
    startCrawler();
  } catch (error) {
    console.error('Failed to start the addon:', error);
    process.exit(1); // Exit with a failure code
  }
};

startServer();
