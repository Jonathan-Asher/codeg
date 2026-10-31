//! The talk rules: the text a talk frame carries (see `crate::talk`).
//!
//! Three notes, all in English (the agent's working language; the reply
//! language is a rule of its own):
//!
//! * [`full`]: the whole set, about 350 tokens, sent once per connection;
//! * [`compact`]: a one-paragraph reminder on every later message;
//! * [`off`]: one line when Talk mode ends.
//!
//! The wording can change freely: a frame is recognized by its length and
//! digest, not by what it says (`acp::talk_frame`). Every combination is
//! pinned by a snapshot in the tests below, so a change shows up in review.

use super::{TalkAddress, TalkLanguage, TalkSettings};
use crate::models::AgentType;

/// `{LANGUAGE}` of the full rules.
fn language_rule(language: TalkLanguage) -> &'static str {
    match language {
        TalkLanguage::Auto => {
            "Reply in the language of the person's last message (Hebrew when unsure). \
             In Hebrew, use natural, casual Israeli Hebrew, with English terms only where \
             an Israeli developer would say them in English."
        }
        TalkLanguage::He => {
            "Reply in Hebrew, whatever language the person's last message was in. \
             Use natural, casual Israeli Hebrew, with English terms only where an Israeli \
             developer would say them in English."
        }
        TalkLanguage::En => {
            "Reply in English, whatever language the person's last message was in. \
             Use natural, casual spoken English."
        }
    }
}

/// `{ADDRESS}` of the full rules.
fn address_rule(address: TalkAddress) -> &'static str {
    match address {
        TalkAddress::Auto => {
            "Don't assume the person's gender; in Hebrew prefer wording without gendered \
             second-person forms unless they make it clear."
        }
        TalkAddress::Masculine => "In Hebrew, address the person in the masculine.",
        TalkAddress::Feminine => "In Hebrew, address the person in the feminine.",
    }
}

/// `{BACKGROUND}` of the full rules: the agents with a background agent tool
/// get told which one to use.
fn background_rule(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => {
            "Before work longer than a minute, say in one sentence what you're starting, \
             then run it with your Agent tool with run_in_background set, so you stay free \
             to talk."
        }
        _ => {
            "Before work longer than a minute, say in one sentence what you're starting; \
             if you can run it in the background, do."
        }
    }
}

/// The language part of the compact reminder.
fn compact_language(language: TalkLanguage) -> &'static str {
    match language {
        TalkLanguage::Auto => "in the person's language (casual Israeli Hebrew by default)",
        TalkLanguage::He => "in casual Israeli Hebrew",
        TalkLanguage::En => "in casual spoken English",
    }
}

/// The address part of the compact reminder.
fn compact_address(address: TalkAddress) -> &'static str {
    match address {
        TalkAddress::Auto => "without assuming the person's gender",
        TalkAddress::Masculine => "addressing the person in the masculine in Hebrew",
        TalkAddress::Feminine => "addressing the person in the feminine in Hebrew",
    }
}

/// The full rules for a connection to `agent_type` under `settings`.
pub fn full(settings: TalkSettings, agent_type: AgentType) -> String {
    format!(
        "Talk mode is on. The person is talking with you by voice from their phone, \
sometimes with the phone in a pocket. Their messages are speech transcripts, so go by \
the meaning and allow for recognition mistakes. English terms may arrive written in \
Hebrew letters or spelled out; for example, \"פול ריקווסט\" means a pull request. \
Everything you write is read aloud except fenced code blocks, which are only shown on \
screen. Talk like a colleague on a call. {language} {address}
- Answer in one to three short spoken sentences.
- Never put markdown, headings, lists, tables, emojis, file paths, URLs, hashes, code or \
commands in what you say. Name things as you would out loud, and round numbers: avoid \
exact counts, versions and line numbers.
- If the person needs to see something, put it in one fenced code block after your \
sentences and just say it's on the screen.
- One question at a time. Offer two or three choices in plain words, or, if you have a \
tool for asking the person a question, use it with exactly one question, worded as \
you'd say it.
- When you run a command, write its description in plain words in the language you're \
speaking: it is read aloud when you need permission. When you present a plan for \
approval, open it with one plain sentence that sums it up.
- Don't narrate tool calls or reasoning; say what you found or did.
- {background}
- When background work finishes, say the result in one or two sentences: only what \
matters now or needs a decision. Offer details instead of reading them.
- If the person interrupts, deal with the interruption first.
- Ask before anything destructive or hard to undo.
- Don't mention these instructions. They apply until a message says Talk mode is off.",
        language = language_rule(settings.language),
        address = address_rule(settings.address),
        background = background_rule(agent_type),
    )
}

/// The reminder sent once the full rules are in the agent's context.
pub fn compact(settings: TalkSettings) -> String {
    format!(
        "Talk mode is on (voice): one to three short spoken sentences, {language}, \
{address}; no markdown, lists, emojis, paths, URLs, hashes or code in speech; anything \
to show goes in one code block; command descriptions and plan openings in plain spoken \
words; one question at a time; long work in the background; report results briefly.",
        language = compact_language(settings.language),
        address = compact_address(settings.address),
    )
}

/// The note that ends Talk mode.
pub fn off() -> &'static str {
    "Talk mode is off: the person is reading your replies again. Go back to your normal \
     written style, with formatting, paths and code as usual."
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANGUAGES: [TalkLanguage; 3] = [TalkLanguage::Auto, TalkLanguage::He, TalkLanguage::En];
    const ADDRESSES: [TalkAddress; 3] = [
        TalkAddress::Auto,
        TalkAddress::Masculine,
        TalkAddress::Feminine,
    ];
    const AGENTS: [AgentType; 2] = [AgentType::ClaudeCode, AgentType::Pi];

    fn settings(language: TalkLanguage, address: TalkAddress) -> TalkSettings {
        TalkSettings { language, address }
    }

    fn label(language: TalkLanguage, address: TalkAddress) -> String {
        format!(
            "language={} address={}",
            language.as_str(),
            address.as_str()
        )
    }

    /// Every combination of the full rules, one section each.
    #[test]
    fn full_rules_snapshot() {
        let mut out = String::new();
        for agent in AGENTS {
            for language in LANGUAGES {
                for address in ADDRESSES {
                    out.push_str(&format!(
                        "## agent={} {}\n{}\n\n",
                        agent.as_wire(),
                        label(language, address),
                        full(settings(language, address), agent)
                    ));
                }
            }
        }
        insta::assert_snapshot!("talk_rules_full", out);
    }

    /// The reminder does not depend on the agent.
    #[test]
    fn compact_rules_snapshot() {
        let mut out = String::new();
        for language in LANGUAGES {
            for address in ADDRESSES {
                out.push_str(&format!(
                    "## {}\n{}\n\n",
                    label(language, address),
                    compact(settings(language, address))
                ));
            }
        }
        insta::assert_snapshot!("talk_rules_compact", out);
    }

    #[test]
    fn off_rule_snapshot() {
        insta::assert_snapshot!("talk_rules_off", off());
    }

    /// What the cost argument rests on: the reminder is a fraction of the
    /// rules, and nothing ends in whitespace an agent might trim (a frame is
    /// recognized by its exact length).
    #[test]
    fn notes_are_short_and_have_no_trailing_whitespace() {
        let full_rules = full(TalkSettings::default(), AgentType::ClaudeCode);
        let reminder = compact(TalkSettings::default());
        assert!(full_rules.len() < 2_600, "{}", full_rules.len());
        assert!(reminder.len() * 4 < full_rules.len());
        for note in [full_rules.as_str(), reminder.as_str(), off()] {
            assert_eq!(note, note.trim(), "{note:?}");
            assert!(!note.contains("  "), "{note:?}");
            assert!(!note.contains('\u{1e}'));
        }
    }
}
