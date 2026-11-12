//! Which registered devices get a notification: each device's own
//! preferences, and whether the user is away.
//!
//! | Pref            | Options                          | Default          |
//! |-----------------|----------------------------------|------------------|
//! | turn finished   | always / only when away / off    | only when away   |
//! | needs you       | always / only when away / off    | only when away   |
//! | critical alerts | on / off                         | on               |
//! | errors          | on / off                         | off              |
//!
//! "Away" is `crate::presence`'s: no desktop or web window is visible,
//! focused and recently used. Whatever the prefs say, nothing is pushed about
//! a session some client is showing to a user who is looking at it.
//!
//! Reminders of a pending item (`crate::pending`) are "needs you" pushes that
//! treat "only when away" as "always": they are the alerts for when the first
//! one went unanswered. "Off" still means off.
//!
//! Each device also names the sound each kind of notification plays on it
//! ([`DeviceSounds`]); the iOS app sends them with its registration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::payload::PushKind;
use crate::presence::Looking;

/// When a kind of notification is pushed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Always,
    /// Only while the user is away from every desktop and web window.
    Away,
    Off,
}

impl Delivery {
    fn allows(self, away: bool) -> bool {
        match self {
            Delivery::Always => true,
            Delivery::Away => away,
            Delivery::Off => false,
        }
    }
}

/// One device's notification preferences (stored as JSON on its row).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DevicePrefs {
    pub turn_finished: Delivery,
    pub needs_you: Delivery,
    pub critical: bool,
    pub errors: bool,
}

impl Default for DevicePrefs {
    fn default() -> Self {
        Self {
            turn_finished: Delivery::Away,
            needs_you: Delivery::Away,
            critical: true,
            errors: false,
        }
    }
}

impl DevicePrefs {
    /// Parse a stored row; a missing or unreadable value reads as the
    /// defaults.
    pub fn from_json(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_default()
    }

    pub fn to_json(self) -> String {
        serde_json::to_string(&self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Whether this device wants `kind`, given whether the user is away.
    pub fn wants(&self, kind: PushKind, away: bool) -> bool {
        match kind {
            PushKind::TurnFinished => self.turn_finished.allows(away),
            PushKind::NeedsYou => self.needs_you.allows(away),
            PushKind::Critical => self.critical,
            PushKind::Error => self.errors,
            // A silent badge update tells nothing; every device keeps its
            // count right.
            PushKind::Test | PushKind::Badge => true,
        }
    }
}

/// Whether a notification about `conversation_id` goes out at all: not when
/// somebody is looking at that very session.
pub fn session_unseen(conversation_id: Option<i32>, looking: &Looking) -> bool {
    conversation_id.is_none_or(|id| !looking.at(id))
}

/// The devices a notification goes to: those whose prefs want it, unless
/// the user is looking at the session it is about.
pub fn choose<'a, D>(
    devices: &'a [D],
    prefs_of: impl Fn(&D) -> DevicePrefs,
    kind: PushKind,
    conversation_id: Option<i32>,
    looking: &Looking,
) -> Vec<&'a D> {
    if kind != PushKind::Test && !session_unseen(conversation_id, looking) {
        return Vec::new();
    }
    let away = looking.away();
    devices
        .iter()
        .filter(|device| prefs_of(device).wants(kind, away))
        .collect()
}

// ── Sounds ──

/// The kinds of notification a device gives a sound each: one per row of the
/// iOS app's Settings › Notifications › Sounds.
///
/// | Slot            | Pushes                                                        |
/// |-----------------|---------------------------------------------------------------|
/// | `needs_you`     | a question or a permission request (first push and catch-up)  |
/// | `plan`          | a plan waiting for approval, also one asked as a permission   |
/// | `reminder`      | every reminder of an item still waiting                       |
/// | `turn_finished` | a turn that finished, and the test push                       |
/// | `critical`      | a critical session's alert, whatever its kind                 |
/// | `error`         | an error that broke a session                                 |
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SoundSlot {
    NeedsYou,
    Plan,
    Reminder,
    TurnFinished,
    Critical,
    Error,
}

impl SoundSlot {
    pub const ALL: [SoundSlot; 6] = [
        SoundSlot::NeedsYou,
        SoundSlot::Plan,
        SoundSlot::Reminder,
        SoundSlot::TurnFinished,
        SoundSlot::Critical,
        SoundSlot::Error,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SoundSlot::NeedsYou => "needs_you",
            SoundSlot::Plan => "plan",
            SoundSlot::Reminder => "reminder",
            SoundSlot::TurnFinished => "turn_finished",
            SoundSlot::Critical => "critical",
            SoundSlot::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|slot| slot.as_str() == raw)
    }
}

/// Longest sound file name a device may choose.
pub const MAX_SOUND_NAME_CHARS: usize = 64;

/// The file types iOS plays as a notification sound.
const SOUND_EXTENSIONS: &[&str] = &["caf", "wav", "aiff"];

/// Most project sounds, and most session sounds, a device keeps on a server.
pub const MAX_SOUND_OVERRIDES: usize = 500;

/// Whether `name` can go out as `aps.sound`: the name of a file the app ships
/// or keeps in its `Library/Sounds`, never a path. ASCII letters, digits, `-`,
/// `_` and `.`, starting with a letter or a digit, no `..`, a `.caf`, `.wav`
/// or `.aiff` extension, 64 characters at most.
pub fn is_sound_file_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    name.len() <= MAX_SOUND_NAME_CHARS
        && !stem.is_empty()
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && SOUND_EXTENSIONS
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
}

/// What a notification sounds like on a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoundChoice {
    /// The iOS default sound: `"default"`. For a project, a session or the
    /// critical sessions, `"default"` means "as the next level says" instead.
    Default,
    /// No sound; the notification still shows: `"none"`.
    Silent,
    /// A sound file of the app (see [`is_sound_file_name`]).
    File(String),
}

impl SoundChoice {
    /// `"default"`, `"none"` or a sound file name; anything else is refused.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "default" => Some(SoundChoice::Default),
            "none" => Some(SoundChoice::Silent),
            name if is_sound_file_name(name) => Some(SoundChoice::File(name.to_string())),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            SoundChoice::Default => "default",
            SoundChoice::Silent => "none",
            SoundChoice::File(name) => name,
        }
    }

    /// `aps.sound`: the sound iOS plays, or nothing for silence.
    pub fn aps_sound(&self) -> Option<&str> {
        match self {
            SoundChoice::Default => Some("default"),
            SoundChoice::Silent => None,
            SoundChoice::File(name) => Some(name),
        }
    }
}

/// The key of a device row's `prefs` JSON that holds its [`DeviceSounds`].
const SOUNDS_KEY: &str = "sounds";

/// What a kind nobody chose a sound for plays.
static DEFAULT_SOUND: SoundChoice = SoundChoice::Default;

/// What a push's sound depends on besides the push and the device.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SoundContext {
    /// Its session is marked critical.
    pub critical_session: bool,
    /// Its folder's root folder, when that is a worktree folder: a project's
    /// sound covers its worktrees, as the folder lists show them under it.
    pub root_folder_id: Option<i32>,
}

/// A device's sounds on this server: one per kind of notification, and over
/// those, the ones chosen for every session marked critical, for a project
/// (folder) and for a session (conversation), by this server's ids. A kind
/// it left alone plays the default sound; an override it left alone defers
/// to the next level ([`DeviceSounds::resolve`]).
///
/// Kept next to its [`DevicePrefs`] in the row's `prefs` JSON, under
/// `sounds`, in the shape clients send and read:
///
/// ```json
/// { "kinds": { "needs_you": "codeg-chime.caf", "turn_finished": "none" },
///   "critical": "codeg-bell.caf",
///   "projects": { "7": "codeg-glass.caf" },
///   "sessions": { "42": "none" } }
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceSounds {
    kinds: BTreeMap<SoundSlot, SoundChoice>,
    /// Every notification of a session marked critical. Never `Default`.
    critical: Option<SoundChoice>,
    /// By folder id. Never `Default`.
    projects: BTreeMap<i32, SoundChoice>,
    /// By conversation id. Never `Default`.
    sessions: BTreeMap<i32, SoundChoice>,
}

/// An override's choice: `Ok(None)` defers (`"default"`), `Ok(Some(_))` is
/// silence or a file, `Err(())` cannot be played.
fn override_choice(value: &Value) -> Result<Option<SoundChoice>, ()> {
    match value.as_str().and_then(SoundChoice::parse) {
        Some(SoundChoice::Default) => Ok(None),
        Some(choice) => Ok(Some(choice)),
        None => Err(()),
    }
}

/// A key as a rejected entry names it.
fn entry_name(section: &str, key: &str) -> String {
    format!("{section}.{}", key.chars().take(40).collect::<String>())
}

/// Read `{id: choice}` into `into`, naming what cannot be used.
fn read_overrides(
    raw: Option<&Value>,
    section: &str,
    into: &mut BTreeMap<i32, SoundChoice>,
    rejected: &mut Vec<String>,
) {
    let Some(entries) = raw.and_then(Value::as_object) else {
        return;
    };
    for (key, value) in entries {
        let id = key.parse::<i32>().ok().filter(|id| *id > 0);
        match (id, override_choice(value)) {
            (Some(_), Ok(None)) => {}
            (Some(id), Ok(Some(choice))) if into.len() < MAX_SOUND_OVERRIDES => {
                into.insert(id, choice);
            }
            _ => rejected.push(entry_name(section, key)),
        }
    }
}

fn overrides_to_wire(overrides: &BTreeMap<i32, SoundChoice>) -> Value {
    Value::Object(
        overrides
            .iter()
            .map(|(id, choice)| (id.to_string(), Value::from(choice.as_str())))
            .collect(),
    )
}

impl DeviceSounds {
    /// Read a client's sounds. What cannot be used is left out and named in
    /// the second value (sorted): an unknown kind (a newer app's), an id that
    /// is not one, a choice that is not `"default"`, `"none"` or a sound file
    /// name (a path, another file type, a long name). `"default"` is the same
    /// as leaving the entry out. Anything but an object reads as no sounds.
    pub fn from_wire(raw: &Value) -> (Self, Vec<String>) {
        let mut sounds = Self::default();
        let mut rejected = Vec::new();
        let Some(raw) = raw.as_object() else {
            return (sounds, rejected);
        };
        if let Some(kinds) = raw.get("kinds").and_then(Value::as_object) {
            for (key, value) in kinds {
                let slot = SoundSlot::parse(key);
                match (slot, value.as_str().and_then(SoundChoice::parse)) {
                    (Some(_), Some(SoundChoice::Default)) => {}
                    (Some(slot), Some(choice)) => {
                        sounds.kinds.insert(slot, choice);
                    }
                    _ => rejected.push(entry_name("kinds", key)),
                }
            }
        }
        match raw.get("critical") {
            None | Some(Value::Null) => {}
            Some(value) => match override_choice(value) {
                Ok(choice) => sounds.critical = choice,
                Err(()) => rejected.push("critical".to_string()),
            },
        }
        read_overrides(
            raw.get("projects"),
            "projects",
            &mut sounds.projects,
            &mut rejected,
        );
        read_overrides(
            raw.get("sessions"),
            "sessions",
            &mut sounds.sessions,
            &mut rejected,
        );
        rejected.sort();
        (sounds, rejected)
    }

    /// The shape clients read: `kinds`, `projects` and `sessions` always,
    /// `critical` when chosen; entries that play the default sound or defer
    /// are left out.
    pub fn to_wire(&self) -> Value {
        let kinds = self
            .kinds
            .iter()
            .map(|(slot, choice)| (slot.as_str().to_string(), Value::from(choice.as_str())))
            .collect();
        let mut wire = Map::new();
        wire.insert("kinds".into(), Value::Object(kinds));
        if let Some(choice) = &self.critical {
            wire.insert("critical".into(), Value::from(choice.as_str()));
        }
        wire.insert("projects".into(), overrides_to_wire(&self.projects));
        wire.insert("sessions".into(), overrides_to_wire(&self.sessions));
        Value::Object(wire)
    }

    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
            && self.critical.is_none()
            && self.projects.is_empty()
            && self.sessions.is_empty()
    }

    /// What a notification of `slot` plays when nothing overrides it.
    pub fn kind(&self, slot: SoundSlot) -> &SoundChoice {
        self.kinds.get(&slot).unwrap_or(&DEFAULT_SOUND)
    }

    /// Whether a sound was chosen for the critical sessions: only then does a
    /// push need to know whether its session is one.
    pub fn has_critical(&self) -> bool {
        self.critical.is_some()
    }

    /// Whether a sound was chosen for a project: only then does a push need
    /// its folder's root folder.
    pub fn has_projects(&self) -> bool {
        !self.projects.is_empty()
    }

    /// What a notification about `conversation_id` in `folder_id` plays,
    /// highest first: the sound chosen for that session, for its folder, for
    /// its folder's root folder (a worktree's project), for every critical
    /// session (when its session is one), then for its kind.
    pub fn resolve(
        &self,
        conversation_id: Option<i32>,
        folder_id: Option<i32>,
        context: SoundContext,
        slot: SoundSlot,
    ) -> &SoundChoice {
        conversation_id
            .and_then(|id| self.sessions.get(&id))
            .or_else(|| folder_id.and_then(|id| self.projects.get(&id)))
            .or_else(|| context.root_folder_id.and_then(|id| self.projects.get(&id)))
            .or_else(|| self.critical.as_ref().filter(|_| context.critical_session))
            .unwrap_or_else(|| self.kind(slot))
    }

    /// The folders named by a project sound.
    pub fn project_ids(&self) -> Vec<i32> {
        self.projects.keys().copied().collect()
    }

    /// The conversations named by a session sound.
    pub fn session_ids(&self) -> Vec<i32> {
        self.sessions.keys().copied().collect()
    }

    /// Keep the project and session sounds whose folder and conversation
    /// pass `folder` and `conversation` (the ones this server still has).
    pub fn retain_ids(&mut self, folder: impl Fn(i32) -> bool, conversation: impl Fn(i32) -> bool) {
        self.projects.retain(|id, _| folder(*id));
        self.sessions.retain(|id, _| conversation(*id));
    }

    /// The sounds kept in a device row's `prefs` column; none when it holds
    /// none or cannot be read.
    pub fn from_prefs_json(raw: &str) -> Self {
        serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| {
                value
                    .get(SOUNDS_KEY)
                    .map(|sounds| Self::from_wire(sounds).0)
            })
            .unwrap_or_default()
    }
}

/// A device row's `prefs` column as stored: the preferences, then the sounds.
#[derive(Serialize)]
struct StoredPrefs {
    #[serde(flatten)]
    prefs: DevicePrefs,
    #[serde(skip_serializing_if = "Option::is_none")]
    sounds: Option<Value>,
}

/// The `prefs` column for a device with `prefs` and `sounds`. The desktop's
/// settings change the preferences and the registration the sounds, so the
/// one written always carries the other over from the row. Without sounds it
/// is [`DevicePrefs::to_json`].
pub fn stored_prefs_json(prefs: DevicePrefs, sounds: &DeviceSounds) -> String {
    serde_json::to_string(&StoredPrefs {
        prefs,
        sounds: (!sounds.is_empty()).then(|| sounds.to_wire()),
    })
    .unwrap_or_else(|_| prefs.to_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    fn looking(anyone: bool, at: &[i32]) -> Looking {
        Looking {
            anyone,
            conversations: at.iter().copied().collect::<HashSet<_>>(),
        }
    }

    #[test]
    fn defaults_push_needs_you_and_turns_only_when_away_and_critical_always() {
        let prefs = DevicePrefs::default();
        assert!(prefs.wants(PushKind::TurnFinished, true));
        assert!(!prefs.wants(PushKind::TurnFinished, false));
        assert!(prefs.wants(PushKind::NeedsYou, true));
        assert!(!prefs.wants(PushKind::NeedsYou, false));
        assert!(prefs.wants(PushKind::Critical, false));
        assert!(!prefs.wants(PushKind::Error, true));
        assert!(prefs.wants(PushKind::Test, false));
    }

    #[test]
    fn always_and_off_ignore_presence() {
        let prefs = DevicePrefs {
            turn_finished: Delivery::Always,
            needs_you: Delivery::Off,
            critical: false,
            errors: true,
        };
        assert!(prefs.wants(PushKind::TurnFinished, false));
        assert!(!prefs.wants(PushKind::NeedsYou, true));
        assert!(!prefs.wants(PushKind::Critical, true));
        assert!(prefs.wants(PushKind::Error, false));
    }

    #[test]
    fn prefs_round_trip_and_old_rows_read_as_defaults() {
        let prefs = DevicePrefs {
            turn_finished: Delivery::Off,
            ..DevicePrefs::default()
        };
        assert_eq!(DevicePrefs::from_json(&prefs.to_json()), prefs);
        assert_eq!(
            prefs.to_json(),
            r#"{"turn_finished":"off","needs_you":"away","critical":true,"errors":false}"#
        );
        assert_eq!(DevicePrefs::from_json("{}"), DevicePrefs::default());
        assert_eq!(DevicePrefs::from_json("garbage"), DevicePrefs::default());
        assert_eq!(
            DevicePrefs::from_json(r#"{"errors":true}"#),
            DevicePrefs {
                errors: true,
                ..DevicePrefs::default()
            }
        );
    }

    fn names<'a>(chosen: Vec<&'a (&'a str, DevicePrefs)>) -> Vec<&'a str> {
        chosen.into_iter().map(|(name, _)| *name).collect()
    }

    #[test]
    fn choose_picks_devices_by_prefs_and_presence() {
        let phone = DevicePrefs::default();
        let ipad = DevicePrefs {
            turn_finished: Delivery::Always,
            ..DevicePrefs::default()
        };
        let quiet = DevicePrefs {
            turn_finished: Delivery::Off,
            critical: false,
            ..DevicePrefs::default()
        };
        let devices = vec![("phone", phone), ("ipad", ipad), ("quiet", quiet)];

        // Away: both that want turns get one.
        let away = looking(false, &[]);
        assert_eq!(
            names(choose(
                &devices,
                |d| d.1,
                PushKind::TurnFinished,
                Some(1),
                &away
            )),
            vec!["phone", "ipad"]
        );
        // At the desk, looking at another session: only "always".
        let at_desk = looking(true, &[2]);
        assert_eq!(
            names(choose(
                &devices,
                |d| d.1,
                PushKind::TurnFinished,
                Some(1),
                &at_desk
            )),
            vec!["ipad"]
        );
        // Looking at this very session: nothing, whatever the prefs.
        let on_it = looking(true, &[1]);
        assert!(choose(&devices, |d| d.1, PushKind::TurnFinished, Some(1), &on_it).is_empty());
        assert!(choose(&devices, |d| d.1, PushKind::Critical, Some(1), &on_it).is_empty());
        // Critical goes out at the desk too, to the devices that keep it on.
        assert_eq!(
            names(choose(
                &devices,
                |d| d.1,
                PushKind::Critical,
                Some(1),
                &at_desk
            )),
            vec!["phone", "ipad"]
        );
        // A test ignores both.
        assert_eq!(
            choose(&devices, |d| d.1, PushKind::Test, None, &on_it).len(),
            3
        );
    }

    #[test]
    fn a_sound_is_a_plain_sound_file_name() {
        let longest = format!("{}.caf", "a".repeat(60));
        for ok in [
            "codeg-chime.caf",
            "Bell_2.WAV",
            "x.aiff",
            "import-1a2b3c4d.caf",
            longest.as_str(),
        ] {
            assert!(is_sound_file_name(ok), "{ok}");
        }
        let too_long = format!("{}.caf", "a".repeat(61));
        for bad in [
            "",
            "chime",
            "chime.mp3",
            ".caf",
            ".hidden.caf",
            "-dash.caf",
            "../chime.caf",
            "sounds/chime.caf",
            "a\\b.caf",
            "/tmp/chime.caf",
            "a..b.caf",
            "my chime.caf",
            "café.caf",
            "chime.caf\n",
            too_long.as_str(),
        ] {
            assert!(!is_sound_file_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_choice_is_default_none_or_a_sound_file() {
        assert_eq!(SoundChoice::parse("default"), Some(SoundChoice::Default));
        assert_eq!(SoundChoice::parse("none"), Some(SoundChoice::Silent));
        assert_eq!(
            SoundChoice::parse("codeg-ping.caf"),
            Some(SoundChoice::File("codeg-ping.caf".into()))
        );
        assert_eq!(SoundChoice::parse("../ping.caf"), None);
        assert_eq!(SoundChoice::parse("Default"), None);
        assert_eq!(SoundChoice::Default.aps_sound(), Some("default"));
        assert_eq!(SoundChoice::Silent.aps_sound(), None);
        assert_eq!(
            SoundChoice::File("codeg-ping.caf".into()).aps_sound(),
            Some("codeg-ping.caf")
        );
        for slot in SoundSlot::ALL {
            assert_eq!(SoundSlot::parse(slot.as_str()), Some(slot));
        }
        assert_eq!(SoundSlot::parse("needsYou"), None);
    }

    fn file(name: &str) -> SoundChoice {
        SoundChoice::File(name.into())
    }

    #[test]
    fn sounds_keep_what_they_can_play_and_name_the_rest() {
        let (sounds, rejected) = DeviceSounds::from_wire(&json!({
            "kinds": {
                "needs_you": "codeg-chime.caf",
                "plan": "none",
                "turn_finished": "default",
                "critical": "../../etc/passwd.caf",
                "error": "song.mp3",
                "reminder": 3,
                "future_kind": "codeg-pop.caf",
            },
            "critical": "codeg-bell.caf",
            "projects": { "7": "codeg-glass.caf", "8": "default", "x": "none", "-3": "none" },
            "sessions": { "42": "none", "43": "/tmp/a.caf" },
        }));
        assert_eq!(sounds.kind(SoundSlot::NeedsYou), &file("codeg-chime.caf"));
        assert_eq!(sounds.kind(SoundSlot::Plan), &SoundChoice::Silent);
        for slot in [
            SoundSlot::TurnFinished,
            SoundSlot::Critical,
            SoundSlot::Error,
            SoundSlot::Reminder,
        ] {
            assert_eq!(sounds.kind(slot), &SoundChoice::Default, "{slot:?}");
        }
        assert!(sounds.has_critical());
        assert_eq!(sounds.project_ids(), [7]);
        assert_eq!(sounds.session_ids(), [42]);
        assert_eq!(
            rejected,
            [
                "kinds.critical",
                "kinds.error",
                "kinds.future_kind",
                "kinds.reminder",
                "projects.-3",
                "projects.x",
                "sessions.43",
            ]
        );
        assert_eq!(
            sounds.to_wire(),
            json!({
                "kinds": { "needs_you": "codeg-chime.caf", "plan": "none" },
                "critical": "codeg-bell.caf",
                "projects": { "7": "codeg-glass.caf" },
                "sessions": { "42": "none" },
            })
        );
        assert_eq!(DeviceSounds::from_wire(&sounds.to_wire()).0, sounds);
        // An override left at "default" defers; anything but an object is
        // no sounds at all.
        let (deferring, rejected) = DeviceSounds::from_wire(&json!({ "critical": "default" }));
        assert!(deferring.is_empty() && rejected.is_empty());
        assert_eq!(
            DeviceSounds::from_wire(&json!("loud")),
            (DeviceSounds::default(), vec![])
        );
        assert_eq!(
            DeviceSounds::default().to_wire(),
            json!({ "kinds": {}, "projects": {}, "sessions": {} })
        );
    }

    fn critical() -> SoundContext {
        SoundContext {
            critical_session: true,
            root_folder_id: None,
        }
    }

    fn plain() -> SoundContext {
        SoundContext::default()
    }

    #[test]
    fn a_session_beats_its_project_which_beats_critical_which_beats_the_kind() {
        let (sounds, _) = DeviceSounds::from_wire(&json!({
            "kinds": { "turn_finished": "codeg-pop.caf", "critical": "codeg-glass.caf" },
            "critical": "codeg-bell.caf",
            "projects": { "7": "codeg-chime.caf" },
            "sessions": { "42": "codeg-ping.caf", "44": "none" },
        }));
        assert!(sounds.has_projects());
        let turn = SoundSlot::TurnFinished;
        // Nothing overrides: the kind's sound.
        assert_eq!(
            sounds.resolve(Some(1), Some(2), plain(), turn),
            &file("codeg-pop.caf")
        );
        assert_eq!(
            sounds.resolve(None, None, plain(), turn),
            &file("codeg-pop.caf")
        );
        assert_eq!(
            sounds.resolve(Some(1), Some(2), plain(), SoundSlot::Error),
            &SoundChoice::Default
        );
        // A critical session: its sound for every kind, the alert's too.
        assert_eq!(
            sounds.resolve(Some(1), Some(2), critical(), turn),
            &file("codeg-bell.caf")
        );
        assert_eq!(
            sounds.resolve(Some(1), Some(2), critical(), SoundSlot::Critical),
            &file("codeg-bell.caf")
        );
        // A critical session in a project with a sound: the project wins.
        assert_eq!(
            sounds.resolve(Some(1), Some(7), critical(), turn),
            &file("codeg-chime.caf")
        );
        assert_eq!(
            sounds.resolve(Some(1), Some(7), plain(), turn),
            &file("codeg-chime.caf")
        );
        // The session's own sound wins over both, silence included.
        assert_eq!(
            sounds.resolve(Some(42), Some(7), critical(), turn),
            &file("codeg-ping.caf")
        );
        assert_eq!(
            sounds.resolve(Some(44), Some(7), critical(), turn),
            &SoundChoice::Silent
        );
        // Without a critical sound a critical session plays its kind's.
        let (plain_sounds, _) = DeviceSounds::from_wire(&json!({
            "kinds": { "critical": "codeg-glass.caf" },
        }));
        assert!(!plain_sounds.has_critical() && !plain_sounds.has_projects());
        assert_eq!(
            plain_sounds.resolve(Some(1), Some(2), critical(), SoundSlot::Critical),
            &file("codeg-glass.caf")
        );
        assert_eq!(
            plain_sounds.resolve(Some(1), Some(2), critical(), turn),
            &SoundChoice::Default
        );
    }

    #[test]
    fn a_projects_sound_covers_its_worktrees_unless_they_have_their_own() {
        let (sounds, _) = DeviceSounds::from_wire(&json!({
            "critical": "codeg-bell.caf",
            "projects": { "7": "codeg-chime.caf", "9": "codeg-knock.caf" },
        }));
        let turn = SoundSlot::TurnFinished;
        // A session in worktree folder 8 of project 7.
        let in_worktree = SoundContext {
            critical_session: true,
            root_folder_id: Some(7),
        };
        assert_eq!(
            sounds.resolve(Some(1), Some(8), in_worktree, turn),
            &file("codeg-chime.caf")
        );
        // Worktree folder 9 has a sound of its own.
        assert_eq!(
            sounds.resolve(Some(1), Some(9), in_worktree, turn),
            &file("codeg-knock.caf")
        );
        // A root without a sound defers as usual.
        let elsewhere = SoundContext {
            critical_session: true,
            root_folder_id: Some(3),
        };
        assert_eq!(
            sounds.resolve(Some(1), Some(8), elsewhere, turn),
            &file("codeg-bell.caf")
        );
    }

    #[test]
    fn sounds_of_folders_and_conversations_gone_can_be_dropped() {
        let (mut sounds, _) = DeviceSounds::from_wire(&json!({
            "projects": { "7": "none", "8": "codeg-chime.caf" },
            "sessions": { "42": "none", "43": "codeg-pop.caf" },
        }));
        sounds.retain_ids(|folder| folder == 8, |conversation| conversation == 42);
        assert_eq!(sounds.project_ids(), [8]);
        assert_eq!(sounds.session_ids(), [42]);
    }

    #[test]
    fn the_sounds_sit_next_to_the_prefs_in_the_row() {
        let prefs = DevicePrefs {
            errors: true,
            ..DevicePrefs::default()
        };
        let (sounds, _) = DeviceSounds::from_wire(&json!({
            "kinds": { "plan": "codeg-bell.caf" },
            "sessions": { "42": "none" },
        }));
        let raw = stored_prefs_json(prefs, &sounds);
        assert!(raw.starts_with(
            r#"{"turn_finished":"away","needs_you":"away","critical":true,"errors":true,"sounds":"#
        ));
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["sounds"],
            json!({
                "kinds": { "plan": "codeg-bell.caf" },
                "projects": {},
                "sessions": { "42": "none" },
            })
        );
        assert_eq!(DevicePrefs::from_json(&raw), prefs);
        assert_eq!(DeviceSounds::from_prefs_json(&raw), sounds);
        // Without sounds the row reads as it always did.
        assert_eq!(
            stored_prefs_json(prefs, &DeviceSounds::default()),
            prefs.to_json()
        );
        assert!(DeviceSounds::from_prefs_json(&prefs.to_json()).is_empty());
        assert!(DeviceSounds::from_prefs_json("garbage").is_empty());
        // A name that is not a plain sound file never comes back out.
        assert!(DeviceSounds::from_prefs_json(
            r#"{"sounds":{"kinds":{"plan":"/etc/x.caf"},"critical":"../x.caf"}}"#
        )
        .is_empty());
    }
}
