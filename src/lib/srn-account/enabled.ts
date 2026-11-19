/**
 * Whether this build offers the SRN (SpaceRing) account at all.
 *
 * This fork keeps it off unless the build sets
 * `NEXT_PUBLIC_CODEG_SRN_SIGN_IN=on`. Off, the status bar's menu is the quick
 * actions alone, under a plain launcher button: no account head, no ring, no
 * sign-in row, and nothing asks for the account. The backend has its own
 * switch for the desktop's account, `CODEG_SRN_SIGN_IN`
 * (`src-tauri/crates/codeg-lib/src/srn/mod.rs`), which keeps its startup
 * check and its commands off.
 */
export function srnSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CODEG_SRN_SIGN_IN === "on"
}
