// WS wire-protocol constants shared by `WebTransport` and
// `RemoteDesktopTransport`. The string values MUST stay in sync with their
// Rust counterparts in `src-tauri/src/web/ws.rs` — drift will break the
// server→client handshake silently.
export const WS_READY_CHANNEL = "__ready__"

/** "You may have missed events: refetch." Sent by the server when this client
 *  fell behind the event broadcast and events were skipped, or when the server
 *  could not announce a change it made. Answered exactly like a reconnect: the
 *  transport fires its reconnect callbacks (the resync pass). Rust:
 *  `RESYNC_EVENT` in `src-tauri/src/web/event_bridge.rs`. */
export const WS_RESYNC_CHANNEL = "__resync__"
