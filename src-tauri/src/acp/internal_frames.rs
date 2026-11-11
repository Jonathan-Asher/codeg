//! Codeg's internal frames, together: text codeg appends to a message at the
//! agent boundary and takes out again wherever history is shown.
//!
//! * the `@agent` routing frame ([`crate::acp::agent_mentions`]), identified
//!   by its exact wording;
//! * the talk frame ([`crate::acp::talk_frame`]), identified by its length and
//!   digest, which also says whether the message was spoken;
//! * the move frame ([`crate::acp::move_frame`]), the note the first message
//!   after a move to another project carries, identified the same way.
//!
//! All open with the record separator U+001E, which every prompt has scrubbed
//! at ingress, so none can be forged by what a user types. The readers that
//! clean history (`parsers::sanitize_detail`, the Codex parser's structural
//! checks, the background overlay) go through here, so a third kind of frame
//! would only need adding in one place.

use crate::acp::agent_mentions;
use crate::acp::move_frame;
use crate::acp::talk_frame::{self, TalkFrameInfo};

/// Whether `input` holds any complete frame of any kind.
pub(crate) fn contains_any(input: &str) -> bool {
    agent_mentions::contains_internal_agent_routes(input)
        || talk_frame::contains(input)
        || move_frame::contains(input)
}

/// `input` with every complete frame of any kind removed.
pub(crate) fn strip_all(input: &str) -> String {
    strip_all_with_talk(input).0
}

/// [`strip_all`], plus what the last talk frame said (`None` when the text
/// held none).
pub(crate) fn strip_all_with_talk(input: &str) -> (String, Option<TalkFrameInfo>) {
    // The talk and move frames go first: they are appended after the routing
    // frame, and their own finders never depend on what precedes them.
    let (text, talk) = talk_frame::strip(input);
    let text = move_frame::strip(&text);
    let text = if agent_mentions::contains_internal_agent_routes(&text) {
        agent_mentions::strip_internal_agent_routes(&text)
    } else {
        text
    };
    (text, talk)
}

/// The record holds one or more frames and nothing a user wrote. Used where a
/// record must be skipped structurally rather than emptied later: the Codex
/// parser, against phantom turns and promotion coverage from adapters that
/// persist each prompt block as its own record.
pub(crate) fn contains_only_frames(input: &str) -> bool {
    contains_any(input) && strip_all(input).trim().is_empty()
}

/// Cut a capped title where any frame begins (see
/// [`agent_mentions::cut_at_route_frame_marker`] for why a title needs more
/// than the whole-frame strip).
pub(crate) fn cut_at_frame_marker(title: &mut String) {
    agent_mentions::cut_at_route_frame_marker(title);
    for cut in [talk_frame::title_cut(title), move_frame::title_cut(title)] {
        if let Some(cut) = cut.filter(|cut| *cut <= title.len()) {
            title.truncate(cut);
            title.truncate(title.trim_end().len());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::talk_frame::TalkFrameMode;
    use crate::acp::types::PromptInputBlock;

    fn routing_frame() -> String {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Antigravity](codeg://agent/antigravity)".into(),
        }];
        agent_mentions::append_agent_routes(&mut blocks, true);
        match blocks.pop() {
            Some(PromptInputBlock::Text { text }) => text,
            _ => panic!("expected the routing frame"),
        }
    }

    #[test]
    fn both_kinds_go_and_the_talk_flag_survives() {
        let routes = routing_frame();
        let talk = talk_frame::render(TalkFrameMode::Compact, true, "Talk mode is on.");
        let joined = format!("ask{routes}{talk}");
        assert!(contains_any(&joined));
        let (text, info) = strip_all_with_talk(&joined);
        assert_eq!(text.trim_end(), "ask");
        assert!(info.is_some_and(|info| info.spoken));
    }

    #[test]
    fn frame_only_records_are_recognized_and_prose_is_not() {
        let talk = talk_frame::render(TalkFrameMode::Off, false, "Talk mode is off.");
        assert!(contains_only_frames(&talk));
        assert!(contains_only_frames(&format!("\n{talk}\n")));
        assert!(contains_only_frames(&routing_frame()));
        assert!(!contains_only_frames(&format!("hi{talk}")));
        assert!(!contains_only_frames("hi"));
    }

    #[test]
    fn a_move_frame_goes_with_the_others() {
        let routes = routing_frame();
        let moved = move_frame::render(&move_frame::note("/work/a", "/work/b"));
        let talk = talk_frame::render(TalkFrameMode::Compact, true, "Talk mode is on.");
        // As one prompt carries them: routing, then the move note and the talk
        // frame joined into one block.
        let joined = format!("go on{routes}{moved}{talk}");
        assert!(contains_any(&joined));
        let (text, info) = strip_all_with_talk(&joined);
        assert_eq!(text.trim_end(), "go on");
        assert!(info.is_some_and(|info| info.spoken));
        assert!(contains_only_frames(&moved));
        assert!(contains_only_frames(&format!("{moved}{talk}")));
        let mut title = format!("go on {}", moved.trim_matches('\u{1e}'));
        cut_at_frame_marker(&mut title);
        assert_eq!(title, "go on");
    }

    #[test]
    fn a_title_never_shows_a_talk_frame() {
        let talk = talk_frame::render(TalkFrameMode::Full, true, "Talk mode is on.");
        let mut separated = format!("hello{talk}");
        cut_at_frame_marker(&mut separated);
        assert_eq!(separated, "hello");
        let mut bare = format!("hello {}", talk.trim_matches('\u{1e}'));
        cut_at_frame_marker(&mut bare);
        assert_eq!(bare, "hello");
    }
}
