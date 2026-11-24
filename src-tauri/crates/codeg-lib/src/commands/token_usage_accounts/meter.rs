//! How much of an account's weekly limit each request used.
//!
//! ## The method
//!
//! Every response from a Claude subscription carries the account's weekly
//! utilization (`anthropic-ratelimit-unified-7d-utilization`), which the
//! pool records next to the request (see the maxpool usage records). The
//! reading moves in whole percent steps. Walking one account's requests in
//! time order:
//!
//! * each request joins a pending set;
//! * when a reading rises above the level of the last step by Δ, that Δ is
//!   split over the pending set in proportion to each request's list price,
//!   and those shares are final ([`PctSource::Meter`]);
//! * a reading that dips below the level (responses served by different
//!   edges disagree by a step now and then) moves nothing;
//! * a new weekly window (the reset time moved forward) starts the level at
//!   0; whatever was still pending belonged to the old window and is
//!   estimated instead;
//! * what is still pending after the last step is estimated as its price
//!   divided by the account's measured dollars per percent
//!   ([`PctSource::Pending`]), and revised once the next step arrives.
//!
//! Dollars per percent is measured per account from its own steps
//! ([`measured_usd_per_pct`]); with too few steps to measure it the 11-17
//! baseline of an Ultra week, $19.8 per 1 %, stands in.
//!
//! The method assumes the pool sees every request on the account. Use
//! outside it (claude.ai, another machine logged in to the same account)
//! moves the meter too, and is then shared out over the pool's requests.
//! A laptop that reaches the accounts through a linked pool sees only its
//! own share of the traffic, so its requests are always estimated.

/// $ per 1 % of a weekly limit, from the 2026-11-17 analysis (Ultra week).
pub(crate) const BASELINE_USD_PER_PCT: f64 = 19.8;
/// Fewer percent of measured steps than this and the baseline is used.
pub(crate) const MIN_MEASURED_PCT: f64 = 3.0;
/// A reset time that moved forward by more than this is a new window.
const NEW_WINDOW_MS: i64 = 3_600_000;
/// Without reset times, a fall this large (in percent) is a new window.
const DROP_AS_NEW_WINDOW_PCT: f64 = 5.0;

/// How a request's percentage was arrived at. Stored as its integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PctSource {
    /// Estimated from its price; revised when the next meter step lands.
    Pending = 0,
    /// Its share of a meter step. Final.
    Meter = 1,
    /// Estimated from its price, and final: the window it belonged to
    /// ended, or the account's meter is not readable from here.
    Estimate = 2,
}

/// One request of one account, in time order.
#[derive(Debug, Clone)]
pub(crate) struct MeterInput {
    pub id: i64,
    pub cost_usd: f64,
    /// The weekly reading on this response, as a fraction.
    pub util: Option<f64>,
    /// The weekly window's reset time on this response (epoch ms).
    pub reset_ms: Option<i64>,
}

/// Where a recomputation starts: the level (percent) and window the last
/// final request left.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct MeterStart {
    pub level: Option<f64>,
    pub reset_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MeterShare {
    pub id: i64,
    pub pct: f64,
    pub source: PctSource,
    /// The level after this request, kept so a later recomputation can
    /// start here.
    pub level: Option<f64>,
    pub reset_ms: Option<i64>,
}

fn estimate(cost: f64, usd_per_pct: f64) -> f64 {
    if usd_per_pct > 0.0 && cost.is_finite() {
        (cost / usd_per_pct).max(0.0)
    } else {
        0.0
    }
}

/// Share every meter step over the requests that preceded it (see the
/// module doc). `records` must be one account's, oldest first.
pub(crate) fn distribute(
    records: &[MeterInput],
    start: MeterStart,
    usd_per_pct: f64,
) -> Vec<MeterShare> {
    let mut out: Vec<MeterShare> = records
        .iter()
        .map(|r| MeterShare {
            id: r.id,
            pct: estimate(r.cost_usd, usd_per_pct),
            source: PctSource::Pending,
            level: None,
            reset_ms: None,
        })
        .collect();
    let mut level = start.level;
    let mut reset = start.reset_ms;
    let mut pending: Vec<usize> = Vec::new();

    let settle_as_estimates = |pending: &mut Vec<usize>, out: &mut Vec<MeterShare>| {
        for &j in pending.iter() {
            out[j].source = PctSource::Estimate;
        }
        pending.clear();
    };

    for (i, r) in records.iter().enumerate() {
        let renewed = match (reset, r.reset_ms) {
            (Some(prev), Some(now)) => now - prev > NEW_WINDOW_MS,
            _ => false,
        };
        if renewed {
            settle_as_estimates(&mut pending, &mut out);
            level = Some(0.0);
        }
        if r.reset_ms.is_some() {
            reset = r.reset_ms;
        }
        pending.push(i);

        if let Some(u) = r.util.filter(|u| u.is_finite() && *u >= 0.0) {
            let u = u * 100.0;
            match level {
                None => level = Some(u),
                Some(l) if u > l + 1e-9 => {
                    let delta = u - l;
                    let total: f64 = pending.iter().map(|&j| records[j].cost_usd.max(0.0)).sum();
                    let n = pending.len() as f64;
                    for &j in &pending {
                        let share = if total > 0.0 {
                            records[j].cost_usd.max(0.0) / total
                        } else {
                            1.0 / n
                        };
                        out[j].pct = delta * share;
                        out[j].source = PctSource::Meter;
                    }
                    pending.clear();
                    level = Some(u);
                }
                Some(l) if r.reset_ms.is_none() && u + DROP_AS_NEW_WINDOW_PCT < l => {
                    // No reset time to go by, and the meter fell far: a new
                    // window. This request is the first of it.
                    let current = pending.pop();
                    settle_as_estimates(&mut pending, &mut out);
                    pending.extend(current);
                    level = Some(u);
                }
                _ => {}
            }
        }
        out[i].level = level;
        out[i].reset_ms = reset;
    }
    out
}

/// Dollars per percent from an account's final meter shares: their summed
/// price over their summed percent, or `None` below [`MIN_MEASURED_PCT`].
pub(crate) fn measured_usd_per_pct(cost_usd: f64, pct: f64) -> Option<f64> {
    (pct >= MIN_MEASURED_PCT && cost_usd > 0.0).then(|| cost_usd / pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: i64, cost: f64, util: Option<f64>) -> MeterInput {
        MeterInput {
            id,
            cost_usd: cost,
            util,
            reset_ms: Some(1_000_000_000),
        }
    }

    fn pcts(out: &[MeterShare]) -> Vec<f64> {
        out.iter()
            .map(|s| (s.pct * 1000.0).round() / 1000.0)
            .collect()
    }

    #[test]
    fn a_step_is_shared_over_the_requests_before_it_by_price() {
        // Level 41 %; three requests cost $10, $20, $10; the third sees 42 %.
        let out = distribute(
            &[
                rec(1, 10.0, Some(0.41)),
                rec(2, 20.0, Some(0.41)),
                rec(3, 10.0, Some(0.42)),
            ],
            MeterStart {
                level: Some(41.0),
                reset_ms: Some(1_000_000_000),
            },
            20.0,
        );
        assert_eq!(pcts(&out), vec![0.25, 0.5, 0.25]);
        assert!(out.iter().all(|s| s.source == PctSource::Meter));
        assert_eq!(out[2].level, Some(42.0));
    }

    #[test]
    fn the_shares_add_up_to_the_meter_movement() {
        let mut recs = Vec::new();
        let mut util = 0.10;
        for i in 0..200 {
            if i % 17 == 16 {
                util += 0.01;
            }
            recs.push(rec(i, 0.5 + (i % 5) as f64, Some(util)));
        }
        let out = distribute(
            &recs,
            MeterStart {
                level: Some(10.0),
                reset_ms: Some(1_000_000_000),
            },
            19.8,
        );
        let metered: f64 = out
            .iter()
            .filter(|s| s.source == PctSource::Meter)
            .map(|s| s.pct)
            .sum();
        assert!((metered - (util * 100.0 - 10.0)).abs() < 1e-6, "{metered}");
    }

    #[test]
    fn requests_after_the_last_step_are_estimated_from_their_price() {
        let out = distribute(
            &[rec(1, 19.8, Some(0.50)), rec(2, 9.9, Some(0.50))],
            MeterStart {
                level: Some(50.0),
                reset_ms: Some(1_000_000_000),
            },
            19.8,
        );
        assert_eq!(pcts(&out), vec![1.0, 0.5]);
        assert!(out.iter().all(|s| s.source == PctSource::Pending));
    }

    #[test]
    fn a_dip_from_another_edge_moves_nothing_and_does_not_double_count() {
        // 42 → 41 → 42: only the first rise to 43 is a step.
        let out = distribute(
            &[
                rec(1, 1.0, Some(0.41)),
                rec(2, 1.0, Some(0.42)),
                rec(3, 1.0, Some(0.43)),
            ],
            MeterStart {
                level: Some(42.0),
                reset_ms: Some(1_000_000_000),
            },
            20.0,
        );
        assert_eq!(pcts(&out), vec![0.333, 0.333, 0.333]);
        assert_eq!(out[2].level, Some(43.0));
    }

    #[test]
    fn without_a_known_level_the_first_reading_is_the_baseline() {
        let out = distribute(
            &[rec(1, 5.0, Some(0.30)), rec(2, 5.0, Some(0.31))],
            MeterStart::default(),
            20.0,
        );
        // #1 sets the baseline at 30 %, then waits with #2 for the step to 31 %.
        assert_eq!(pcts(&out), vec![0.5, 0.5]);
        assert!(out.iter().all(|s| s.source == PctSource::Meter));
    }

    #[test]
    fn a_new_window_settles_the_old_one_and_starts_at_zero() {
        let week = 7 * 86_400_000;
        let mut a = rec(1, 10.0, Some(0.97));
        a.reset_ms = Some(5_000_000_000);
        let mut b = rec(2, 10.0, Some(0.01));
        b.reset_ms = Some(5_000_000_000 + week);
        let out = distribute(
            &[a, b],
            MeterStart {
                level: Some(97.0),
                reset_ms: Some(5_000_000_000),
            },
            20.0,
        );
        // #1 never saw a step in its window: estimated, and final.
        assert_eq!(out[0].source, PctSource::Estimate);
        assert!((out[0].pct - 0.5).abs() < 1e-9);
        // #2 is the first request of the new window: 0 → 1 %.
        assert_eq!(out[1].source, PctSource::Meter);
        assert!((out[1].pct - 1.0).abs() < 1e-9);
        assert_eq!(out[1].level, Some(1.0));
    }

    #[test]
    fn a_large_fall_without_reset_times_is_a_new_window() {
        let mut a = rec(1, 10.0, Some(0.80));
        a.reset_ms = None;
        let mut b = rec(2, 10.0, Some(0.02));
        b.reset_ms = None;
        let mut c = rec(3, 10.0, Some(0.03));
        c.reset_ms = None;
        let out = distribute(
            &[a, b, c],
            MeterStart {
                level: Some(80.0),
                reset_ms: None,
            },
            20.0,
        );
        assert_eq!(out[0].source, PctSource::Estimate);
        assert_eq!(out[1].source, PctSource::Meter);
        assert_eq!(out[2].source, PctSource::Meter);
        assert!((out[1].pct + out[2].pct - 1.0).abs() < 1e-9);
    }

    #[test]
    fn free_requests_share_a_step_evenly() {
        let out = distribute(
            &[rec(1, 0.0, None), rec(2, 0.0, Some(0.11))],
            MeterStart {
                level: Some(10.0),
                reset_ms: Some(1_000_000_000),
            },
            20.0,
        );
        assert_eq!(pcts(&out), vec![0.5, 0.5]);
    }

    #[test]
    fn dollars_per_percent_needs_enough_movement() {
        assert_eq!(measured_usd_per_pct(40.0, 2.0), None);
        assert_eq!(measured_usd_per_pct(60.0, 3.0), Some(20.0));
        assert_eq!(measured_usd_per_pct(0.0, 10.0), None);
    }
}
