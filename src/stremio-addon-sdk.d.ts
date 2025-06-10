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
    name?: string; // Display name for the stream (e.g., "720p WEB-DL")
    title?: string; // Detailed title (e.g., "S1E1 - The Beginning")
    ytId?: string; // YouTube video ID
    externalUrl?: string; // Link to external streaming service
    behaviorHints?: {
      filename?: string;
      headers?: Record<string, string>;
      notWebReady?: boolean; // If video format is not web-ready
      // Add other stream behavior hints
    };
    // Add other stream properties like tag, sources
  }

  // Stream Response
  export interface StreamResponse {
    streams: Stream[];
  }

  // Other SDK-related types or functions might be declared here if needed
  // For example, if addonBuilder is a class or function:
  // export class addonBuilder {
  //   constructor(manifest: Manifest);
  //   defineCatalogHandler(handler: (args: any) => Promise<CatalogResponse>): void;
  //   defineMetaHandler(handler: (args: any) => Promise<MetaResponse>): void;
  //   defineStreamHandler(handler: (args: any) => Promise<StreamResponse>): void;
  //   getInterface(): any; // Return type of addon interface
  // }

  // Since we are using an Express app, the SDK's serveHTTP might not be directly used,
  // but its types could be declared if relevant for other parts of the SDK.
  // export function serveHTTP(addonInterface: any, options: { port?: number; hostname?: string }): void;
}
