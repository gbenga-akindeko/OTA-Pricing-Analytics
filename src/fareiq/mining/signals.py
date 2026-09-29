"""Data mining over the collected market history.

The pricing engine answers "what should we charge". This module answers the
questions that come before it: is anything in today's data wrong, has a
competitor changed behaviour, and what shape does this route's pricing
actually have?

Everything here emits a ``MiningSignal``, which lands in
``tvd_fareiq_mart.fact_mining_signal`` and surfaces on the dashboard. A signal
is never a price change. It is a reason for a human to look, and for the
engine to lower its confidence.

Dependencies are pandas, numpy and scikit-learn, all of which run happily in
the Cloud Run job. Nothing here needs a GPU or a model server.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timezone
from typing import Any, Literal

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

Severity = Literal["LOW", "MEDIUM", "HIGH"]

SIGNAL_TYPES = (
    "PRICE_ANOMALY",          # a price far from what this cell normally costs
    "COMPETITOR_ANOMALY",     # a competitor behaving unlike itself
    "COMPETITOR_REGIME_SHIFT",# a sustained change, not a one-day blip
    "FEE_CHANGE",             # an ancillary moved
    "COVERAGE_DROP",          # we stopped seeing a seller we usually see
    "PRICE_PATTERN",          # a recurring, exploitable shape in the data
    "SUSPECTED_MISTAKE_FARE", # too cheap to be real
)


@dataclass
class MiningSignal:
    signal_date: date
    signal_type: str
    severity: Severity
    metric: str
    observed_value: float | None = None
    expected_value: float | None = None
    deviation_score: float | None = None
    route_key: str | None = None
    seller_id: str | None = None
    carrier: str | None = None
    detail: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_bq_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["signal_date"] = self.signal_date.isoformat()
        row["evidence"] = None if not self.evidence else self.evidence
        row["detected_at"] = datetime.now(timezone.utc).isoformat()
        return row


def _severity(z: float) -> Severity:
    a = abs(z)
    if a >= 4.0:
        return "HIGH"
    if a >= 2.5:
        return "MEDIUM"
    return "LOW"


# ======================================================================
# 1. Price anomalies
# ======================================================================
def detect_price_anomalies(
    offers: pd.DataFrame,
    *,
    min_history: int = 12,
    z_threshold: float = 3.0,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Flag today's observations that sit far from their own cell's history.

    Robust statistics throughout: median and MAD rather than mean and standard
    deviation, because one mistake fare in the history would otherwise inflate
    the spread enough to hide the next one.

    Expects columns: route_key, seller_id, cabin, obs_date, comparable_cost.
    """
    required = {"route_key", "seller_id", "cabin", "obs_date", "comparable_cost"}
    missing = required - set(offers.columns)
    if missing:
        raise ValueError(f"detect_price_anomalies missing columns: {sorted(missing)}")
    if offers.empty:
        return []

    df = offers.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()

    signals: list[MiningSignal] = []
    for (route, seller, cabin), group in df.groupby(["route_key", "seller_id", "cabin"]):
        history = group[group["obs_date"] < today]["comparable_cost"].dropna()
        current = group[group["obs_date"] == today]["comparable_cost"].dropna()
        if len(history) < min_history or current.empty:
            continue

        median = float(history.median())
        mad = float((history - median).abs().median())
        # 1.4826 scales MAD to a standard-deviation equivalent for normal data.
        scale = mad * 1.4826
        if scale <= 0:
            continue

        observed = float(current.median())
        z = (observed - median) / scale
        if abs(z) < z_threshold:
            continue

        too_cheap = z <= -z_threshold and observed < median * 0.6
        signals.append(MiningSignal(
            signal_date=today,
            signal_type="SUSPECTED_MISTAKE_FARE" if too_cheap else "PRICE_ANOMALY",
            severity="HIGH" if too_cheap else _severity(z),
            metric="comparable_cost",
            observed_value=round(observed, 2),
            expected_value=round(median, 2),
            deviation_score=round(z, 2),
            route_key=route, seller_id=seller,
            detail=(
                f"{seller} on {route} {cabin.lower()} is {abs(z):.1f} robust deviations "
                f"{'below' if z < 0 else 'above'} its own {len(history)}-day median. "
                + ("This far below is usually an error, a fare the seller will not honour, "
                   "or a different product. Excluded from the market panel until reviewed."
                   if too_cheap else
                   "Worth confirming before it moves our market median.")
            ),
            evidence={"history_points": int(len(history)), "mad": round(mad, 2),
                      "cabin": cabin},
        ))
    return signals


# ======================================================================
# 2. Competitor behaviour
# ======================================================================
def detect_competitor_anomalies(
    daily: pd.DataFrame,
    *,
    window: int = 21,
    z_threshold: float = 2.5,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Flag a competitor whose POSITION against the market has changed.

    The measured quantity is deliberately the seller's price divided by the
    market median, not its raw price. Measured on raw price, a fuel surcharge
    that lifts the whole market lights up every seller on the panel at once,
    and the analyst learns to ignore the report. Measured on position, only
    the seller who actually moved relative to everyone else appears.

    Expects: seller_id, route_key, obs_date, median_price, and market_median
    where available. Without market_median it falls back to raw price and says
    so in the evidence, because a relative measure is not available.
    """
    required = {"seller_id", "route_key", "obs_date", "median_price"}
    if required - set(daily.columns):
        raise ValueError(f"detect_competitor_anomalies missing: {sorted(required - set(daily.columns))}")
    if daily.empty:
        return []

    df = daily.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()

    relative = "market_median" in df.columns and (df["market_median"] > 0).any()
    if relative:
        df = df[df["market_median"] > 0].copy()
        df["_metric"] = df["median_price"] / df["market_median"]
    else:
        df["_metric"] = df["median_price"]

    # One row per seller, route and day, so a duplicated feed cannot skew the
    # window or be mistaken for extra history.
    df = (df.groupby(["seller_id", "route_key", "obs_date"], as_index=False)
            .agg(_metric=("_metric", "median"), median_price=("median_price", "median")))

    signals: list[MiningSignal] = []
    for (seller, route), group in df.groupby(["seller_id", "route_key"]):
        g = group.sort_values("obs_date")
        hist = g[g["obs_date"] < today].tail(window)
        cur = g[g["obs_date"] == today]
        if len(hist) < max(7, window // 3) or cur.empty:
            continue

        mean = float(hist["_metric"].mean())
        sd = float(hist["_metric"].std(ddof=1))
        if not np.isfinite(sd) or sd <= 0:
            continue

        observed = float(cur["_metric"].iloc[0])
        z = (observed - mean) / sd
        if abs(z) < z_threshold:
            continue

        observed_price = float(cur["median_price"].iloc[0])
        expected_price = observed_price / observed * mean if observed else None
        signals.append(MiningSignal(
            signal_date=today, signal_type="COMPETITOR_ANOMALY",
            severity=_severity(z),
            metric="index_vs_market" if relative else "median_price",
            observed_value=round(observed_price, 2),
            expected_value=round(expected_price, 2) if expected_price else None,
            deviation_score=round(z, 2), route_key=route, seller_id=seller,
            detail=(
                f"{seller} moved to {observed_price:,.0f} on {route}, "
                + (f"taking its position to {observed:.3f} of the market median against a "
                   f"{len(hist)}-day norm of {mean:.3f}. " if relative else
                   f"{abs(z):.1f} standard deviations from its own {len(hist)}-day mean. ")
                + f"That is {abs(z):.1f} deviations, so this seller moved relative to the "
                  f"rest of the panel rather than being carried by a market-wide change."
            ),
            evidence={"window_days": int(len(hist)), "sd": round(sd, 4),
                      "measured_on": "index_vs_market" if relative else "raw_price"},
        ))
    return signals


def detect_regime_shifts(
    daily: pd.DataFrame,
    *,
    lookback: int = 45,
    min_shift_pct: float = 0.08,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Find sustained level changes rather than single-day spikes.

    A CUSUM-style split: compare the mean of the most recent week against the
    weeks before it, and only report when the gap is both large and stable.
    This is the signal that actually matters commercially, because a
    competitor who has repriced will stay repriced.
    """
    required = {"seller_id", "route_key", "obs_date", "median_price"}
    if required - set(daily.columns):
        raise ValueError(f"detect_regime_shifts missing: {sorted(required - set(daily.columns))}")
    if daily.empty:
        return []

    df = daily.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()

    # Collapse to one observation per day first. A feed that delivers a seller
    # twice in a day would otherwise put both levels inside the recent window
    # and the stability check would read a clean reprice as noise.
    df = (df.groupby(["seller_id", "route_key", "obs_date"], as_index=False)
            .agg(median_price=("median_price", "median")))

    signals: list[MiningSignal] = []
    for (seller, route), group in df.groupby(["seller_id", "route_key"]):
        g = group.sort_values("obs_date").tail(lookback)
        if len(g) < 21:
            continue
        recent = g.tail(7)["median_price"].dropna()
        before = g.iloc[:-7]["median_price"].dropna()
        if len(recent) < 5 or len(before) < 10:
            continue

        r_mean, b_mean = float(recent.mean()), float(before.mean())
        if b_mean <= 0:
            continue
        shift = (r_mean - b_mean) / b_mean
        if abs(shift) < min_shift_pct:
            continue

        # Stability: the new level must be tight, or it is noise, not a regime.
        r_cv = float(recent.std(ddof=1) / r_mean) if r_mean else 1.0
        if not np.isfinite(r_cv) or r_cv > 0.06:
            continue

        signals.append(MiningSignal(
            signal_date=today, signal_type="COMPETITOR_REGIME_SHIFT",
            severity="HIGH" if abs(shift) >= 0.15 else "MEDIUM",
            metric="median_price_level",
            observed_value=round(r_mean, 2), expected_value=round(b_mean, 2),
            deviation_score=round(shift * 100, 2),
            route_key=route, seller_id=seller,
            detail=(
                f"{seller} has held a {shift * 100:+.1f}% different price level on {route} "
                f"for a week ({r_mean:,.0f} against {b_mean:,.0f} before). Sustained and "
                f"stable, so this is a repricing decision rather than a fluctuation."
            ),
            evidence={"recent_cv": round(r_cv, 4), "days_observed": int(len(g))},
        ))
    return signals


def detect_coverage_drops(
    daily: pd.DataFrame,
    *,
    as_of: date | None = None,
    min_expected_days: int = 10,
) -> list[MiningSignal]:
    """A seller we normally observe has gone missing. Coverage silently falling
    is the most dangerous failure in this platform, because every market
    statistic keeps computing and simply becomes wrong."""
    required = {"seller_id", "route_key", "obs_date"}
    if required - set(daily.columns):
        raise ValueError(f"detect_coverage_drops missing: {sorted(required - set(daily.columns))}")
    if daily.empty:
        return []

    df = daily.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()
    recent_window = df[df["obs_date"] >= today - pd.Timedelta(days=14).to_pytimedelta()]

    signals: list[MiningSignal] = []
    for (seller, route), group in recent_window.groupby(["seller_id", "route_key"]):
        days_seen = group[group["obs_date"] < today]["obs_date"].nunique()
        seen_today = (group["obs_date"] == today).any()
        if days_seen >= min_expected_days and not seen_today:
            signals.append(MiningSignal(
                signal_date=today, signal_type="COVERAGE_DROP", severity="MEDIUM",
                metric="seller_observed", observed_value=0.0, expected_value=1.0,
                deviation_score=float(days_seen),
                route_key=route, seller_id=seller,
                detail=(
                    f"{seller} appeared on {route} on {days_seen} of the last 14 days but "
                    f"not today. Either the source changed or our collector broke; until "
                    f"one of those is ruled out, the market median for this route is "
                    f"computed on a thinner panel than usual."
                ),
            ))
    return signals


# ======================================================================
# 3. Pattern mining
# ======================================================================
def mine_price_patterns(
    offers: pd.DataFrame,
    *,
    min_observations: int = 60,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Recurring, exploitable shapes in a route's pricing.

    Two patterns worth acting on, both testable rather than folklore:
      * a day-of-week effect in the market price
      * a booking-curve inflection, the days-to-departure bucket where the
        market price jumps

    Expects: route_key, obs_date, departure_date, comparable_cost.
    """
    required = {"route_key", "obs_date", "departure_date", "comparable_cost"}
    if required - set(offers.columns):
        raise ValueError(f"mine_price_patterns missing: {sorted(required - set(offers.columns))}")
    if offers.empty:
        return []

    df = offers.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"])
    df["departure_date"] = pd.to_datetime(df["departure_date"])
    df["dtd"] = (df["departure_date"] - df["obs_date"]).dt.days
    df["dep_dow"] = df["departure_date"].dt.dayofweek
    today = as_of or df["obs_date"].max().date()

    signals: list[MiningSignal] = []
    for route, group in df.groupby("route_key"):
        if len(group) < min_observations:
            continue

        # -- departure day-of-week effect -------------------------------
        dow = group.groupby("dep_dow")["comparable_cost"].agg(["median", "count"])
        dow = dow[dow["count"] >= 5]
        if len(dow) >= 5:
            overall = float(group["comparable_cost"].median())
            dearest = dow["median"].idxmax()
            cheapest = dow["median"].idxmin()
            spread = (float(dow["median"].max()) - float(dow["median"].min())) / overall
            if spread >= 0.10:
                names = ["Monday", "Tuesday", "Wednesday", "Thursday",
                         "Friday", "Saturday", "Sunday"]
                signals.append(MiningSignal(
                    signal_date=today, signal_type="PRICE_PATTERN", severity="LOW",
                    metric="departure_dow_spread",
                    observed_value=round(spread * 100, 2), expected_value=0.0,
                    deviation_score=round(spread * 100, 2), route_key=route,
                    detail=(
                        f"On {route} the market is {spread * 100:.0f}% dearer for "
                        f"{names[int(dearest)]} departures than {names[int(cheapest)]} ones. "
                        f"Our markup is currently flat across the week, so this is margin "
                        f"available on the dear days and share available on the cheap ones."
                    ),
                    evidence={"dearest_dow": names[int(dearest)],
                              "cheapest_dow": names[int(cheapest)],
                              "observations": int(len(group))},
                ))

        # -- booking-curve inflection -----------------------------------
        buckets = pd.cut(group["dtd"], [-1, 3, 7, 14, 21, 30, 60, 90, 9999],
                         labels=["0-3", "4-7", "8-14", "15-21", "22-30", "31-60", "61-90", "90+"])
        curve = group.groupby(buckets, observed=True)["comparable_cost"].median().dropna()
        if len(curve) >= 4:
            values = curve.values.astype(float)
            # Walk from far-out to near-in; find the largest single step up.
            ordered = list(reversed(list(curve.index)))
            ordered_vals = list(reversed(list(values)))
            jumps = [(ordered[i + 1], (ordered_vals[i + 1] - ordered_vals[i]) / ordered_vals[i])
                     for i in range(len(ordered_vals) - 1) if ordered_vals[i] > 0]
            if jumps:
                bucket, jump = max(jumps, key=lambda x: x[1])
                if jump >= 0.12:
                    signals.append(MiningSignal(
                        signal_date=today, signal_type="PRICE_PATTERN", severity="MEDIUM",
                        metric="booking_curve_step",
                        observed_value=round(jump * 100, 2), expected_value=0.0,
                        deviation_score=round(jump * 100, 2), route_key=route,
                        detail=(
                            f"On {route} the market steps up {jump * 100:.0f}% entering the "
                            f"{bucket} days-to-departure band. Holding our price flat across "
                            f"that boundary leaves margin on the table on the near side and "
                            f"makes us look expensive on the far side."
                        ),
                        evidence={"bucket": str(bucket),
                                  "curve": {str(k): round(float(v), 2) for k, v in curve.items()}},
                    ))
    return signals


# ======================================================================
# 4. Competitor segmentation
# ======================================================================
def cluster_competitors(
    daily: pd.DataFrame,
    *,
    n_clusters: int = 3,
    min_sellers: int = 4,
    as_of: date | None = None,
) -> tuple[pd.DataFrame, list[MiningSignal]]:
    """Group competitors by how they behave, not by how big they are.

    Four features, each one a behaviour a pricing analyst would name:
    typical position against the market, how often they win on price, how
    volatile their prices are, and how broad their coverage is. K-means on the
    standardised features, then the clusters are labelled from their centroids
    so the output reads in words rather than as "cluster 2".

    Expects: seller_id, route_key, obs_date, median_price, market_median, win_rate.
    """
    required = {"seller_id", "route_key", "obs_date", "median_price", "market_median"}
    if required - set(daily.columns):
        raise ValueError(f"cluster_competitors missing: {sorted(required - set(daily.columns))}")

    df = daily.copy()
    if df.empty:
        return pd.DataFrame(), []
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()
    df = df[df["market_median"] > 0]
    df["index_vs_market"] = df["median_price"] / df["market_median"]

    feats = df.groupby("seller_id").agg(
        avg_index=("index_vs_market", "mean"),
        volatility=("index_vs_market", "std"),
        win_rate=("win_rate", "mean") if "win_rate" in df.columns else ("index_vs_market", "size"),
        routes=("route_key", "nunique"),
        observations=("median_price", "size"),
    ).dropna(subset=["avg_index"])

    feats["volatility"] = feats["volatility"].fillna(0.0)
    feats = feats[feats["observations"] >= 10]
    if len(feats) < min_sellers:
        log.info("Only %d sellers with enough history; skipping clustering", len(feats))
        return feats.reset_index(), []

    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler

    cols = ["avg_index", "volatility", "win_rate", "routes"]
    X = StandardScaler().fit_transform(feats[cols].values)
    k = int(min(n_clusters, max(2, len(feats) - 1)))
    model = KMeans(n_clusters=k, n_init=10, random_state=42)
    feats["cluster"] = model.fit_predict(X)

    centres = feats.groupby("cluster")[cols].mean()
    labels: dict[int, str] = {}
    for cid, row in centres.iterrows():
        if row["avg_index"] <= centres["avg_index"].quantile(0.34):
            labels[cid] = "Price leader"
        elif row["avg_index"] >= centres["avg_index"].quantile(0.66):
            labels[cid] = "Premium position"
        elif row["volatility"] >= centres["volatility"].median():
            labels[cid] = "Opportunistic"
        else:
            labels[cid] = "Market follower"
    feats["segment"] = feats["cluster"].map(labels)

    signals = [
        MiningSignal(
            signal_date=today, signal_type="PRICE_PATTERN", severity="LOW",
            metric="competitor_segment",
            observed_value=round(float(row["avg_index"]), 3),
            expected_value=1.0,
            deviation_score=round((float(row["avg_index"]) - 1.0) * 100, 2),
            seller_id=str(seller),
            detail=(
                f"{seller} behaves as a {row['segment'].lower()}: typically "
                f"{row['avg_index']:.2f}x the market median across {int(row['routes'])} routes, "
                f"with {'high' if row['volatility'] > feats['volatility'].median() else 'steady'} "
                f"price volatility. Segment membership is a better guide to how they will "
                f"respond to our move than their size is."
            ),
            evidence={"segment": row["segment"], "volatility": round(float(row["volatility"]), 4)},
        )
        for seller, row in feats.iterrows()
    ]
    return feats.reset_index(), signals


# ======================================================================
# 5. Fee change mining
# ======================================================================
def detect_fee_changes(
    fees: pd.DataFrame,
    *,
    min_change_pct: float = 0.02,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Compare today's observed fee catalogue against the last known version.

    Expects: carrier, fee_type, pos_country, obs_date, amount.
    """
    required = {"carrier", "fee_type", "obs_date", "amount"}
    if required - set(fees.columns):
        raise ValueError(f"detect_fee_changes missing: {sorted(required - set(fees.columns))}")
    if fees.empty:
        return []

    df = fees.copy()
    df["obs_date"] = pd.to_datetime(df["obs_date"]).dt.date
    today = as_of or df["obs_date"].max()
    keys = ["carrier", "fee_type"] + (["pos_country"] if "pos_country" in df.columns else [])

    signals: list[MiningSignal] = []
    for key, group in df.groupby(keys):
        g = group.sort_values("obs_date")
        cur = g[g["obs_date"] == today]["amount"].dropna()
        prev = g[g["obs_date"] < today]["amount"].dropna()
        if cur.empty or prev.empty:
            continue
        new, old = float(cur.iloc[-1]), float(prev.iloc[-1])
        if old <= 0:
            continue
        change = (new - old) / old
        if abs(change) < min_change_pct:
            continue

        key_tuple = key if isinstance(key, tuple) else (key,)
        carrier, fee_type = key_tuple[0], key_tuple[1]
        signals.append(MiningSignal(
            signal_date=today, signal_type="FEE_CHANGE",
            severity="HIGH" if abs(change) >= 0.20 else
                     "MEDIUM" if abs(change) >= 0.05 else "LOW",
            metric=str(fee_type), observed_value=round(new, 2), expected_value=round(old, 2),
            deviation_score=round(change * 100, 2), carrier=str(carrier),
            detail=(
                f"{carrier} moved {fee_type} from {old:,.0f} to {new:,.0f} "
                f"({change * 100:+.1f}%). Every true customer cost on this carrier shifts "
                f"by that amount, so our position against the market changes without our "
                f"price moving at all."
            ),
            evidence={"key": list(key_tuple)},
        ))
    return signals


# ======================================================================
# Orchestration
# ======================================================================
def run_all(
    *,
    offers: pd.DataFrame | None = None,
    competitor_daily: pd.DataFrame | None = None,
    fees: pd.DataFrame | None = None,
    as_of: date | None = None,
) -> list[MiningSignal]:
    """Run every detector that has the data it needs, and never let one
    failing detector lose the others' output."""
    signals: list[MiningSignal] = []
    jobs = []

    if offers is not None and not offers.empty:
        jobs += [("price_anomalies", lambda: detect_price_anomalies(offers, as_of=as_of)),
                 ("price_patterns", lambda: mine_price_patterns(offers, as_of=as_of))]
    if competitor_daily is not None and not competitor_daily.empty:
        jobs += [("competitor_anomalies", lambda: detect_competitor_anomalies(competitor_daily, as_of=as_of)),
                 ("regime_shifts", lambda: detect_regime_shifts(competitor_daily, as_of=as_of)),
                 ("coverage_drops", lambda: detect_coverage_drops(competitor_daily, as_of=as_of)),
                 ("clusters", lambda: cluster_competitors(competitor_daily, as_of=as_of)[1])]
    if fees is not None and not fees.empty:
        jobs += [("fee_changes", lambda: detect_fee_changes(fees, as_of=as_of))]

    for name, job in jobs:
        try:
            found = job()
            log.info("%s produced %d signals", name, len(found))
            signals.extend(found)
        except Exception as exc:
            log.exception("mining job %s failed: %s", name, exc)

    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    signals.sort(key=lambda s: (order[s.severity], -abs(s.deviation_score or 0)))
    return signals
