/**
 * Text helpers shared by the repositories.
 *
 * Refactoring applied: Extract Method on a Duplicate Code smell. `escapeRegex`
 * was written twice, once in each repository, which is exactly how two copies
 * of a security-relevant helper drift apart.
 */

const BACKSLASH = String.fromCharCode(92);
const REGEX_SPECIALS = new Set([...'.*+?^${}()|[]', BACKSLASH]);

/**
 * Escapes regex metacharacters in untrusted input.
 *
 * Both v1 repositories interpolated a raw query parameter straight into a
 * `$regex`, which is a regex-injection and ReDoS vector, and also defeats the
 * index on the field being searched.
 */
export function escapeRegex(value) {
  return [...String(value)]
    .map((character) => (REGEX_SPECIALS.has(character) ? BACKSLASH + character : character))
    .join('');
}

/** Case-insensitive exact-match pattern, anchored at both ends. */
export function exactMatchPattern(value) {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

export default escapeRegex;
