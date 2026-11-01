/**
 * Whether a Talk on this Mac runs, in any window of the app: read-aloud
 * steps aside meanwhile (the helper has the speakers, and the backend
 * refuses natural speech, `tts.talkActive`). Set by the Talk context from
 * the backend's status, which every window hears.
 */

let active = false
const listeners = new Set<() => void>()

export function setTalkVoiceActive(value: boolean): void {
  if (value === active) return
  active = value
  for (const listener of [...listeners]) listener()
}

export function isTalkVoiceActive(): boolean {
  return active
}

export function subscribeTalkVoiceActive(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
