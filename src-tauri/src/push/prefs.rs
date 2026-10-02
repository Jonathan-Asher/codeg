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

use serde::{Deserialize, Serialize};

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
            PushKind::Test => true,
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
