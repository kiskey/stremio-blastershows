const { config, LogLevel } = require('../config');
const redisClient = require('../redis'); // Import redis client to push errors to queue

/**
 * Custom Logger class to manage logging levels and output.
 * Also includes functionality to push errors to a Redis queue.
 */
class Logger {
  /** @type {LogLevel} */
  #currentLogLevel; // Private field for current log level

  constructor() {
    this.#currentLogLevel = config.LOG_LEVEL;
  }

  /**
   * Updates the logging level.
   * @param {LogLevel} newLevel The new logging level to set.
   */
  setLogLevel(newLevel) {
    this.#currentLogLevel = newLevel;
    this.info(`Log level set to: ${Object.keys(LogLevel).find(key => LogLevel[key] === newLevel)}`);
  }

  /**
   * Logs a debug message.
   * @param {string} message The message to log.
   * @param {...any} optionalParams Optional parameters to include in the log.
   */
  debug(message, ...optionalParams) {
    if (this.#currentLogLevel <= LogLevel.DEBUG) {
      console.log(`[DEBUG] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs an info message.
   * @param {string} message The message to log.
   * @param {...any} optionalParams Optional parameters to include in the log.
   */
  info(message, ...optionalParams) {
    if (this.#currentLogLevel <= LogLevel.INFO) {
      console.info(`[INFO] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs a warning message.
   * @param {string} message The message to log.
   * @param {...any} optionalParams Optional parameters to include in the log.
   */
  warn(message, ...optionalParams) {
    if (this.#currentLogLevel <= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs an error message.
   * Errors are always logged regardless of currentLogLevel, but level is used for internal tracking.
   * @param {string} message The message to log.
   * @param {any} [error] The error object.
   * @param {...any} optionalParams Optional parameters to include in the log.
   */
  error(message, error, ...optionalParams) {
    if (this.#currentLogLevel <= LogLevel.ERROR) {
      console.error(`[ERROR] ${message}`, error, ...optionalParams);
    }
    // Optionally, always log errors to console even if LogLevel is OFF
    if (this.#currentLogLevel === LogLevel.OFF) {
      console.error(`[ERROR - FORCED] ${message}`, error, ...optionalParams);
    }
  }

  /**
   * Pushes a structured error message to a Redis-based error queue.
   * @param {object} errorLog A structured error object.
   * @param {string} errorLog.timestamp - ISO timestamp of the error.
   * @param {string} errorLog.level - Log level of the error.
   * @param {string} errorLog.message - Description of the error.
   * @param {any} [errorLog.error] - The original error object.
   * @param {string} [errorLog.url] - URL context of the error.
   * @returns {Promise<void>}
   */
  async logToRedisErrorQueue(errorLog) {
    try {
      // Ensure the error object is stringified to be stored in Redis
      await redisClient.lpush('error_queue', JSON.stringify(errorLog));
      this.debug('Error logged to Redis error queue:', errorLog.message);
    } catch (redisError) {
      console.error('Failed to push error to Redis error queue:', redisError);
    }
  }
}

const logger = new Logger();

module.exports = {
  logger
};
