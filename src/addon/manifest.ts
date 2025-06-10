// Use 'import type' for type-only imports to avoid TS2709 errors
import type { Manifest } from 'stremio-addon-sdk';
import { config } from '../config';

/**
 * Returns the Stremio Addon Manifest.
 * This function consolidates the manifest data defined in the requirements.
 * @returns {Manifest} The Stremio addon manifest object.
 */
export function getManifest(): Manifest {
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
      "series"
    ],
    catalogs: [
      {
        type: "series",
        id: "tamil-web-series",
        name: "Tamil Web Series",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      }
    ],
    idPrefixes: [
      "tt" // Common prefix for IMDb IDs, often used for series
    ],
    behaviorHints: {
      configurable: false,
      adult: false
    }
  };
}
