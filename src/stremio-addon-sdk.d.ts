// This file provides explicit type declarations for the 'stremio-addon-sdk' module.
// This is necessary because the module itself might not ship with comprehensive
// TypeScript definitions in a way that allows direct 'import type' or it might
// be interpreted as a CommonJS module without proper type exports.

declare module 'stremio-addon-sdk' {
  // Common Stremio Addon SDK Manifest Interface
  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: string[]; // e.g., ["catalog", "meta", "stream"]
    types: string[]; // e.g., ["movie", "series"]
    catalogs: {
      type: string;
      id: string;
      name: string;
      extra?: { name: string; isRequired: boolean }[];
    }[];
    idPrefixes?: string[]; // e.g., ["tt"] for IMDb
    behaviorHints?: {
      configurable?: boolean;
      adult?: boolean;
      // Add other behavior hints as needed
    };
  }

  // Meta Preview Object (used in catalog responses)
  export interface DiscoverableItem {
    id: string;
    name: string;
    type: string; // e.g., "movie", "series"
    poster: string; // URL to poster image
    // Add other properties like backdrop, description if needed in catalog preview
  }

  // Catalog Response
  export interface CatalogResponse {
    metas: DiscoverableItem[];
  }

  // Meta Response (for individual item details)
  export interface MetaResponse {
    meta: {
      id: string;
      name: string;
      type: string;
      poster: string;
      description?: string;
      background?: string;
      logo?: string;
      releaseInfo?: string;
      imdb_id?: string;
      genres?: string[];
      videos?: {
        id: string;
        title: string;
        season?: number;
        episode?: number;
        released?: string; // ISO date string
        overview?: string;
        thumbnail?: string;
        // Add other video properties
      }[];
      // Add other meta properties like cast, director, etc.
    } | null;
  }

  // Stream Object
  export interface Stream {
    url?: string; // HTTP(s) stream URL
    infoHash?: string; // Torrent info hash
    fileIdx?: number; // For multi-file torrents
    name?: string; // Display name for the stream; usually used for stream quality
    title?: string; // Description of the stream
    ytId?: string; // YouTube video ID
    externalUrl?: string; // Meta Link or an external URL to the video
    subtitles?: any[]; // Array of Subtitle objects
    sources?: string[]; // Array of torrent tracker URLs and DHT network nodes
    behaviorHints?: {
      p2p?: boolean; // Added p2p hint for torrent streams
      countryWhitelist?: string[];
      notWebReady?: boolean;
      bingeGroup?: string;
      proxyHeaders?: Record<string, any>; // Headers for proxy
      videoHash?: string;
      videoSize?: number; // Size of the video file in bytes
      filename?: string; // Filename of the video file
    };
  }

  // Stream Response
  export interface StreamResponse {
    streams: Stream[];
  }

  // Other SDK-related types or functions might be declared here if needed
}
