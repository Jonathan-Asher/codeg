//! A `codeg-server` must never touch a data dir that another codeg process
//! owns, and its flags must never start it.
//!
//! Spawns the real binaries, always with a cleared environment and a scratch
//! HOME, data dir and port of their own: never the user's data dir or port
//! 3080, even when the tests run inside a codeg session that exports both.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use codeg_lib::data_dir_owner;
use codeg_lib::db::entities::conversation;
use codeg_lib::db::service::{conversation_service, folder_service};
use codeg_lib::db::AppDatabase;
use codeg_lib::models::agent::AgentType;
use sea_orm::EntityTrait;

const SERVER: &str = env!("CARGO_BIN_EXE_codeg-server");
const MCP: &str = env!("CARGO_BIN_EXE_codeg-mcp");

/// A scratch root for the HOME and data dir handed to a binary. Neither exists
/// until something creates it.
struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().expect("temp dir"),
        }
    }

    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    fn data_dir(&self) -> PathBuf {
        self.root.path().join("data")
    }

    /// `exe` with nothing inherited: this sandbox's HOME and data dir, and a
    /// loopback port nothing listens on.
    fn command(&self, exe: &str) -> Command {
        let mut command = Command::new(exe);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.home())
            .env("CODEG_DATA_DIR", self.data_dir())
            .env("CODEG_HOST", "127.0.0.1")
            .env("CODEG_PORT", free_port().to_string())
            .stdin(std::process::Stdio::null());
        command
    }

    /// Every path under the root, sorted.
    fn contents(&self) -> Vec<PathBuf> {
        walk(self.root.path())
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("free port")
        .port()
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                pending.push(path.clone());
            }
            found.push(path);
        }
    }
    found.sort();
    found
}

fn describe(out: &Output) -> String {
    format!(
        "exit {:?}, stdout {:?}, stderr {:?}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn help_and_version_print_and_touch_nothing() {
    let version = env!("CARGO_PKG_VERSION");
    let cases: [(&[&str], &str); 5] = [
        (&["--help"], "Usage: codeg-server"),
        (&["-h"], "Usage: codeg-server"),
        (&["--supervise", "--help"], "Usage: codeg-server"),
        (&["--version"], version),
        (&["-V"], version),
    ];
    for (args, expected) in cases {
        let sandbox = Sandbox::new();
        let out = sandbox
            .command(SERVER)
            .args(args)
            .output()
            .expect("run codeg-server");
        assert!(out.status.success(), "{args:?}: {}", describe(&out));
        assert!(
            String::from_utf8_lossy(&out.stdout).contains(expected),
            "{args:?}: {}",
            describe(&out)
        );
        assert_eq!(
            sandbox.contents(),
            Vec::<PathBuf>::new(),
            "{args:?} created files"
        );
    }
}

#[test]
fn an_unknown_flag_prints_the_usage_exits_2_and_touches_nothing() {
    let sandbox = Sandbox::new();
    let out = sandbox
        .command(SERVER)
        .args(["--port", "4000"])
        .output()
        .expect("run codeg-server");
    assert_eq!(out.status.code(), Some(2), "{}", describe(&out));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("unknown option '--port'"), "{stderr}");
    assert!(stderr.contains("Usage: codeg-server"), "{stderr}");
    assert!(out.stdout.is_empty(), "{}", describe(&out));
    assert_eq!(sandbox.contents(), Vec::<PathBuf>::new());
}

#[test]
fn codeg_mcp_flags_print_and_exit() {
    let sandbox = Sandbox::new();
    let run = |args: &[&str]| {
        sandbox
            .command(MCP)
            .args(args)
            .output()
            .expect("run codeg-mcp")
    };

    let version = run(&["--version"]);
    assert!(version.status.success(), "{}", describe(&version));
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        env!("CARGO_PKG_VERSION")
    );
    let help = run(&["-h"]);
    assert!(help.status.success(), "{}", describe(&help));
    assert!(String::from_utf8_lossy(&help.stdout).contains("Usage: codeg-mcp"));
    let unknown = run(&["--bogus"]);
    assert_eq!(unknown.status.code(), Some(2), "{}", describe(&unknown));
    let stderr = String::from_utf8_lossy(&unknown.stderr);
    assert!(stderr.contains("unknown arg: --bogus"), "{stderr}");
    assert!(stderr.contains("Usage: codeg-mcp"), "{stderr}");
    assert_eq!(sandbox.contents(), Vec::<PathBuf>::new());
}

async fn stored(db: &AppDatabase, id: i32) -> conversation::Model {
    conversation::Entity::find_by_id(id)
        .one(&db.conn)
        .await
        .expect("query")
        .expect("row")
}

/// The incident: an agent session inherited the desktop app's data dir and
/// started a server in it. That server must leave the app's running turn — and
/// everything else in the dir — exactly as it was.
#[tokio::test(flavor = "current_thread")]
async fn a_server_leaves_a_data_dir_another_codeg_owns_exactly_as_it_was() {
    let sandbox = Sandbox::new();
    let data_dir = sandbox.data_dir();
    // This test process opens the dir first and keeps it open, as the desktop
    // app had: the owner the server must defer to.
    let db = codeg_lib::db::init_database(&data_dir, "owner")
        .await
        .expect("open the data dir");
    let folder = folder_service::add_folder(&db.conn, "/tmp/single-owner")
        .await
        .expect("folder")
        .id;
    let id = conversation_service::create(&db.conn, folder, AgentType::ClaudeCode, None, None)
        .await
        .expect("conversation")
        .id;
    assert!(conversation_service::mark_turn_running(&db.conn, id)
        .await
        .expect("mark running"));
    let before = stored(&db, id).await;
    let files_before = walk(&data_dir);

    // `--help` against it opens nothing either.
    let help = sandbox
        .command(SERVER)
        .arg("--help")
        .output()
        .expect("run codeg-server --help");
    assert!(help.status.success(), "{}", describe(&help));

    let started = Instant::now();
    let second = sandbox
        .command(SERVER)
        .output()
        .expect("run codeg-server");
    assert_eq!(
        second.status.code(),
        Some(i32::from(data_dir_owner::EXIT_IN_USE)),
        "{}",
        describe(&second)
    );
    let stderr = String::from_utf8_lossy(&second.stderr);
    assert_eq!(stderr.lines().count(), 1, "one line: {stderr}");
    assert!(
        stderr.contains(&data_dir.display().to_string()),
        "names the data dir: {stderr}"
    );
    assert!(
        stderr.contains(&format!("pid {}", std::process::id())),
        "names the owner: {stderr}"
    );
    // It gave an owner on its way out the time to go, then stopped.
    assert!(
        started.elapsed() >= data_dir_owner::HANDOFF_GRACE - Duration::from_millis(100),
        "gave up after {:?}",
        started.elapsed()
    );

    assert_eq!(
        stored(&db, id).await,
        before,
        "the running turn is exactly as it was"
    );
    assert_eq!(
        walk(&data_dir),
        files_before,
        "nothing created in the data dir: no logs, no files"
    );
    assert!(!sandbox.home().exists(), "nothing created under HOME");
}

/// The other side: a server alone with its data dir claims it — the lock file
/// names it — and sweeps what the last exit left running. Server builds only:
/// a full start in a desktop build may reach the OS keychain, which CI must
/// not.
#[cfg(not(feature = "tauri-runtime"))]
#[tokio::test(flavor = "current_thread")]
async fn a_lone_server_claims_its_data_dir_and_sweeps_it() {
    use codeg_lib::db::entities::conversation::ConversationTurnState;
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    /// Kills the server however the test ends.
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let sandbox = Sandbox::new();
    let data_dir = sandbox.data_dir();
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    let url = format!(
        "sqlite:{}?mode=rwc",
        data_dir
            .join(codeg_lib::db::database_file_name())
            .display()
    );

    // What a process that crashed mid-turn leaves: a running turn, and no lock
    // held. Written without claiming the dir.
    let conn = Database::connect(url.as_str()).await.expect("open");
    codeg_lib::db::migration::Migrator::up(&conn, None)
        .await
        .expect("migrate");
    let folder = folder_service::add_folder(&conn, "/tmp/single-owner")
        .await
        .expect("folder")
        .id;
    let id = conversation_service::create(&conn, folder, AgentType::ClaudeCode, None, None)
        .await
        .expect("conversation")
        .id;
    assert!(conversation_service::mark_turn_running(&conn, id)
        .await
        .expect("mark running"));
    conn.close().await.expect("close");

    let static_dir = sandbox.root.path().join("web");
    std::fs::create_dir_all(&static_dir).expect("static dir");
    let log_path = sandbox.root.path().join("server.log");
    let log = std::fs::File::create(&log_path).expect("log file");
    let mut server = Running(
        sandbox
            .command(SERVER)
            .env("CODEG_STATIC_DIR", &static_dir)
            .env("CODEG_TOKEN", "single-owner-test")
            .stdout(std::process::Stdio::null())
            .stderr(log)
            .spawn()
            .expect("spawn codeg-server"),
    );
    let server_log = || std::fs::read_to_string(&log_path).unwrap_or_default();

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = server.0.try_wait().expect("poll the server") {
            panic!("the server exited ({status}):\n{}", server_log());
        }
        let conn = Database::connect(url.as_str()).await.expect("open");
        let row = conversation::Entity::find_by_id(id)
            .one(&conn)
            .await
            .expect("query")
            .expect("row");
        conn.close().await.expect("close");
        if row.turn_state == Some(ConversationTurnState::Interrupted) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the start never swept the running turn:\n{}",
            server_log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let recorded = std::fs::read_to_string(data_dir_owner::lock_path(&data_dir))
        .expect("read the lock file");
    assert_eq!(recorded.trim(), server.0.id().to_string(), "{}", server_log());
}
