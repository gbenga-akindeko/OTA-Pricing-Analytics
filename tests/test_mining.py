"""Tests for the mining detectors.

Each test builds a market that contains exactly one thing worth finding, then
checks the detector finds it and, just as importantly, does not find things
that are not there. A detector that fires on a quiet market is worse than no
detector, because the analyst stops reading it.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import pytest

from fareiq.mining.signals import (
    cluster_competitors, detect_coverage_drops, detect_competitor_anomalies,
    detect_fee_changes, detect_price_anomalies, detect_regime_shifts,
    mine_price_patterns, run_all,
)

TODAY = date(2026, 9, 20)


def days(n: int):
    return [TODAY - timedelta(days=i) for i in range(n, 0, -1)]


# ------------------------------------------------------------ price anomalies
def offers_frame(prices_by_date, route="LOS-LHR", seller="competitor_a", cabin="ECONOMY"):
    return pd.DataFrame([
        {"route_key": route, "seller_id": seller, "cabin": cabin,
         "obs_date": d, "comparable_cost": p}
        for d, p in prices_by_date
    ])


def test_a_stable_market_produces_no_price_anomalies():
    stable = [(d, 1_000_000 + (i % 3) * 4_000) for i, d in enumerate(days(30))]
    stable.append((TODAY, 1_004_000))
    assert detect_price_anomalies(offers_frame(stable), as_of=TODAY) == []


def test_a_price_far_above_its_own_history_is_flagged():
    history = [(d, 1_000_000 + (i % 3) * 4_000) for i, d in enumerate(days(30))]
    history.append((TODAY, 1_800_000))
    signals = detect_price_anomalies(offers_frame(history), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].signal_type == "PRICE_ANOMALY"
    assert signals[0].deviation_score > 3


def test_a_price_far_below_history_is_called_a_suspected_mistake_fare():
    """The scenario that protects the market median from one bad row."""
    history = [(d, 1_000_000 + (i % 3) * 4_000) for i, d in enumerate(days(30))]
    history.append((TODAY, 300_000))
    signals = detect_price_anomalies(offers_frame(history), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].signal_type == "SUSPECTED_MISTAKE_FARE"
    assert signals[0].severity == "HIGH"
    assert "will not honour" in signals[0].detail


def test_one_outlier_in_history_does_not_hide_the_next_one():
    """Robust statistics earn their keep here: with mean and standard
    deviation, a single 3m fare in the history would widen the spread enough
    that today's 1.8m would look ordinary."""
    history = [(d, 1_000_000 + (i % 3) * 4_000) for i, d in enumerate(days(30))]
    history[5] = (history[5][0], 3_000_000)          # an old mistake fare
    history.append((TODAY, 1_800_000))
    signals = detect_price_anomalies(offers_frame(history), as_of=TODAY)
    assert len(signals) == 1


def test_too_little_history_produces_nothing():
    short = [(d, 1_000_000) for d in days(5)] + [(TODAY, 2_000_000)]
    assert detect_price_anomalies(offers_frame(short), as_of=TODAY) == []


def test_missing_columns_fail_loudly():
    with pytest.raises(ValueError, match="missing columns"):
        detect_price_anomalies(pd.DataFrame({"route_key": ["LOS-LHR"]}))


# ------------------------------------------------------------ competitors
def daily_frame(rows):
    return pd.DataFrame(rows)


def test_a_competitor_moving_alone_is_flagged():
    rows = [{"seller_id": "competitor_a", "route_key": "LOS-LHR",
             "obs_date": d, "median_price": 1_000_000 + (i % 2) * 5_000,
             "market_median": 1_000_000, "win_rate": 0.2}
            for i, d in enumerate(days(21))]
    rows.append({"seller_id": "competitor_a", "route_key": "LOS-LHR",
                 "obs_date": TODAY, "median_price": 1_200_000,
                 "market_median": 1_000_000, "win_rate": 0.2})
    # the rest of the panel holds station, so only competitor_a has moved
    for seller in ("competitor_b", "competitor_c"):
        for i, d in enumerate(days(21) + [TODAY]):
            rows.append({"seller_id": seller, "route_key": "LOS-LHR", "obs_date": d,
                         "median_price": 1_000_000, "market_median": 1_000_000,
                         "win_rate": 0.3})
    signals = detect_competitor_anomalies(daily_frame(rows), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].seller_id == "competitor_a"


def test_the_whole_panel_moving_together_is_not_a_per_seller_anomaly():
    """Sellers are measured on their position against the market, so a
    market-wide move carries everyone and flags no one."""
    rows = []
    for seller in ("competitor_a", "competitor_b", "competitor_c"):
        for i, d in enumerate(days(21)):
            rows.append({"seller_id": seller, "route_key": "LOS-LHR", "obs_date": d,
                         "median_price": 1_000_000 + (i % 2) * 5_000,
                         "market_median": 1_000_000, "win_rate": 0.3})
        rows.append({"seller_id": seller, "route_key": "LOS-LHR", "obs_date": TODAY,
                     "median_price": 1_030_000, "market_median": 1_030_000, "win_rate": 0.3})
    signals = detect_competitor_anomalies(daily_frame(rows), as_of=TODAY)
    assert signals == []


def test_a_sustained_reprice_is_a_regime_shift():
    window = days(38)
    rows = [{"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": d,
             "median_price": 1_000_000 + (i % 2) * 3_000,
             "market_median": 1_000_000, "win_rate": 0.2}
            for i, d in enumerate(window[:-7])]
    for d in window[-7:]:
        rows.append({"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": d,
                     "median_price": 880_000, "market_median": 1_000_000, "win_rate": 0.5})
    signals = detect_regime_shifts(daily_frame(rows), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].deviation_score < -8
    assert "repricing decision" in signals[0].detail


def test_a_one_day_spike_is_not_a_regime_shift():
    rows = [{"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": d,
             "median_price": 1_000_000, "market_median": 1_000_000, "win_rate": 0.2}
            for d in days(30)]
    rows.append({"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": TODAY,
                 "median_price": 700_000, "market_median": 1_000_000, "win_rate": 0.9})
    assert detect_regime_shifts(daily_frame(rows), as_of=TODAY) == []


def test_a_seller_that_disappears_today_is_flagged():
    rows = [{"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": d,
             "median_price": 1_000_000, "market_median": 1_000_000, "win_rate": 0.2}
            for d in days(13)]
    rows.append({"seller_id": "competitor_b", "route_key": "LOS-LHR", "obs_date": TODAY,
                 "median_price": 990_000, "market_median": 990_000, "win_rate": 1.0})
    signals = detect_coverage_drops(daily_frame(rows), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].seller_id == "competitor_a"
    assert signals[0].signal_type == "COVERAGE_DROP"


def test_a_seller_present_today_is_not_flagged_as_missing():
    rows = [{"seller_id": "competitor_a", "route_key": "LOS-LHR", "obs_date": d,
             "median_price": 1_000_000, "market_median": 1_000_000, "win_rate": 0.2}
            for d in days(13) + [TODAY]]
    assert detect_coverage_drops(daily_frame(rows), as_of=TODAY) == []


# ------------------------------------------------------------ patterns
def test_a_day_of_week_effect_is_found():
    rows = []
    for i, obs in enumerate(days(40)):
        for offset in range(1, 12):
            dep = obs + timedelta(days=offset)
            # Friday departures priced 20% above the rest.
            price = 1_200_000 if dep.weekday() == 4 else 1_000_000
            rows.append({"route_key": "LOS-LHR", "obs_date": obs,
                         "departure_date": dep, "comparable_cost": price})
    signals = mine_price_patterns(pd.DataFrame(rows), as_of=TODAY)
    dow = [s for s in signals if s.metric == "departure_dow_spread"]
    assert len(dow) == 1
    assert dow[0].evidence["dearest_dow"] == "Friday"


def test_a_flat_market_produces_no_pattern_signal():
    rows = [{"route_key": "LOS-LHR", "obs_date": obs,
             "departure_date": obs + timedelta(days=offset), "comparable_cost": 1_000_000}
            for obs in days(40) for offset in range(1, 12)]
    assert mine_price_patterns(pd.DataFrame(rows), as_of=TODAY) == []


def test_a_booking_curve_step_is_found():
    rows = []
    for obs in days(40):
        for offset in (2, 5, 10, 18, 25, 45, 75, 120):
            dep = obs + timedelta(days=offset)
            price = 1_500_000 if offset <= 7 else 1_000_000
            rows.append({"route_key": "LOS-LHR", "obs_date": obs,
                         "departure_date": dep, "comparable_cost": price})
    signals = mine_price_patterns(pd.DataFrame(rows), as_of=TODAY)
    steps = [s for s in signals if s.metric == "booking_curve_step"]
    assert len(steps) == 1
    assert steps[0].observed_value >= 12


# ------------------------------------------------------------ clustering
def test_competitors_are_segmented_by_behaviour():
    rows = []
    profiles = {
        "leader_a":   (0.90, 0.005),
        "leader_b":   (0.92, 0.006),
        "follower_a": (1.00, 0.004),
        "follower_b": (1.01, 0.005),
        "premium_a":  (1.14, 0.004),
        "premium_b":  (1.16, 0.005),
    }
    for seller, (level, vol) in profiles.items():
        for i, d in enumerate(days(20)):
            rows.append({
                "seller_id": seller, "route_key": "LOS-LHR", "obs_date": d,
                "median_price": 1_000_000 * (level + (i % 2) * vol),
                "market_median": 1_000_000,
                "win_rate": 0.6 if level < 0.95 else 0.1,
            })
    feats, signals = cluster_competitors(pd.DataFrame(rows), as_of=TODAY)
    assert len(feats) == 6
    assert len(signals) == 6
    segments = dict(zip(feats["seller_id"], feats["segment"]))
    # The two cheapest must not land in the same segment as the two dearest.
    assert segments["leader_a"] != segments["premium_a"]
    assert segments["leader_a"] == segments["leader_b"]


def test_clustering_declines_on_too_few_sellers():
    rows = [{"seller_id": "only_one", "route_key": "LOS-LHR", "obs_date": d,
             "median_price": 1_000_000, "market_median": 1_000_000, "win_rate": 0.5}
            for d in days(20)]
    feats, signals = cluster_competitors(pd.DataFrame(rows), as_of=TODAY)
    assert signals == []


# ------------------------------------------------------------ fees
def test_a_fee_increase_is_detected_and_sized():
    rows = [{"carrier": "VS", "fee_type": "BAG_1ST", "pos_country": "NG",
             "obs_date": d, "amount": 60_000} for d in days(10)]
    rows.append({"carrier": "VS", "fee_type": "BAG_1ST", "pos_country": "NG",
                 "obs_date": TODAY, "amount": 75_000})
    signals = detect_fee_changes(pd.DataFrame(rows), as_of=TODAY)
    assert len(signals) == 1
    assert signals[0].severity == "HIGH"          # +25%
    assert signals[0].deviation_score == pytest.approx(25.0, abs=0.1)
    assert "without our" in signals[0].detail


def test_an_unchanged_fee_is_not_reported():
    rows = [{"carrier": "VS", "fee_type": "BAG_1ST", "pos_country": "NG",
             "obs_date": d, "amount": 60_000} for d in days(10) + [TODAY]]
    assert detect_fee_changes(pd.DataFrame(rows), as_of=TODAY) == []


# ------------------------------------------------------------ orchestration
def test_run_all_survives_a_failing_detector():
    """One malformed frame must not lose the other detectors' output."""
    good_fees = pd.DataFrame(
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": d, "amount": 60_000}
         for d in days(10)] +
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": TODAY, "amount": 90_000}])
    broken_offers = pd.DataFrame({"route_key": ["LOS-LHR"], "nonsense": [1]})

    signals = run_all(offers=broken_offers, fees=good_fees, as_of=TODAY)
    assert any(s.signal_type == "FEE_CHANGE" for s in signals)


def test_run_all_sorts_high_severity_first():
    fees = pd.DataFrame(
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": d, "amount": 60_000} for d in days(10)] +
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": TODAY, "amount": 90_000}] +
        [{"carrier": "KQ", "fee_type": "SEAT_STD", "obs_date": d, "amount": 10_000} for d in days(10)] +
        [{"carrier": "KQ", "fee_type": "SEAT_STD", "obs_date": TODAY, "amount": 10_300}])
    signals = run_all(fees=fees, as_of=TODAY)
    assert len(signals) == 2
    assert signals[0].severity == "HIGH"
    assert signals[1].severity == "LOW"


def test_signals_serialise_for_bigquery():
    fees = pd.DataFrame(
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": d, "amount": 60_000} for d in days(10)] +
        [{"carrier": "VS", "fee_type": "BAG_1ST", "obs_date": TODAY, "amount": 90_000}])
    row = detect_fee_changes(fees, as_of=TODAY)[0].to_bq_row()
    assert row["signal_date"] == TODAY.isoformat()
    assert set(["signal_type", "severity", "metric", "detected_at"]).issubset(row)
