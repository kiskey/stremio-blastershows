// This file provides a minimal declaration for the 'stremio-addon-sdk' module.
// It's used when the module itself does not ship with its own TypeScript definitions,
// and no official '@types' package is available or working correctly.
// This tells TypeScript to treat the module as existing, preventing 'TS7016' errors.
declare module 'stremio-addon-sdk';

// Although we are using 'declare module', it's good practice to provide
// minimal interfaces if you know the structure of the objects you're interacting with.
// However, for initial compilation, the simple 'declare module' is often sufficient.
// For example, if you know the 'Manifest' interface:
/*
declare module 'stremio-addon-sdk' {
  interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: string[];
    types: string[];
    catalogs: any[]; // Define more specifically if needed
    idPrefixes?: string[];
    behaviorHints?: {
      configurable?: boolean;
      adult?: boolean;
    };
  }

  // You might also declare other exported functions/classes if you use them directly
  // For example, if addonBuilder is exported
  // const addonBuilder: any;
  // export { Manifest, addonBuilder };
}
*/
