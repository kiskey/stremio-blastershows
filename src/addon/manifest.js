const { config } = require('../config');

/**
 * Returns the Stremio Addon Manifest.
 * This function consolidates the manifest data defined in the requirements.
 * @returns {object} The Stremio addon manifest object.
 */
function getManifest() {
  return {
    id: config.ADDON_ID,
    version: "1.1.0", // Minor release to 1.1.0
    name: config.ADDON_NAME,
    description: config.ADDON_DESCRIPTION,
    resources: [
      "catalog",
      "meta",
      "stream",
      "search"
    ],
    types: [
      "movie" // Explicitly keeping "movie" as per instruction
    ],
    catalogs: [
      {
        type: "movie", // Explicitly keeping "movie"
        id: "tamil-content", // More generic catalog ID for movies/episodes
        name: "Tamil Movies & Episodes", // Name reflecting content
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
