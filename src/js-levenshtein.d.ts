// Type declaration for 'js-levenshtein' module
// This is created to explicitly define the `jaroWinkler` function,
// resolving TS2339 and TS2497 errors that can arise from inconsistent
// module interpretations or missing official type definitions.

declare module 'js-levenshtein' {
  /**
   * Calculates the Jaro-Winkler similarity between two strings.
   * Returns a value between 0 (no similarity) and 1 (identical).
   * Note: The underlying library might return distance, so 1 - distance
   * is typically used for similarity. This declaration reflects the function
   * as commonly used for similarity calculations.
   *
   * @param s1 The first string.
   * @param s2 The second string.
   * @returns The Jaro-Winkler similarity (0 to 1).
   */
  export function jaroWinkler(s1: string, s2: string): number;

  // The 'js-levenshtein' library also exports other functions like levenshtein, damerauLevenshtein.
  // You can declare them here if you use them. For now, focusing on jaroWinkler.
  // export function levenshtein(s1: string, s2: string): number;
  // export function damerauLevenshtein(s1: string, s2: string): number;

  // If the module itself is also callable (like `require('js-levenshtein')('a', 'b')`),
  // you might need a default export or an overloaded function signature for the module.
  // For the current usage, defining `jaroWinkler` as an exported function should suffice.
}
