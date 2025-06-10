import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Log levels for controlling logging verbosity.
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  OFF = 4, // Turn off all logging
}

/**
 * Interface for application configuration settings.
 */
export interface AppConfig {
  PORT: number;
  REDIS_URL: string;
  FORUM_URL: string;
  PURGE_ON_START: boolean;
  INITIAL_PAGES: number;
  CRAWL_INTERVAL: number; // in seconds
  THREAD_REVISIT_HOURS: number; // in hours
  MAX_CONCURRENCY: number;
  DOMAIN_MONITOR: string;
  ADDON_ID: string;
  ADDON_NAME: string;
  ADDON_DESCRIPTION: string;
  LOG_LEVEL: LogLevel; // New logging level configuration
}

/**
 * Application configuration object, loaded from environment variables.
 * Provides default values if environment variables are not set.
 */
export const config: AppConfig = {
  PORT: parseInt(process.env.PORT || '7000', 10),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  FORUM_URL: process.env.FORUM_URL || 'https://www.1tamilblasters.fi/index.php?/forums/forum/63-tamil-new-web-series-tv-shows/',
  PURGE_ON_START: process.env.PURGE_ON_START === 'true',
  INITIAL_PAGES: parseInt(process.env.INITIAL_PAGES || '2', 10),
  CRAWL_INTERVAL: parseInt(process.env.CRAWL_INTERVAL || '1800', 10), // 30 minutes
  THREAD_REVISIT_HOURS: parseInt(process.env.THREAD_REVISIT_HOURS || '24', 10),
  MAX_CONCURRENCY: parseInt(process.env.MAX_CONCURRENCY || '8', 10),
  DOMAIN_MONITOR: process.env.DOMAIN_MONITOR || 'http://1tamilblasters.net',
  ADDON_ID: 'community.tamilshows-addon',
  ADDON_NAME: 'TamilShows Web Series',
  ADDON_DESCRIPTION: 'Auto-updating Tamil web series catalog',
  LOG_LEVEL: LogLevel[process.env.LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel] || LogLevel.INFO, // Default to INFO
};

// Log the configuration to ensure it's loaded correctly (for debugging)
console.log('App Configuration Loaded:', config);
