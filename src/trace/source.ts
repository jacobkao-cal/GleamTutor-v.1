/**
 * Source identity helpers used to tie a trace to the exact program text.
 *
 * Normalization only removes differences that cannot change the program:
 * CRLF/CR line endings and trailing whitespace at the very end of the file.
 * Any other edit, including whitespace inside the program, gives a different hash.
 */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** FNV-1a 32-bit hash of the normalized source, as 8 hex digits. Not cryptographic. */
export function hashSource(source: string): string {
  const text = normalizeSource(source);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return "fnv1a-" + (hash >>> 0).toString(16).padStart(8, "0");
}
