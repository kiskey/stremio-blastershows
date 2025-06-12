const { config } = require('../config.js'); // Ensure .js extension

/**
 * Stremio Addon Manifest object.
 * @type {object}
 * @property {string} id
 * @property {string} version
 * @property {string} name
 * @property {string} description
 * @property {string[]} resources
 * @property {string[]} types
 * @property {Array<object>} catalogs
 * @property {string[]} idPrefixes
 * @property {object} behaviorHints
 */
const manifest = {
  id: config.ADDON_ID,
  version: '1.0.0', // This can be managed via package.json or a build process
  name: config.ADDON_NAME,
  description: config.ADDON_DESCRIPTION,
  
  resources: [
    'catalog',
    'meta',
    'stream',
    'search'
  ],
  types: [
    'movie' // Corrected to 'movie' type as per your instruction
  ],
  catalogs: [
    {
      type: 'movie', // Corrected to 'movie' type for consistency with global types
      id: 'tamil-web-series',
      name: 'Tamil Web Series', // Note: This name still says "Web Series" but the type is now "movie"
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  idPrefixes: [
    'tt' // Example prefix for Stremio IDs, useful for movie/series lookups
  ],
  behaviorHints: {
    configurable: false,
    adult: false
  }
};

module.exports = { manifest };
