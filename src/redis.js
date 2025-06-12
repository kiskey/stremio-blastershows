const Redis = require('ioredis');
const { config } = require('./config.js'); // Ensure .js extension

// Initialize Redis client using the REDIS_URL from configuration
const redisClient = new Redis(config.REDIS_URL);

// Event listener for successful connection
redisClient.on('connect', () => {
  console.log('Successfully connected to Redis.');
});

// Event listener for Redis errors
redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
  // Implement more robust error handling, e.g., re-connection logic
});

/**
 * Purges all data from the Redis database.
 * Use with extreme caution.
 * @returns {Promise<void>} A Promise that resolves when the purge is complete.
 */
async function purgeRedis() {
  try {
    console.warn('Purging all data from Redis database...');
    await redisClient.flushdb();
    console.log('Redis database purged successfully.');
  } catch (error) {
    console.error('Error purging Redis database:', error);
  }
}

// Attach purgeRedis directly to the redisClient object
redisClient.purgeRedis = purgeRedis;

// Export the redisClient instance as the primary export.
// Other modules will import this client and call its methods directly.
module.exports = redisClient;
