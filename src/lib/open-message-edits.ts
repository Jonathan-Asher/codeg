/**
 * Conversation tabs with an editor open on one of their earlier user messages
 * ("Edit message"), by tab id. What is typed there lives only in the message
 * list's own state, never in a saved draft, so showing another session in the
 * tab would unmount the list and lose it: the "where does a session open"
 * rule reads this to leave such a tab alone. Kept per list instance, since a
 * tab moving between split groups mounts its new list before the old one has
 * let go.
 */

const openEditsByTab = new Map<string, Set<string>>()

export function setOpenMessageEdit(
  tabId: string,
  instanceId: string,
  open: boolean
): void {
  const instances = openEditsByTab.get(tabId) ?? new Set<string>()
  if (open) instances.add(instanceId)
  else instances.delete(instanceId)
  if (instances.size > 0) openEditsByTab.set(tabId, instances)
  else openEditsByTab.delete(tabId)
}

export function hasOpenMessageEdit(tabId: string): boolean {
  return openEditsByTab.has(tabId)
}

export function resetOpenMessageEditsForTests(): void {
  openEditsByTab.clear()
}
