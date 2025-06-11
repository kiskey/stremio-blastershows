const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Log levels for controlling logging verbosity.
 * @enum {number}
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  OFF: 4, // Turn off all logging
};

/**
 * Application configuration object, loaded from environment variables.
 * Provides default values if environment variables are not set.
 * @type {object}
 * @property {number} PORT
 * @property {string} REDIS_URL
 * @property {string} FORUM_URL
 * @property {boolean} PURGE_ON_START
 * @property {number} INITIAL_PAGES
 * @property {number} CRAWL_INTERVAL - in seconds
 * @property {number} THREAD_REVISIT_HOURS - in hours
 * @property {number} MAX_CONCURRENCY
 * @property {string} DOMAIN_MONITOR
 * @property {string} ADDON_ID
 * @property {string} ADDON_NAME
 * @property {string} ADDON_DESCRIPTION
 * @property {LogLevel} LOG_LEVEL
 * @property {number} TRACKER_UPDATE_INTERVAL_HOURS - in hours
 * @property {string} NGOSANG_TRACKERS_URL
 */
const config = {
  PORT: parseInt(process.env.PORT || '7000', 10),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  FORUM_URL: process.env.FORUM_URL || 'https://www.1tamilblasters.fi/index.php?/forums/forum/63-tamil-new-web-series-tv-shows/',
  PURGE_ON_START: process.env.PURGE_ON_START === 'true',
  INITIAL_PAGES: parseInt(process.env.INITIAL_PAGES || '2', 10),
  CRAWL_INTERVAL: parseInt(process.env.CRAWL_INTERVAL || '1800', 10), // 30 minutes
  THREAD_REVISIT_HOURS: parseInt(process.env.THREAD_REVISIT_HOURS || '24', 10),
  MAX_CONCURRENCY: parseInt(process.env.MAX_CONCURRENCY || '8', 10),
  DOMAIN_MONITOR: process.env.DOMAIN_MONITOR || 'http://1tamilblasters.net',
  ADDON_ID: process.env.ADDON_ID || 'community.tamilshows-addon',
  ADDON_NAME: process.env.ADDON_NAME || 'TamilShows Web Series',
  ADDON_DESCRIPTION: process.env.ADDON_DESCRIPTION || 'Auto-updating Tamil web series catalog',
  LOG_LEVEL: LogLevel[process.env.LOG_LEVEL?.toUpperCase()] || LogLevel.INFO, // Default to INFO
  TRACKER_UPDATE_INTERVAL_HOURS: parseInt(process.env.TRACKER_UPDATE_INTERVAL_HOURS || '6', 10), // Default to 6 hours
  NGOSANG_TRACKERS_URL: process.env.NGOSANG_TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt', // Default URL
};

// Log the configuration to ensure it's loaded correctly (for debugging)
console.log('App Configuration Loaded:', config);

module.exports = {
  config,
  LogLevel
};
