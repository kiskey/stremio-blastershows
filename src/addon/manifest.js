const { config } = require('../config');

/**
 * Returns the Stremio Addon Manifest.
 * @returns {object} The Stremio addon manifest object.
 */
function getManifest() {
  return {
    id: config.ADDON_ID,
    version: "1.0.0", // Hardcoded for now, could be read from package.json
    name: config.ADDON_NAME,
    description: config.ADDON_DESCRIPTION,
    resources: [
      "catalog",
      "meta",
      "stream",
      "search"
    ],
    types: [
      "series" // Keeping as series as per earlier discussion, although catalog type was movie in the last TypeScript manifest.
              // Reverted to "series" to match the initial intent for web series/TV shows.
    ],
    catalogs: [
      {
        type: "series", // Keeping as series here
        id: "tamil-web-series", // Catalog ID for web series
        name: "Tamil Web Series & TV Shows", // Updated name for clarity
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      }
    ],
    idPrefixes: [
      "tt" // Common prefix for IMDb IDs, generic enough for unique titles
    ],
    behaviorHints: {
      configurable: false,
      adult: false
    }
  };
}

module.exports = {
  getManifest
};
