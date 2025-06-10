import { config, LogLevel } from '../config';
import redisClient from '../redis'; // Import redis client to push errors to queue

/**
 * Custom Logger class to manage logging levels and output.
 * Also includes functionality to push errors to a Redis queue.
 */
class Logger {
  private currentLogLevel: LogLevel;

  constructor() {
    this.currentLogLevel = config.LOG_LEVEL;
  }

  /**
   * Updates the logging level.
   * @param newLevel The new logging level to set.
   */
  public setLogLevel(newLevel: LogLevel): void {
    this.currentLogLevel = newLevel;
    this.info(`Log level set to: ${LogLevel[newLevel]}`);
  }

  /**
   * Logs a debug message.
   * @param message The message to log.
   * @param optionalParams Optional parameters to include in the log.
   */
  public debug(message: string, ...optionalParams: any[]): void {
    if (this.currentLogLevel <= LogLevel.DEBUG) {
      console.log(`[DEBUG] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs an info message.
   * @param message The message to log.
   * @param optionalParams Optional parameters to include in the log.
   */
  public info(message: string, ...optionalParams: any[]): void {
    if (this.currentLogLevel <= LogLevel.INFO) {
      console.info(`[INFO] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs a warning message.
   * @param message The message to log.
   * @param optionalParams Optional parameters to include in the log.
   */
  public warn(message: string, ...optionalParams: any[]): void {
    if (this.currentLogLevel <= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, ...optionalParams);
    }
  }

  /**
   * Logs an error message.
   * Errors are always logged regardless of currentLogLevel, but level is used for internal tracking.
   * @param message The message to log.
   * @param error The error object.
   * @param optionalParams Optional parameters to include in the log.
   */
  public error(message: string, error?: any, ...optionalParams: any[]): void {
    if (this.currentLogLevel <= LogLevel.ERROR) {
      console.error(`[ERROR] ${message}`, error, ...optionalParams);
    }
    // Optionally, always log errors to console even if LogLevel is OFF
    if (this.currentLogLevel === LogLevel.OFF) {
      console.error(`[ERROR - FORCED] ${message}`, error, ...optionalParams);
    }
  }

  /**
   * Pushes a structured error message to a Redis-based error queue.
   * @param errorLog A structured error object.
   */
  public async logToRedisErrorQueue(errorLog: { timestamp: string; level: string; message: string; error?: any; url?: string }): Promise<void> {
    try {
      // Ensure the error object is stringified to be stored in Redis
      await redisClient.lpush('error_queue', JSON.stringify(errorLog));
      this.debug('Error logged to Redis error queue:', errorLog.message);
    } catch (redisError) {
      console.error('Failed to push error to Redis error queue:', redisError);
    }
  }
}

export const logger = new Logger();
