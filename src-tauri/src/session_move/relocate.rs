//! The agents' own files of a session moved to another project.
//!
//! Only the agents whose session store is keyed by the working directory need
//! anything moved:
//!
//! * **Claude Code** files a session under `projects/<encoded cwd>/`: the
//!   transcript `<id>.jsonl`, its `<id>/` folder (sub-agent transcripts, tool
//!   results), and the transcripts `/clear` rolled over to, which sit beside it.
//!   A resume from another directory finds none of it ("No conversation
//!   found"). They move the way Claude Code moves a session itself
//!   (`relocateSessionTranscript` in its CLI): renamed into the new directory's
//!   project folder, a file already there set aside as
//!   `<name>.superseded-<ms>`, a `{"type":"relocated","sessionId":…,
//!   "relocatedCwd":…}` record appended, and the task-output links in its temp
//!   folder re-pointed at the moved `<id>/` folder.
//! * **pi** files a session under `sessions/--<encoded cwd>--/` and reads its
//!   working directory from the file's header. The file moves into the new
//!   directory's bucket (a flat, configured session directory keeps it where it
//!   is), its header's `cwd` is rewritten, and pi-acp's session map — which
//!   remembers each session's file path and opens that path on resume — is
//!   pointed at the new file.
//!
//! Files are MOVED, never copied: codeg's readers and Claude Code's alike take
//! the first file they find under a session id, so a copy left behind would
//! shadow the moved one. Every step is recorded so a failure — here, or in the
//! database write after it — puts everything back ([`Applied::rollback`]).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Where Claude Code keeps its files, for one move.
#[derive(Debug, Clone)]
pub struct ClaudeRoots {
    /// The config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`): holds
    /// `projects/`.
    pub config_dir: PathBuf,
    /// Claude Code's temp root (`$CLAUDE_CODE_TMPDIR`, else `/tmp`, then
    /// `claude-<uid>`), where task outputs link into a session's folder.
    pub temp_root: Option<PathBuf>,
}

/// Where pi keeps its files, for one move.
#[derive(Debug, Clone)]
pub struct PiRoots {
    /// pi's sessions directory: `--<cwd>--/` buckets under it, or flat.
    pub sessions_dir: PathBuf,
    /// pi-acp's `session-map.json`, when there is one.
    pub session_map: Option<PathBuf>,
}

/// What a move does to one session's files on disk.
#[derive(Debug, Clone)]
pub enum Plan {
    /// Nothing to move: the agent keeps nothing keyed by the folder (Codex,
    /// OpenClaw), or the session has no agent session yet.
    Nothing,
    Claude(ClaudePlan),
    Pi(PiPlan),
}

#[derive(Debug, Clone)]
pub struct ClaudePlan {
    new_cwd: String,
    /// The project folder the transcripts are in now.
    src_dir: PathBuf,
    /// The new working directory's project folder.
    dest_dir: PathBuf,
    /// The transcript and the ones `/clear` rolled over to, in order:
    /// `(session id, path)`.
    chain: Vec<(String, PathBuf)>,
    temp_root: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct PiPlan {
    session_id: String,
    new_cwd: String,
    src: PathBuf,
    /// `src` itself when the file is not in its working directory's bucket.
    dest: PathBuf,
    session_map: Option<PathBuf>,
}

/// One step taken, and how it is undone.
#[derive(Debug)]
enum Undo {
    /// `from` was renamed to `to`: rename it back.
    Renamed { from: PathBuf, to: PathBuf },
    /// Bytes were appended to `path`, which was `len` bytes long.
    Appended { path: PathBuf, len: u64 },
    /// `link` pointed at `target` before it was re-pointed.
    Repointed { link: PathBuf, target: PathBuf },
    /// The first line of `path` was `line` (without its newline).
    HeaderRewritten { path: PathBuf, line: String },
    /// pi-acp's map held `entry` for `session_id` (`None`: no entry).
    SessionMapEntry {
        path: PathBuf,
        session_id: String,
        entry: Option<serde_json::Value>,
    },
}

/// The steps a [`Plan`] took, to undo them if the move does not complete.
#[derive(Debug, Default)]
pub struct Applied {
    steps: Vec<Undo>,
    /// Paths whose cached parses go once the move is final.
    forget: Vec<PathBuf>,
}

impl Applied {
    /// Undo every step, newest first. Best-effort: a step that cannot be
    /// undone is logged and the rest still run.
    pub fn rollback(self) {
        for step in self.steps.into_iter().rev() {
            let result = match &step {
                Undo::Renamed { from, to } => fs::rename(to, from),
                Undo::Appended { path, len } => fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .and_then(|file| file.set_len(*len)),
                Undo::Repointed { link, target } => replace_symlink(link, target),
                Undo::HeaderRewritten { path, line } => rewrite_first_line(path, line),
                Undo::SessionMapEntry {
                    path,
                    session_id,
                    entry,
                } => write_session_map_entry(path, session_id, entry.clone()),
            };
            if let Err(e) = result {
                tracing::error!("[session-move] could not undo {step:?}: {e}");
            }
        }
    }

    /// The move is final: drop what codeg cached under the old paths.
    pub fn commit(self) {
        let cache = crate::parsers::detail_cache::DetailCache::global();
        for path in &self.forget {
            cache.forget_under(path);
        }
    }

    fn absorb(&mut self, other: Applied) {
        self.steps.extend(other.steps);
        self.forget.extend(other.forget);
    }
}

/// Apply every plan, all or none: a failure undoes what the earlier ones did.
pub fn apply_all(plans: &[Plan]) -> std::io::Result<Applied> {
    let mut applied = Applied::default();
    for plan in plans {
        let mut step = Applied::default();
        let result = match plan {
            Plan::Nothing => Ok(()),
            Plan::Claude(plan) => apply_claude(plan, &mut step),
            Plan::Pi(plan) => apply_pi(plan, &mut step),
        };
        applied.absorb(step);
        if let Err(e) = result {
            applied.rollback();
            return Err(e);
        }
    }
    Ok(applied)
}

// ─── Claude Code ─────────────────────────────────────────────────────────

/// Plan moving Claude Code session `session_id` to `new_cwd`. `None` when its
/// transcript is not where Claude Code keeps it (nothing codeg can move).
pub fn plan_claude(roots: &ClaudeRoots, session_id: &str, new_cwd: &str) -> Option<ClaudePlan> {
    if !crate::commands::quick_ask::is_safe_session_id(session_id) {
        return None;
    }
    let projects = roots.config_dir.join("projects");
    let transcript = crate::parsers::claude::find_session_file_in(&projects, session_id)?;
    let src_dir = transcript.parent()?.to_path_buf();
    // Claude Code names the project folder after its process's working
    // directory, which the OS reports with symlinks resolved (a session run
    // in `/tmp/x` is filed under `-private-tmp-x` on macOS), and records the
    // same path as its `cwd`.
    let new_cwd = fs::canonicalize(new_cwd)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| new_cwd.to_string());
    let dest_dir = projects.join(crate::commands::quick_ask::claude_project_dir_name(
        &new_cwd,
    ));
    // The `/clear` successors are found by their place beside the
    // transcript and their timestamps, so the chain is read before anything
    // moves.
    let mut chain = vec![(session_id.to_string(), transcript.clone())];
    let mut current = (session_id.to_string(), transcript);
    for _ in 0..32 {
        match crate::parsers::claude::find_clear_rollover_successor(&current.1, &current.0) {
            Some(next) if !chain.iter().any(|(id, _)| *id == next.0) => {
                chain.push(next.clone());
                current = next;
            }
            _ => break,
        }
    }
    Some(ClaudePlan {
        new_cwd,
        src_dir,
        dest_dir,
        chain,
        temp_root: roots.temp_root.clone(),
    })
}

/// Whether the Claude adapter codeg launches knows the `relocated` record:
/// its SDK reads `relocatedCwd` (claude-agent-acp 0.94.0 does). `Some(false)`
/// only when the SDK was found and has no such reader — an adapter old
/// enough to predate the record, where a move keeps the session listed only.
/// `None` when the SDK could not be found next to the adapter: the move goes
/// ahead, because what a resume needs is the transcript in the new folder,
/// and an SDK that predates the record skips it like any record it does not
/// know.
pub async fn claude_relocation_support() -> Option<bool> {
    let bin = crate::commands::acp::resolve_npx_command("claude-agent-acp").await?;
    tokio::task::spawn_blocking(move || sdk_reads_relocation(&bin))
        .await
        .ok()
        .flatten()
}

/// Find the adapter's `@anthropic-ai/claude-agent-sdk/sdk.mjs` (nested in
/// its own `node_modules`, or hoisted beside it) and look for the reader.
fn sdk_reads_relocation(bin: &Path) -> Option<bool> {
    use std::sync::Mutex;
    /// The last answer, for the SDK file it read (path, size, mtime): a
    /// second move reads the 1 MB file again only after an update.
    type Stamp = (PathBuf, u64, Option<std::time::SystemTime>);
    static LAST: Mutex<Option<(Stamp, bool)>> = Mutex::new(None);
    const MAX_SDK_BYTES: u64 = 32 * 1024 * 1024;
    let real = fs::canonicalize(bin).ok()?;
    let package_root = real.ancestors().find(|dir| {
        fs::read_to_string(dir.join("package.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|pkg| pkg.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .as_deref()
            == Some("@agentclientprotocol/claude-agent-acp")
    })?;
    let sdk = ["node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"]
        .iter()
        .map(|rel| package_root.join(rel))
        .chain(
            package_root
                .parent()
                .and_then(|scope| scope.parent())
                .map(|modules| modules.join("@anthropic-ai/claude-agent-sdk/sdk.mjs")),
        )
        .find(|path| path.is_file())?;
    let meta = fs::metadata(&sdk).ok()?;
    if meta.len() > MAX_SDK_BYTES {
        return None;
    }
    let stamp: Stamp = (sdk.clone(), meta.len(), meta.modified().ok());
    if let Some((seen, answer)) = LAST.lock().ok()?.as_ref() {
        if *seen == stamp {
            return Some(*answer);
        }
    }
    let text = fs::read(&sdk).ok()?;
    let has = |needle: &[u8]| text.windows(needle.len()).any(|w| w == needle);
    let answer = has(b"\"relocated\"") && has(b"relocatedCwd");
    if let Ok(mut last) = LAST.lock() {
        *last = Some((stamp, answer));
    }
    Some(answer)
}

/// The record Claude Code appends to a transcript it moved
/// (`relocateSessionTranscript`), field for field.
pub fn relocated_record(session_id: &str, relocated_cwd: &str) -> String {
    serde_json::json!({
        "type": "relocated",
        "sessionId": session_id,
        "relocatedCwd": relocated_cwd,
    })
    .to_string()
}

fn apply_claude(plan: &ClaudePlan, applied: &mut Applied) -> std::io::Result<()> {
    let same_dir = same_directory(&plan.src_dir, &plan.dest_dir);
    if !same_dir {
        create_private_dir(&plan.dest_dir)?;
    }
    for (id, src) in &plan.chain {
        let dest = plan.dest_dir.join(format!("{id}.jsonl"));
        let src_folder = plan.src_dir.join(id);
        let dest_folder = plan.dest_dir.join(id);
        if !same_dir {
            set_aside_existing(&dest, applied)?;
            move_path(src, &dest)?;
            applied.steps.push(Undo::Renamed {
                from: src.clone(),
                to: dest.clone(),
            });
            applied.forget.push(src.clone());
            if src_folder.is_dir() {
                set_aside_existing(&dest_folder, applied)?;
                move_path(&src_folder, &dest_folder)?;
                applied.steps.push(Undo::Renamed {
                    from: src_folder.clone(),
                    to: dest_folder.clone(),
                });
                applied.forget.push(src_folder.clone());
            }
        }
        let len = append_line(&dest, &relocated_record(id, &plan.new_cwd))?;
        applied.steps.push(Undo::Appended { path: dest, len });
        if !same_dir {
            if let Some(temp_root) = &plan.temp_root {
                repoint_task_outputs(temp_root, id, &src_folder, &dest_folder, applied);
            }
        }
    }
    Ok(())
}

/// Re-point the task-output links Claude Code keeps for session `id` in its
/// temp folder (`<temp root>/<any encoded cwd>/<id>/tasks/<task>.output`, each
/// a link to a sub-agent transcript in the session's folder) at the folder's
/// new place, as Claude Code's own relocation does. Best-effort: a link that
/// cannot be re-pointed is logged, not fatal — it names output the agent may
/// never read again.
fn repoint_task_outputs(
    temp_root: &Path,
    id: &str,
    old_folder: &Path,
    new_folder: &Path,
    applied: &mut Applied,
) {
    let Ok(cwds) = fs::read_dir(temp_root) else {
        return;
    };
    for cwd in cwds.flatten() {
        let tasks = cwd.path().join(id).join("tasks");
        let Ok(entries) = fs::read_dir(&tasks) else {
            continue;
        };
        for entry in entries.flatten() {
            let link = entry.path();
            if link.extension().and_then(|e| e.to_str()) != Some("output") {
                continue;
            }
            let Ok(target) = fs::read_link(&link) else {
                continue;
            };
            let Ok(rest) = target.strip_prefix(old_folder) else {
                continue;
            };
            let new_target = new_folder.join(rest);
            match replace_symlink(&link, &new_target) {
                Ok(()) => applied.steps.push(Undo::Repointed { link, target }),
                Err(e) => {
                    tracing::warn!("[session-move] could not re-point {}: {e}", link.display())
                }
            }
        }
    }
}

// ─── pi ──────────────────────────────────────────────────────────────────

/// pi's bucket name for a working directory (`getDefaultSessionDirPath`):
/// `--` + the path without its leading separator, every `/`, `\` and `:` made
/// `-`, + `--`.
pub fn pi_bucket_name(cwd: &str) -> String {
    let trimmed = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    let encoded: String = trimmed
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("--{encoded}--")
}

/// The session file of pi session `session_id` under `sessions_dir`: named
/// `<time>_<id>.jsonl`, with `id` in its header.
pub fn find_pi_session_file(sessions_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !crate::commands::quick_ask::is_safe_session_id(session_id) {
        return None;
    }
    walkdir::WalkDir::new(sessions_dir)
        .max_depth(3)
        .into_iter()
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter(|path| crate::parsers::pi::fallback_id(path) == session_id)
        .find(|path| {
            read_first_line(path)
                .ok()
                .flatten()
                .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
                .map(|header| {
                    header.get("type").and_then(|t| t.as_str()) != Some("session")
                        || header.get("id").and_then(|i| i.as_str()) == Some(session_id)
                })
                .unwrap_or(true)
        })
}

/// Plan moving pi session `session_id` to `new_cwd`. `None` when its file is
/// not under the sessions directory.
pub fn plan_pi(roots: &PiRoots, session_id: &str, new_cwd: &str) -> Option<PiPlan> {
    let src = find_pi_session_file(&roots.sessions_dir, session_id)?;
    let header_cwd = read_first_line(&src)
        .ok()
        .flatten()
        .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
        .and_then(|header| {
            header
                .get("cwd")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        });
    // In its working directory's bucket: it moves to the new one. Anywhere
    // else (a configured flat directory) it stays, and only its header
    // changes.
    let in_own_bucket = header_cwd.as_deref().is_some_and(|cwd| {
        src.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some(pi_bucket_name(cwd).as_str())
    });
    let dest = match (
        in_own_bucket,
        src.parent().and_then(|p| p.parent()),
        src.file_name(),
    ) {
        (true, Some(root), Some(name)) => root.join(pi_bucket_name(new_cwd)).join(name),
        _ => src.clone(),
    };
    Some(PiPlan {
        session_id: session_id.to_string(),
        new_cwd: new_cwd.to_string(),
        src,
        dest,
        session_map: roots.session_map.clone(),
    })
}

fn apply_pi(plan: &PiPlan, applied: &mut Applied) -> std::io::Result<()> {
    if plan.dest != plan.src {
        if let Some(bucket) = plan.dest.parent() {
            fs::create_dir_all(bucket)?;
        }
        set_aside_existing(&plan.dest, applied)?;
        move_path(&plan.src, &plan.dest)?;
        applied.steps.push(Undo::Renamed {
            from: plan.src.clone(),
            to: plan.dest.clone(),
        });
        applied.forget.push(plan.src.clone());
    }
    if let Some(line) = read_first_line(&plan.dest)? {
        if let Some(rewritten) = header_with_cwd(&line, &plan.new_cwd) {
            rewrite_first_line(&plan.dest, &rewritten)?;
            applied.steps.push(Undo::HeaderRewritten {
                path: plan.dest.clone(),
                line,
            });
        }
    }
    applied.forget.push(plan.dest.clone());
    if let Some(map) = &plan.session_map {
        if let Some(previous) = read_session_map_entry(map, &plan.session_id) {
            let mut entry = previous.clone();
            if let Some(obj) = entry.as_object_mut() {
                obj.insert(
                    "sessionFile".into(),
                    serde_json::Value::String(plan.dest.to_string_lossy().to_string()),
                );
                obj.insert(
                    "cwd".into(),
                    serde_json::Value::String(plan.new_cwd.clone()),
                );
            }
            write_session_map_entry(map, &plan.session_id, Some(entry))?;
            applied.steps.push(Undo::SessionMapEntry {
                path: map.clone(),
                session_id: plan.session_id.clone(),
                entry: Some(previous),
            });
        }
    }
    Ok(())
}

/// The header line with its `cwd` set to `new_cwd`; `None` when the line is
/// not a pi session header or already says so. The value is replaced in place
/// when its exact JSON appears once, so every other byte of the header stays
/// as pi wrote it; otherwise the header is re-serialized.
pub fn header_with_cwd(line: &str, new_cwd: &str) -> Option<String> {
    let mut header: serde_json::Value = serde_json::from_str(line).ok()?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let old = header
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(str::to_string);
    if old.as_deref() == Some(new_cwd) {
        return None;
    }
    let new_json = serde_json::to_string(new_cwd).ok()?;
    if let Some(old) = &old {
        let old_field = format!("\"cwd\":{}", serde_json::to_string(old).ok()?);
        if line.matches(&old_field).count() == 1 {
            let candidate = line.replacen(&old_field, &format!("\"cwd\":{new_json}"), 1);
            let reparsed: Option<serde_json::Value> = serde_json::from_str(&candidate).ok();
            if reparsed
                .as_ref()
                .and_then(|v| v.get("cwd"))
                .and_then(|c| c.as_str())
                == Some(new_cwd)
            {
                return Some(candidate);
            }
        }
    }
    header
        .as_object_mut()?
        .insert("cwd".into(), serde_json::Value::String(new_cwd.to_string()));
    serde_json::to_string(&header).ok()
}

fn read_session_map_entry(path: &Path, session_id: &str) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(path).ok()?;
    let map: serde_json::Value = serde_json::from_str(&raw).ok()?;
    map.get("sessions")?.get(session_id).cloned()
}

/// Write `entry` for `session_id` into pi-acp's map (`None` removes it), the
/// way pi-acp writes the file: pretty JSON and a trailing newline. Replaced
/// atomically.
fn write_session_map_entry(
    path: &Path,
    session_id: &str,
    entry: Option<serde_json::Value>,
) -> std::io::Result<()> {
    let raw = fs::read_to_string(path)?;
    let mut map: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let sessions = map
        .get_mut("sessions")
        .and_then(|s| s.as_object_mut())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "no sessions in the map")
        })?;
    match entry {
        Some(entry) => {
            sessions.insert(session_id.to_string(), entry);
        }
        None => {
            sessions.remove(session_id);
        }
    }
    let mut text = serde_json::to_string_pretty(&map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    text.push('\n');
    write_atomically(path, text.as_bytes())
}

// ─── Files ───────────────────────────────────────────────────────────────

/// Two paths name the same directory (one may not exist yet).
fn same_directory(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `mkdir -p` with the owner-only mode Claude Code gives its project folders.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// Move whatever sits at `path` aside as `<path>.superseded-<ms>`, as Claude
/// Code does with a destination it finds occupied, so nothing is overwritten.
fn set_aside_existing(path: &Path, applied: &mut Applied) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let millis = chrono::Utc::now().timestamp_millis();
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".superseded-{millis}"));
    let aside = PathBuf::from(name);
    fs::rename(path, &aside)?;
    tracing::warn!(
        "[session-move] destination {} was occupied; set aside at {}",
        path.display(),
        aside.display()
    );
    applied.steps.push(Undo::Renamed {
        from: path.to_path_buf(),
        to: aside,
    });
    Ok(())
}

/// Rename `from` to `to`; across file systems, copy then remove, so the end
/// state is still exactly one copy (a copy that cannot drop its source is
/// removed again and the move fails).
fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            copy_recursively(from, to)?;
            let removed = if from.is_dir() {
                fs::remove_dir_all(from)
            } else {
                fs::remove_file(from)
            };
            if let Err(e) = removed {
                let _ = if to.is_dir() {
                    fs::remove_dir_all(to)
                } else {
                    fs::remove_file(to)
                };
                return Err(e);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
}

fn copy_recursively(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursively(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Append `line` as one JSONL record, starting it on a line of its own.
/// Returns the file's length before.
fn append_line(path: &Path, line: &str) -> std::io::Result<u64> {
    let len = fs::metadata(path)?.len();
    let needs_newline = len > 0 && {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = fs::File::open(path)?;
        file.seek(SeekFrom::Start(len - 1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        last[0] != b'\n'
    };
    let mut file = fs::OpenOptions::new().append(true).open(path)?;
    let mut bytes = Vec::with_capacity(line.len() + 2);
    if needs_newline {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(len)
}

/// The first line of `path`, without its newline (`None`: empty file).
fn read_first_line(path: &Path) -> std::io::Result<Option<String>> {
    let file = fs::File::open(path)?;
    let mut line = String::new();
    let read = BufReader::new(file).read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    while line.ends_with('\n') || line.ends_with('\r') {
        line.pop();
    }
    Ok(Some(line))
}

/// Replace the first line of `path` with `line`, keeping every byte after it.
/// Written to a sibling file and renamed over the original.
fn rewrite_first_line(path: &Path, line: &str) -> std::io::Result<()> {
    let bytes = fs::read(path)?;
    let rest = match bytes.iter().position(|b| *b == b'\n') {
        Some(at) => &bytes[at..],
        None => &[][..],
    };
    let mut out = Vec::with_capacity(line.len() + rest.len());
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(rest);
    write_atomically(path, &out)
}

/// Write `bytes` to `path` through a sibling temp file and a rename. The temp
/// name does not end in `.jsonl`, so no reader ever takes it for a session.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut name = path.as_os_str().to_os_string();
    name.push(".codeg-move.tmp");
    let tmp = PathBuf::from(name);
    let result = write_then_rename(&tmp, path, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_then_rename(tmp: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(tmp, meta.permissions());
    }
    fs::rename(tmp, path)
}

/// Point the symlink `link` at `target`, replacing it in one rename.
fn replace_symlink(link: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut name = link.as_os_str().to_os_string();
        name.push(".codeg-move.tmp");
        let tmp = PathBuf::from(name);
        let _ = fs::remove_file(&tmp);
        std::os::unix::fs::symlink(target, &tmp)?;
        if let Err(e) = fs::rename(&tmp, link) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (link, target);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlinks are not re-pointed on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    fn claude_roots(root: &Path) -> ClaudeRoots {
        ClaudeRoots {
            config_dir: root.join("claude-config"),
            temp_root: Some(root.join("claude-tmp")),
        }
    }

    fn write_claude_session(roots: &ClaudeRoots, cwd: &str, id: &str) -> PathBuf {
        let dir = roots
            .config_dir
            .join("projects")
            .join(crate::commands::quick_ask::claude_project_dir_name(cwd));
        fs::create_dir_all(dir.join(id).join("subagents")).unwrap();
        fs::write(
            dir.join(id).join("subagents").join("agent-a1.jsonl"),
            "{}\n",
        )
        .unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        let record = serde_json::json!({
            "type": "user",
            "sessionId": id,
            "cwd": cwd,
            "timestamp": "2020-01-01T10:00:00.000Z",
            "message": {"role": "user", "content": "hello"},
        });
        fs::write(&path, format!("{record}\n")).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_claude_session_moves_with_its_folder_and_a_relocated_record() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = claude_roots(tmp.path());
        let old = write_claude_session(&roots, "/work/old", SID);
        let old_folder = old.parent().unwrap().join(SID);
        // A task-output link in the temp folder into the session's folder.
        let tasks = roots
            .temp_root
            .as_ref()
            .unwrap()
            .join("-work-old")
            .join(SID)
            .join("tasks");
        fs::create_dir_all(&tasks).unwrap();
        let link = tasks.join("a1.output");
        std::os::unix::fs::symlink(old_folder.join("subagents/agent-a1.jsonl"), &link).unwrap();

        let plan = plan_claude(&roots, SID, "/work/new").expect("a plan");
        let applied = apply_all(&[Plan::Claude(plan)]).expect("applied");
        applied.commit();

        let new_dir = roots.config_dir.join("projects").join("-work-new");
        let moved = new_dir.join(format!("{SID}.jsonl"));
        assert!(!old.exists(), "moved, not copied");
        assert!(!old_folder.exists());
        assert!(new_dir.join(SID).join("subagents/agent-a1.jsonl").exists());
        let text = fs::read_to_string(&moved).unwrap();
        let last: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(
            last,
            serde_json::json!({"type": "relocated", "sessionId": SID, "relocatedCwd": "/work/new"})
        );
        assert_eq!(
            fs::read_link(&link).unwrap(),
            new_dir.join(SID).join("subagents/agent-a1.jsonl")
        );
        // The parser now files it under the new directory.
        assert_eq!(
            crate::parsers::claude::find_session_file_in(&roots.config_dir.join("projects"), SID),
            Some(moved)
        );
    }

    #[test]
    fn an_occupied_destination_is_set_aside_and_a_failure_rolls_everything_back() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = claude_roots(tmp.path());
        let old = write_claude_session(&roots, "/work/old", SID);
        let original = fs::read(&old).unwrap();
        let new_dir = roots.config_dir.join("projects").join("-work-new");
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(format!("{SID}.jsonl")), "stale\n").unwrap();

        let plan = plan_claude(&roots, SID, "/work/new").expect("a plan");
        let applied = apply_all(&[Plan::Claude(plan)]).expect("applied");
        let aside: Vec<_> = fs::read_dir(&new_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".superseded-"))
            .collect();
        assert_eq!(aside.len(), 1, "the stale file is kept, aside");

        applied.rollback();
        assert_eq!(fs::read(&old).unwrap(), original, "back as it was");
        assert!(old.parent().unwrap().join(SID).is_dir());
        assert_eq!(
            fs::read_to_string(new_dir.join(format!("{SID}.jsonl"))).unwrap(),
            "stale\n",
            "the set-aside file is restored"
        );
    }

    #[test]
    fn a_clear_rollover_successor_moves_too() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = claude_roots(tmp.path());
        let old = write_claude_session(&roots, "/work/old", SID);
        let dir = old.parent().unwrap().to_path_buf();
        let successor = "99999999-2222-4333-8444-555555555555";
        let clear = serde_json::json!({
            "type": "user",
            "sessionId": successor,
            "cwd": "/work/old",
            "timestamp": "2020-01-01T10:00:00.004Z",
            "message": {"role": "user", "content": "<command-name>/clear</command-name>"},
        });
        fs::write(dir.join(format!("{successor}.jsonl")), format!("{clear}\n")).unwrap();

        let plan = plan_claude(&roots, SID, "/work/new").expect("a plan");
        assert_eq!(plan.chain.len(), 2);
        apply_all(&[Plan::Claude(plan)]).expect("applied").commit();
        let new_dir = roots.config_dir.join("projects").join("-work-new");
        assert!(new_dir.join(format!("{successor}.jsonl")).exists());
        assert!(!dir.join(format!("{successor}.jsonl")).exists());
    }

    #[test]
    fn moving_back_lands_where_it_started() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = claude_roots(tmp.path());
        let old = write_claude_session(&roots, "/work/old", SID);
        let there = plan_claude(&roots, SID, "/work/new").unwrap();
        apply_all(&[Plan::Claude(there)]).unwrap().commit();
        let back = plan_claude(&roots, SID, "/work/old").unwrap();
        apply_all(&[Plan::Claude(back)]).unwrap().commit();
        assert!(old.exists());
        let last: serde_json::Value =
            serde_json::from_str(fs::read_to_string(&old).unwrap().lines().last().unwrap())
                .unwrap();
        assert_eq!(last["relocatedCwd"], "/work/old");
    }

    #[test]
    fn the_sdk_check_reads_the_adapter_s_own_sdk() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp
            .path()
            .join("lib/node_modules/@agentclientprotocol/claude-agent-acp");
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"name":"@agentclientprotocol/claude-agent-acp","version":"0.94.0"}"#,
        )
        .unwrap();
        fs::write(root.join("dist/index.js"), "").unwrap();
        let sdk = root.join("node_modules/@anthropic-ai/claude-agent-sdk");
        fs::create_dir_all(&sdk).unwrap();
        fs::write(sdk.join("sdk.mjs"), "function a(){}").unwrap();
        assert_eq!(
            sdk_reads_relocation(&root.join("dist/index.js")),
            Some(false)
        );
        fs::write(
            sdk.join("sdk.mjs"),
            r#"if(e.type==="relocated"&&typeof e.relocatedCwd==="string")"#,
        )
        .unwrap();
        assert_eq!(
            sdk_reads_relocation(&root.join("dist/index.js")),
            Some(true)
        );
        assert_eq!(sdk_reads_relocation(&tmp.path().join("nope")), None);
    }

    #[test]
    fn no_transcript_no_plan() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(plan_claude(&claude_roots(tmp.path()), SID, "/work/new").is_none());
        assert!(plan_claude(&claude_roots(tmp.path()), "../escape", "/work/new").is_none());
    }

    fn write_pi_session(sessions: &Path, cwd: &str, id: &str) -> PathBuf {
        let dir = sessions.join(pi_bucket_name(cwd));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("2026-11-11T10-00-00-000Z_{id}.jsonl"));
        let header = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-11-11T10:00:00.000Z\",\"cwd\":{}}}",
            serde_json::to_string(cwd).unwrap()
        );
        fs::write(
            &path,
            format!("{header}\n{{\"type\":\"message\",\"id\":\"m1\"}}\n"),
        )
        .unwrap();
        path
    }

    #[test]
    fn the_pi_bucket_matches_pi_s_own_encoding() {
        assert_eq!(
            pi_bucket_name("/Users/me/Work/app"),
            "--Users-me-Work-app--"
        );
        assert_eq!(
            pi_bucket_name("/Users/me/Application Support/x"),
            "--Users-me-Application Support-x--"
        );
        assert_eq!(pi_bucket_name("C:\\work\\app"), "--C--work-app--");
    }

    #[test]
    fn a_pi_session_moves_into_the_new_bucket_with_its_header_and_map_updated() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let old = write_pi_session(&sessions, "/work/old", SID);
        let map = tmp.path().join("session-map.json");
        let entry = serde_json::json!({
            "sessionId": SID,
            "cwd": "/work/old",
            "sessionFile": old.to_string_lossy(),
            "updatedAt": "2026-11-11T10:00:00.000Z",
        });
        fs::write(
            &map,
            serde_json::to_string_pretty(
                &serde_json::json!({"version": 1, "sessions": {SID: entry}}),
            )
            .unwrap(),
        )
        .unwrap();
        let roots = PiRoots {
            sessions_dir: sessions.clone(),
            session_map: Some(map.clone()),
        };
        let plan = plan_pi(&roots, SID, "/work/new").expect("a plan");
        let applied = apply_all(&[Plan::Pi(plan)]).expect("applied");

        let moved = sessions.join("--work-new--").join(old.file_name().unwrap());
        assert!(!old.exists());
        let text = fs::read_to_string(&moved).unwrap();
        let mut lines = text.lines();
        let header = lines.next().unwrap();
        assert!(header.contains("\"cwd\":\"/work/new\""), "{header}");
        assert!(
            header.starts_with("{\"type\":\"session\",\"version\":3"),
            "order kept"
        );
        assert_eq!(lines.next(), Some("{\"type\":\"message\",\"id\":\"m1\"}"));
        let stored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&map).unwrap()).unwrap();
        assert_eq!(
            stored["sessions"][SID]["sessionFile"],
            moved.to_string_lossy().as_ref()
        );
        assert_eq!(stored["sessions"][SID]["cwd"], "/work/new");

        applied.rollback();
        assert!(old.exists());
        assert!(fs::read_to_string(&old)
            .unwrap()
            .contains("\"cwd\":\"/work/old\""));
        let stored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&map).unwrap()).unwrap();
        assert_eq!(
            stored["sessions"][SID]["sessionFile"],
            old.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn a_flat_pi_session_dir_keeps_the_file_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let flat = tmp.path().join("flat");
        fs::create_dir_all(&flat).unwrap();
        let path = flat.join(format!("2026-11-11T10-00-00-000Z_{SID}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{SID}\",\"cwd\":\"/work/old\"}}\n"
            ),
        )
        .unwrap();
        let roots = PiRoots {
            sessions_dir: flat,
            session_map: None,
        };
        let plan = plan_pi(&roots, SID, "/work/new").unwrap();
        apply_all(&[Plan::Pi(plan)]).unwrap().commit();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"cwd\":\"/work/new\""));
    }

    #[test]
    fn a_header_with_an_odd_shape_is_still_rewritten() {
        let line = "{\"cwd\" : \"/a\",\"type\":\"session\",\"id\":\"x\"}";
        let out = header_with_cwd(line, "/b").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["cwd"], "/b");
        assert_eq!(v["id"], "x");
        assert!(header_with_cwd("{\"type\":\"message\"}", "/b").is_none());
        assert!(header_with_cwd("{\"type\":\"session\",\"cwd\":\"/b\"}", "/b").is_none());
    }
}
