"""Tests for the permitted-public collection guards.

These are compliance tests, not unit tests. Each one pins a control that keeps
collection defensible, so if one fails somebody has removed a safeguard and
should have to say so out loud.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from fareiq.collectors.scraping import (
    SourceRegistration, extract_jsonld_offers, origin_of, parse_duration_minutes,
    parse_money, parse_stops,
)
from fareiq.core.models import ShopRequest


def reg(**over) -> SourceRegistration:
    base = dict(
        source_id="example_public",
        base_url="https://example.test",
        enabled=True,
        terms_permit_collection=True,
        robots_allows_path=True,
        legal_review_date=date.today() - timedelta(days=10),
        permitted_pos=("NG",),
        rate_limit_per_minute=6,
    )
    base.update(over)
    return SourceRegistration(**base)


# ------------------------------------------------------------ the gate
def test_a_fully_reviewed_source_is_collectable():
    assert reg().is_collectable("NG") is True
    assert reg().blocking_reasons("NG") == []


def test_disabled_source_is_never_collected():
    assert "SOURCE_DISABLED" in reg(enabled=False).blocking_reasons("NG")


def test_terms_that_do_not_permit_collection_block_it():
    assert "TERMS_DO_NOT_PERMIT" in reg(terms_permit_collection=False).blocking_reasons("NG")


def test_robots_disallow_blocks_it():
    assert "ROBOTS_DISALLOWS" in reg(robots_allows_path=False).blocking_reasons("NG")


def test_a_legal_review_older_than_ninety_days_stops_collection_by_itself():
    """The control that works when everyone has forgotten about it."""
    stale = reg(legal_review_date=date.today() - timedelta(days=91))
    reasons = stale.blocking_reasons("NG")
    assert any(r.startswith("LEGAL_REVIEW_STALE") for r in reasons)
    assert stale.is_collectable("NG") is False


def test_a_missing_review_date_is_treated_as_stale_not_as_fine():
    assert reg(legal_review_date=None).is_collectable("NG") is False


def test_point_of_sale_outside_the_permitted_list_is_blocked():
    assert "POS_NOT_PERMITTED_GB" in reg().blocking_reasons("GB")
    assert reg().is_collectable("GB") is False


def test_blocking_reasons_are_cumulative():
    """An operator fixing one problem should see the others, not a new one."""
    bad = reg(enabled=False, terms_permit_collection=False, robots_allows_path=False,
              legal_review_date=None)
    assert len(bad.blocking_reasons("GB")) == 5


def test_yaml_entry_defaults_to_blocked():
    """An entry someone added without filling in the review fields collects nothing."""
    r = SourceRegistration.from_yaml("new_source", {"base_url": "https://x.test"})
    assert r.is_collectable("NG") is False


def test_collector_preflight_refuses_a_blocked_source():
    from fareiq.collectors.scraping import PublicFareCollector
    c = PublicFareCollector(
        collection_run_id="run1",
        registration=reg(terms_permit_collection=False),
        seller_id="competitor_x",
    )
    request = ShopRequest(origin="LOS", destination="LHR",
                          departure_date=date.today() + timedelta(days=30),
                          cabin="ECONOMY", pos_country="NG", currency="NGN")
    assert c.preflight(request) is False


def test_collector_preflight_allows_a_reviewed_source():
    from fareiq.collectors.scraping import PublicFareCollector
    c = PublicFareCollector(collection_run_id="run1", registration=reg(),
                            seller_id="competitor_x")
    request = ShopRequest(origin="LOS", destination="LHR",
                          departure_date=date.today() + timedelta(days=30),
                          cabin="ECONOMY", pos_country="NG", currency="NGN")
    assert c.preflight(request) is True


# ------------------------------------------------------------ parsing
@pytest.mark.parametrize("text,amount,ccy", [
    ("₦1,022,000", Decimal("1022000"), "NGN"),
    ("NGN 1,022,000", Decimal("1022000"), "NGN"),
    ("1,022,000 NGN", Decimal("1022000"), "NGN"),
    ("£612.40", Decimal("612.40"), "GBP"),
    ("$1,299", Decimal("1299"), "USD"),
    ("1 022 000", Decimal("1022000"), "NGN"),
])
def test_parse_money_handles_the_shapes_fare_pages_actually_use(text, amount, ccy):
    got = parse_money(text)
    assert got is not None
    assert got[0] == amount
    assert got[1] == ccy


def test_parse_money_returns_none_rather_than_guessing():
    assert parse_money("Price on request") is None
    assert parse_money("") is None


@pytest.mark.parametrize("text,minutes", [
    ("12h 35m", 755), ("12 h 35 m", 755), ("6h", 360), ("45m", 45),
])
def test_parse_duration(text, minutes):
    assert parse_duration_minutes(text) == minutes


def test_parse_duration_rejects_nonsense():
    assert parse_duration_minutes("overnight") is None
    assert parse_duration_minutes("") is None


@pytest.mark.parametrize("text,stops", [
    ("Non-stop", 0), ("nonstop", 0), ("Direct", 0), ("1 stop", 1), ("2 stops", 2),
])
def test_parse_stops(text, stops):
    assert parse_stops(text) == stops


def test_origin_of_strips_the_path():
    assert origin_of("https://example.test/flights/LOS-LHR?x=1") == "https://example.test"


def test_jsonld_extraction_finds_offers():
    html = """
    <html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Flight",
       "offers":{"@type":"Offer","price":"1022000","priceCurrency":"NGN"},
       "airline":{"@type":"Airline","iataCode":"VS"}}
    </script>
    </head><body>irrelevant</body></html>
    """
    offers = extract_jsonld_offers(html)
    assert len(offers) >= 1
    flight = [o for o in offers if o.get("@type") == "Flight"][0]
    assert flight["airline"]["iataCode"] == "VS"


def test_jsonld_extraction_survives_broken_json():
    """One malformed block must not lose the good one next to it."""
    html = """
    <script type="application/ld+json">{ this is not json </script>
    <script type="application/ld+json">
      {"@type":"Offer","price":"950000","priceCurrency":"NGN"}
    </script>
    """
    offers = extract_jsonld_offers(html)
    assert any(o.get("price") == "950000" for o in offers)


def test_no_structured_data_returns_empty_rather_than_raising():
    assert extract_jsonld_offers("<html><body>nothing here</body></html>") == []
