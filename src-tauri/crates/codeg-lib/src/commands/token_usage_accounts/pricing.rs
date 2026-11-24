//! Anthropic API list prices, for the dollar figure of a Claude call.
//!
//! These are the first-party API rates per million tokens. A subscription
//! does not charge them; they are the common unit the usage page prices a
//! call in, and the unit an account's weekly meter is measured against
//! ([`super::meter`]). Cache writes are priced at the API's multipliers of
//! the input rate: 1.25× for the 5-minute tier and 2× for the 1-hour tier.
//! Cache reads have their own per-model rate (they are not a fixed share of
//! input on the newer models).
//!
//! A model the table does not know is unpriced (`None`), never guessed from
//! its family: a wrong price would move every percentage estimated from it.

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ModelRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

/// The token counters of one call, cache writes split by tier.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CallTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
}

impl CallTokens {
    /// Everything the prompt held: fresh input, cache reads and cache writes.
    fn prompt(&self) -> u64 {
        self.input
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
    }
}

const CACHE_WRITE_5M: f64 = 1.25;
const CACHE_WRITE_1H: f64 = 2.0;

/// Claude Haiku 5.5's rates apply to prompts up to this size; a longer
/// prompt is billed at the long-context rates below.
const HAIKU_5_5_TIER_TOKENS: u64 = 100_000;
const HAIKU_5_5_LONG: ModelRates = ModelRates {
    input: 0.50,
    output: 2.50,
    cache_read: 0.05,
};

const fn r(input: f64, output: f64, cache_read: f64) -> ModelRates {
    ModelRates {
        input,
        output,
        cache_read,
    }
}

/// Exact model ids (after [`normalize_model`]) and their list rates.
const TABLE: &[(&str, ModelRates)] = &[
    ("claude-fable-5-2", r(8.0, 40.0, 0.20)),
    ("claude-mythos-5-2", r(8.0, 40.0, 0.20)),
    ("claude-fable-5-1", r(10.0, 50.0, 0.25)),
    ("claude-mythos-5-1", r(10.0, 50.0, 0.25)),
    ("claude-fable-5", r(10.0, 50.0, 1.00)),
    ("claude-mythos-5", r(10.0, 50.0, 1.00)),
    ("claude-opus-5-5", r(4.0, 20.0, 0.20)),
    ("claude-opus-5", r(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", r(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", r(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", r(5.0, 25.0, 0.50)),
    ("claude-opus-4-5", r(5.0, 25.0, 0.50)),
    ("claude-opus-4-1", r(15.0, 75.0, 1.50)),
    ("claude-opus-4", r(15.0, 75.0, 1.50)),
    ("claude-sonnet-5-5", r(2.0, 10.0, 0.10)),
    ("claude-sonnet-5", r(2.0, 10.0, 0.20)),
    ("claude-sonnet-4-6", r(3.0, 15.0, 0.30)),
    ("claude-sonnet-4-5", r(3.0, 15.0, 0.30)),
    ("claude-sonnet-4", r(3.0, 15.0, 0.30)),
    ("claude-3-7-sonnet", r(3.0, 15.0, 0.30)),
    ("claude-haiku-5-5", r(0.10, 0.50, 0.01)),
    ("claude-haiku-4-5", r(1.0, 5.0, 0.10)),
    ("claude-3-5-haiku", r(0.80, 4.0, 0.08)),
];

/// The table key a reported model id stands for: lowercased, without a
/// platform prefix (`anthropic.`, `us.anthropic.`), a context-size tag
/// (`[1m]`), a date snapshot (`-20251101`, `@20251101`) or a Bedrock
/// version suffix (`-v1:0`).
pub(crate) fn normalize_model(raw: &str) -> String {
    let mut m = raw.trim().to_ascii_lowercase();
    if let Some(at) = m.find('[') {
        m.truncate(at);
    }
    if let Some(at) = m.rfind("anthropic.") {
        m = m[at + "anthropic.".len()..].to_string();
    }
    if let Some(at) = m.find('@') {
        m.truncate(at);
    }
    if let Some(at) = m.rfind("-v") {
        if m[at + 2..].chars().all(|c| c.is_ascii_digit() || c == ':') && at + 2 < m.len() {
            m.truncate(at);
        }
    }
    if let Some(at) = m.rfind('-') {
        let tail = &m[at + 1..];
        if tail.len() == 8 && tail.chars().all(|c| c.is_ascii_digit()) {
            m.truncate(at);
        }
    }
    m.trim().to_string()
}

pub(crate) fn rates_for(model: &str) -> Option<ModelRates> {
    let key = normalize_model(model);
    TABLE
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, rates)| *rates)
}

/// The list price of one call, or `None` when its model is unknown.
pub(crate) fn cost_usd(model: Option<&str>, tokens: &CallTokens) -> Option<f64> {
    let model = model?;
    let mut rates = rates_for(model)?;
    if normalize_model(model) == "claude-haiku-5-5" && tokens.prompt() > HAIKU_5_5_TIER_TOKENS {
        rates = HAIKU_5_5_LONG;
    }
    let m = 1_000_000.0;
    Some(
        tokens.input as f64 * rates.input / m
            + tokens.output as f64 * rates.output / m
            + tokens.cache_read as f64 * rates.cache_read / m
            + tokens.cache_write_5m as f64 * rates.input * CACHE_WRITE_5M / m
            + tokens.cache_write_1h as f64 * rates.input * CACHE_WRITE_1H / m,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(input: u64, output: u64, read: u64, w5m: u64, w1h: u64) -> CallTokens {
        CallTokens {
            input,
            output,
            cache_read: read,
            cache_write_5m: w5m,
            cache_write_1h: w1h,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn opus_5_5_prices_each_counter_at_its_own_rate() {
        // 1M of each: $4 input, $20 output, $0.20 read, $5 5-minute write,
        // $8 1-hour write.
        let m = 1_000_000;
        let usd = cost_usd(Some("claude-opus-5-5"), &tokens(m, m, m, m, m)).unwrap();
        assert!(close(usd, 4.0 + 20.0 + 0.20 + 5.0 + 8.0), "{usd}");
    }

    #[test]
    fn a_real_call_matches_the_hand_computed_price() {
        // The shape of a long-context sub-agent call: 2 input, 715 output,
        // 261 146 cache read, 2 169 written to the 5-minute cache.
        let usd = cost_usd(Some("claude-opus-5-5"), &tokens(2, 715, 261_146, 2_169, 0)).unwrap();
        let want = 2.0 * 4.0 / 1e6
            + 715.0 * 20.0 / 1e6
            + 261_146.0 * 0.20 / 1e6
            + 2_169.0 * 4.0 * 1.25 / 1e6;
        assert!(close(usd, want), "{usd} vs {want}");
    }

    #[test]
    fn model_ids_are_normalized_before_lookup() {
        for id in [
            "claude-opus-5-5",
            "CLAUDE-OPUS-5-5",
            "claude-opus-5-5[1m]",
            "anthropic.claude-opus-5-5",
            "us.anthropic.claude-opus-5-5-v1:0",
            "claude-opus-5-5@20260401",
            "claude-opus-5-5-20260401",
        ] {
            assert_eq!(rates_for(id), Some(r(4.0, 20.0, 0.20)), "{id}");
        }
        // The longer id is not mistaken for its prefix, nor the other way.
        assert_eq!(rates_for("claude-opus-5"), Some(r(5.0, 25.0, 0.50)));
        assert_eq!(rates_for("claude-fable-5-2"), Some(r(8.0, 40.0, 0.20)));
        assert_eq!(rates_for("claude-fable-5"), Some(r(10.0, 50.0, 1.00)));
    }

    #[test]
    fn unknown_and_foreign_models_stay_unpriced() {
        assert_eq!(
            cost_usd(Some("claude-opus-5-7"), &tokens(1, 1, 0, 0, 0)),
            None
        );
        assert_eq!(cost_usd(Some("glm-5.3"), &tokens(1, 1, 0, 0, 0)), None);
        assert_eq!(cost_usd(Some("gpt-5.5"), &tokens(1, 1, 0, 0, 0)), None);
        assert_eq!(cost_usd(None, &tokens(1, 1, 0, 0, 0)), None);
    }

    #[test]
    fn haiku_5_5_switches_to_its_long_prompt_rates_past_100k() {
        let short = cost_usd(
            Some("claude-haiku-5-5"),
            &tokens(100_000, 1_000_000, 0, 0, 0),
        )
        .unwrap();
        assert!(close(short, 0.01 + 0.50), "{short}");
        let long = cost_usd(
            Some("claude-haiku-5-5"),
            &tokens(100_001, 1_000_000, 0, 0, 0),
        )
        .unwrap();
        assert!(close(long, 100_001.0 * 0.50 / 1e6 + 2.50), "{long}");
    }
}
