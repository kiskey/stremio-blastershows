import Redis from 'ioredis';
import { config } from './config';

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
 * @param key The key of the hash.
 * @param field The field within the hash.
 * @returns The value associated with the field, or null if not found.
 */
export async function hget(key: string, field: string): Promise<string | null> {
  try {
    return await redisClient.hget(key, field);
  } catch (error) {
    console.error(`Error HGET key: ${key}, field: ${field}`, error);
    return null;
  }
}

/**
 * Function to set a value in Redis Hash.
 * @param key The key of the hash.
 * @param field The field within the hash.
 * @param value The value to set.
 * @returns 'OK' if the field was set.
 */
export async function hset(key: string, field: string, value: string): Promise<number> {
  try {
    return await redisClient.hset(key, field, value);
  }
}

/**
 * Function to set multiple fields in a Redis Hash.
 * @param key The key of the hash.
 * @param data An object containing field-value pairs.
 * @returns The number of fields that were added.
 */
export async function hmset(key: string, data: Record<string, string>): Promise<number> {
  try {
    // HMSET in ioredis accepts an array of key-value pairs or an object directly
    return await redisClient.hmset(key, data);
  }
}

/**
 * Function to get all fields and values from a Redis Hash.
 * @param key The key of the hash.
 * @returns An object containing all field-value pairs, or an empty object if not found.
 */
export async function hgetall(key: string): Promise<Record<string, string>> {
  try {
    return await redisClient.hgetall(key);
  } catch (error) {
    console.error(`Error HGETALL key: ${key}`, error);
    return {};
  }
}

/**
 * Function to add a member with a score to a Redis Sorted Set.
 * @param key The key of the sorted set.
 * @param score The score of the member.
 * @param member The member to add.
 * @returns The number of elements added to the sorted set.
 */
export async function zadd(key: string, score: number, member: string): Promise<number> {
  try {
    return await redisClient.zadd(key, score, member);
  } catch (error) {
    console.error(`Error ZADD key: ${key}, score: ${score}, member: ${member}`, error);
    return 0;
  }
}

/**
 * Function to get members from a Redis Sorted Set within a score range.
 * @param key The key of the sorted set.
 * @param min The minimum score.
 * @param max The maximum score.
 * @returns An array of members.
 */
export async function zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
  try {
    return await redisClient.zrangebyscore(key, min, max);
  } catch (error) {
    console.error(`Error ZRANGEBYSCORE key: ${key}, min: ${min}, max: ${max}`, error);
    return [];
  }
}

/**
 * Function to delete a key from Redis.
 * @param key The key to delete.
 * @returns The number of keys that were removed.
 */
export async function del(key: string): Promise<number> {
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
 * @returns A Promise that resolves when the purge is complete.
 */
export async function purgeRedis(): Promise<void> { // Changed return type to Promise<void>
  try {
    console.warn('Purging all data from Redis database...');
    await redisClient.flushdb(); // Perform the action
    console.log('Redis database purged successfully.');
  } catch (error) {
    console.error('Error purging Redis database:', error);
    // Log to Redis error queue if necessary, but this function doesn't return string now
  }
}

export default redisClient;
