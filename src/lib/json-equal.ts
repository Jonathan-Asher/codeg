/**
 * Deep equality for plain JSON data — what the backend sends (file tree nodes,
 * git status entries, git log entries): arrays by position, objects by key.
 * Lets a refresh that brings back the same data keep the old reference, so
 * nothing keyed on it rebuilds.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      !jsonEqual(left[key], right[key])
    ) {
      return false
    }
  }
  return true
}
