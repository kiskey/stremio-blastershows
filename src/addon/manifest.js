const { config } = require('../config');

/**
 * Returns the Stremio Addon Manifest.
 * This function consolidates the manifest data defined in the requirements.
 * @returns {object} The Stremio addon manifest object.
 */
function getManifest() {
  return {
    id: config.ADDON_ID,
    version: "1.1.1", // Patch version incremented for this refinement
    name: config.ADDON_NAME,
    description: config.ADDON_DESCRIPTION,
    resources: [
      "catalog",
      "meta",
      "stream",
      "search"
    ],
    types: [
      "movie" // STRICTLY keeping "movie" as per instruction
    ],
    catalogs: [
      {
        type: "movie", // STRICTLY keeping "movie"
        id: "tamil-content", // Generic catalog ID for all "movie" content
        name: "Tamil Movies & Episodes", // Name reflecting the mixed content
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
