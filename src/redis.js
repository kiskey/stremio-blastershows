const Redis = require('ioredis');
const { config } = require('./config');

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
 * Function to get a value from Redis Hash.
 * @param {string} key The key of the hash.
 * @param {string} field The field within the hash.
 * @returns {Promise<string|null>} The value associated with the field, or null if not found.
 */
async function hget(key, field) {
  try {
    return await redisClient.hget(key, field);
  } catch (error) {
    console.error(`Error HGET key: ${key}, field: ${field}`, error);
    return null;
  }
}

/**
 * Function to set a value in Redis Hash.
 * @param {string} key The key of the hash.
 * @param {string} field The field within the hash.
 * @param {string} value The value to set.
 * @returns {Promise<number>} The number of fields that were added/updated (1 or 0).
 */
async function hset(key, field, value) {
  try {
    // ioredis.hset correctly returns 1 (new field) or 0 (updated field) as a number
    return await redisClient.hset(key, field, value);
  } catch (error) {
    console.error(`Error HSET key: ${key}, field: ${field}`, error);
    return 0; // Return 0 on error
  }
}

/**
 * Function to set multiple fields in a Redis Hash.
 * @param {string} key The key of the hash.
 * @param {Record<string, string>} data An object containing field-value pairs.
 * @returns {Promise<number>} 1 if the operation was successful, 0 on error.
 */
async function hmset(key, data) {
  try {
    // HMSET in ioredis returns the string "OK" upon success.
    // We await the operation and then return a numeric indicator of success.
    const result = await redisClient.hmset(key, data);
    return result === 'OK' ? 1 : 0; // Return 1 for success, 0 otherwise
  } catch (error) {
    console.error(`Error HMSET key: ${key}, data:`, data, error);
    return 0; // Return 0 on error
  }
}

/**
 * Function to get all fields and values from a Redis Hash.
 * @param {string} key The key of the hash.
 * @returns {Promise<Record<string, string>>} An object containing all field-value pairs, or an empty object if not found.
 */
async function hgetall(key) {
  try {
    return await redisClient.hgetall(key);
  } catch (error) {
    console.error(`Error HGETALL key: ${key}`, error);
    return {};
  }
}

/**
 * Function to add a member with a score to a Redis Sorted Set.
 * @param {string} key The key of the sorted set.
 * @param {number} score The score of the member.
 * @param {string} member The member to add.
 * @returns {Promise<number>} The number of elements added to the sorted set.
 */
async function zadd(key, score, member) {
  try {
    return await redisClient.zadd(key, score, member);
  } catch (error) {
    console.error(`Error ZADD key: ${key}, score: ${score}, member: ${member}`, error);
    return 0;
  }
}

/**
 * Function to get members from a Redis Sorted Set within a score range.
 * @param {string} key The key of the sorted set.
 * @param {number} min The minimum score.
 * @param {number} max The maximum score.
 * @returns {Promise<string[]>} An array of members.
 */
async function zrangebyscore(key, min, max) {
  try {
    return await redisClient.zrangebyscore(key, min, max);
  } catch (error) {
    console.error(`Error ZRANGEBYSCORE key: ${key}, min: ${min}, max: ${max}`, error);
    return [];
  }
}

/**
 * Function to delete a key from Redis.
 * @param {string} key The key to delete.
 * @returns {Promise<number>} The number of keys that were removed.
 */
async function del(key) {
  try {
    return await redisClient.del(key);
  } catch (error) {
    console.error(`Error DEL key: ${key}`, error);
    return 0;
  }
}

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

module.exports = redisClient;
module.exports.hget = hget;
module.exports.hset = hset;
module.exports.hmset = hmset;
module.exports.hgetall = hgetall;
module.exports.zadd = zadd;
module.exports.zrangebyscore = zrangebyscore;
module.exports.del = del;
module.exports.purgeRedis = purgeRedis;
