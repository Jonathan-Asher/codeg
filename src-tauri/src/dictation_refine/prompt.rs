//! The system prompt for one refine call: clean up, translate, or both, plus
//! the user's own instructions. Ported from Speakly's translation stage; the
//! two instruction texts are calibrated against real dictations and must stay
//! verbatim.

pub(crate) const DEFAULT_SYSTEM: &str =
    "Translate the user's text to {targetLanguage}. Output only the translation, nothing else.";

/// The cleanup instruction, calibrated against real dictations: strip the
/// conversational scaffolding, keep the substance verbatim. The examples are
/// load-bearing — without them models under-clean lead-ins like "listen, so
/// basically".
pub(crate) const REFINE_INSTRUCTION: &str =
    "Turn dictated speech into the message the speaker meant to \
    write. Remove filler sounds (uh, um, אה, אמם), conversational lead-ins and discourse markers \
    (listen, so, basically, you know, I mean, תשמע, אז, כאילו, בעצם), false starts, \
    self-corrections, repetitions, and asides that aren't part of the message. Fix punctuation \
    and capitalization. Keep the speaker's own words, language, tone, and meaning — never add \
    content, answer questions, or rephrase what is already clear.\n\
    Example — input: `Listen, so basically, uh... basically the client's company.` → output: \
    `The client's company.`\n\
    Example — input: `אה… תשמע, בעצם, אני צריך לשלוח, אני צריך לשלוח את המסמך ללקוח.` → output: \
    `אני צריך לשלוח את המסמך ללקוח.`";

/// What one call is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stage<'a> {
    pub refine: bool,
    pub translate: bool,
    /// A language name ("English"); codes are expanded by the caller.
    pub target_language: &'a str,
    /// The dictation's language when the client knows it.
    pub source_language: Option<&'a str>,
    /// The user's extra instructions; blank is none.
    pub instructions: &'a str,
}

/// System prompt for the stage. With neither step asked for there is nothing
/// to prompt; the caller returns the text as it came.
pub(crate) fn stage_prompt(stage: &Stage<'_>) -> String {
    let extra = Some(stage.instructions.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            format!(
                "\nAdditional instructions from the user — follow them, and where they conflict \
                 with the guidance above, they win:\n{s}"
            )
        })
        .unwrap_or_default();
    let source = stage
        .source_language
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("\nThe dictation is in {s}."))
        .unwrap_or_default();
    match (stage.refine, stage.translate) {
        // The output rule stays last so the user's instructions cannot bury it.
        (true, true) => format!(
            "{REFINE_INSTRUCTION}{source}\nThen translate the result to {}.{extra}\nOutput only \
             the clean translation.",
            stage.target_language
        ),
        (true, false) => {
            format!("{REFINE_INSTRUCTION}{source}{extra}\nOutput only the cleaned text.")
        }
        (false, _) => {
            let base = DEFAULT_SYSTEM.replace("{targetLanguage}", stage.target_language);
            format!("{base}{source}{extra}")
        }
    }
}

/// ISO 639-1 codes and the names the prompts use for them.
const LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("he", "Hebrew"),
    ("ar", "Arabic"),
    ("ru", "Russian"),
    ("fr", "French"),
    ("es", "Spanish"),
    ("de", "German"),
    ("pt", "Portuguese"),
    ("it", "Italian"),
    ("zh", "Chinese"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
];

/// The name a prompt should use: `he` and `he-IL` read as "Hebrew"; anything
/// else is passed through as the user wrote it.
pub(crate) fn language_name(value: &str) -> String {
    let value = value.trim();
    let base = value
        .split(['-', '_'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|(code, _)| *code == base)
        .map(|(_, name)| (*name).to_string())
        .unwrap_or_else(|| value.to_string())
}

/// Google Cloud Translation v2 wants ISO codes, not language names.
pub(crate) fn google_lang_code(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    LANGUAGES
        .iter()
        .find(|(_, n)| n.to_lowercase() == lower)
        .map(|(code, _)| (*code).to_string())
        .unwrap_or(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(refine: bool, translate: bool) -> Stage<'static> {
        Stage {
            refine,
            translate,
            target_language: "English",
            source_language: None,
            instructions: "",
        }
    }

    #[test]
    fn refine_only_asks_for_cleanup_not_translation() {
        let p = stage_prompt(&stage(true, false));
        assert!(p.contains("Remove filler sounds"));
        assert!(p.contains("Output only the cleaned text"));
        assert!(!p.contains("translate the result"));
    }

    #[test]
    fn combined_cleans_then_translates() {
        let p = stage_prompt(&stage(true, true));
        assert!(p.contains("Remove filler sounds"));
        assert!(p.contains("translate the result to English"));
        assert!(p.ends_with("Output only the clean translation."));
    }

    #[test]
    fn translate_only_keeps_the_classic_prompt() {
        let p = stage_prompt(&stage(false, true));
        assert_eq!(
            p,
            "Translate the user's text to English. Output only the translation, nothing else."
        );
        assert!(!p.contains("filler"));
    }

    #[test]
    fn the_calibrated_texts_are_verbatim() {
        // Speakly's wording, examples included; a reflow here changes what
        // the models do.
        assert!(REFINE_INSTRUCTION.starts_with(
            "Turn dictated speech into the message the speaker meant to write. Remove filler \
             sounds (uh, um, אה, אמם), conversational lead-ins"
        ));
        assert!(REFINE_INSTRUCTION.contains(
            "\nExample — input: `Listen, so basically, uh... basically the client's company.` → \
             output: `The client's company.`\n"
        ));
        assert!(REFINE_INSTRUCTION.ends_with("`אני צריך לשלוח את המסמך ללקוח.`"));
    }

    #[test]
    fn instructions_extend_the_prompt_and_the_output_rule_stays_last() {
        let mut s = stage(true, true);
        s.instructions = "  Keep legal terms in Hebrew.\n";
        let p = stage_prompt(&s);
        // Added to the built-in guidance, not replacing it.
        assert!(p.contains("Remove filler sounds"));
        assert!(p.contains("translate the result to English"));
        assert!(p.contains("Additional instructions from the user"));
        assert!(p.contains("Keep legal terms in Hebrew."));
        assert!(p.ends_with("Output only the clean translation."));

        s.translate = false;
        let p = stage_prompt(&s);
        assert!(p.contains("Keep legal terms in Hebrew."));
        assert!(p.ends_with("Output only the cleaned text."));
    }

    #[test]
    fn instructions_reach_translate_only_too() {
        let mut s = stage(false, true);
        s.instructions = "Use a formal tone.";
        let p = stage_prompt(&s);
        assert!(p.starts_with("Translate the user's text to English"));
        assert!(p.contains("Use a formal tone."));
    }

    #[test]
    fn blank_instructions_change_nothing() {
        for blank in ["", "   \n\t"] {
            let mut s = stage(true, true);
            s.instructions = blank;
            assert_eq!(stage_prompt(&s), stage_prompt(&stage(true, true)));
        }
    }

    #[test]
    fn a_known_source_language_is_named_before_the_instructions_and_the_output_rule() {
        let mut s = stage(true, true);
        s.source_language = Some("Hebrew");
        s.instructions = "Keep names in Hebrew letters.";
        let p = stage_prompt(&s);
        let source = p.find("The dictation is in Hebrew.").unwrap();
        let translate = p.find("Then translate the result to English.").unwrap();
        let extra = p.find("Keep names in Hebrew letters.").unwrap();
        assert!(source < translate && translate < extra);
        assert!(p.ends_with("Output only the clean translation."));

        s.source_language = Some("  ");
        s.instructions = "";
        assert_eq!(stage_prompt(&s), stage_prompt(&stage(true, true)));
    }

    #[test]
    fn languages_map_both_ways() {
        assert_eq!(google_lang_code("English"), "en");
        assert_eq!(google_lang_code("he"), "he");
        assert_eq!(google_lang_code("Klingon"), "klingon");
        assert_eq!(language_name("he"), "Hebrew");
        assert_eq!(language_name("he-IL"), "Hebrew");
        assert_eq!(language_name("EN"), "English");
        assert_eq!(language_name("English"), "English");
        assert_eq!(
            language_name("Brazilian Portuguese"),
            "Brazilian Portuguese"
        );
    }
}
