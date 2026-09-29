"""Tests for the synthetic market source.

The mock exists so the platform can be proven before a single supplier
contract is signed. These tests check it produces data the rest of the
pipeline can genuinely work with, and that it cannot be switched on by
accident.
"""
from __future__ import annotations

import asyncio
import os
from datetime import date, timedelta

import pytest

from fareiq.collectors.base import PermanentSourceError
from fareiq.core.models import SellerType, ShopRequest


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("FAREIQ_ALLOW_MOCK", "1")
    yield


def req(days_out: int = 30, route=("LOS", "LHR"), cabin="ECONOMY") -> ShopRequest:
    return ShopRequest(
        origin=route[0], destination=route[1],
        departure_date=date.today() + timedelta(days=days_out),
        cabin=cabin, pos_country="NG", currency="NGN",
    )


def collect(collector, request):
    return asyncio.run(collector.collect(request))


# ------------------------------------------------------------ the safety gate
def test_mock_refuses_to_run_unless_explicitly_enabled(monkeypatch):
    monkeypatch.delenv("FAREIQ_ALLOW_MOCK", raising=False)
    from fareiq.collectors.mock import MockMarketCollector
    with pytest.raises(PermanentSourceError, match="FAREIQ_ALLOW_MOCK"):
        MockMarketCollector(collection_run_id="r1")


def test_mock_is_absent_from_the_registry_when_disabled(monkeypatch):
    """A production deployment must not be able to select it at all."""
    monkeypatch.delenv("FAREIQ_ALLOW_MOCK", raising=False)
    import importlib
    from fareiq.collectors import implementations
    importlib.reload(implementations)
    assert "mock_market" not in implementations.COLLECTOR_REGISTRY


def test_every_offer_is_tagged_as_synthetic(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    assert result.offers
    for o in result.offers:
        assert "SYNTHETIC_DATA_DO_NOT_PRICE_AGAINST" in o.parse_warnings


def test_competitor_seller_ids_are_prefixed_so_they_can_be_deleted(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    competitors = [o.seller_id for o in result.offers if o.seller_id != "us"]
    assert competitors
    assert all(s.startswith("mock_") for s in competitors)


# ------------------------------------------------------ usable market shape
def test_it_produces_a_panel_wide_enough_for_the_engine_to_act(enabled):
    """The engine needs at least three competitors before it will price."""
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    sellers = {o.seller_id for o in result.offers if o.seller_id != "us"}
    assert len(sellers) >= 3


def test_our_own_offer_is_present_and_carries_a_supplier_cost(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    ours = [o for o in result.offers if o.seller_type is SellerType.US]
    assert ours
    assert all(o.raw_payload["supplier_cost"] is not None for o in ours)
    assert all(o.raw_payload["supplier_cost"] < float(o.displayed_total) for o in ours)


def test_sellers_differ_on_fees_not_just_on_headline(enabled):
    """The whole true-cost argument needs sellers with different fee shapes."""
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    with_bag_fee = {o.seller_id for o in result.offers
                    if any(a.type.value == "BAG_1ST" for a in o.quoted_ancillaries)}
    without = {o.seller_id for o in result.offers} - with_bag_fee
    assert with_bag_fee and without


def test_prices_rise_as_departure_approaches(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    c = MockMarketCollector(collection_run_id="r1")
    far = collect(c, req(days_out=90)).offers
    near = collect(c, req(days_out=2)).offers
    avg = lambda os_: sum(float(o.displayed_total) for o in os_) / len(os_)  # noqa: E731
    assert avg(near) > avg(far) * 1.4


def test_business_cabin_costs_more_than_economy(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    c = MockMarketCollector(collection_run_id="r1")
    eco = collect(c, req(cabin="ECONOMY")).offers
    biz = collect(c, req(cabin="BUSINESS")).offers
    avg = lambda os_: sum(float(o.displayed_total) for o in os_) / len(os_)  # noqa: E731
    assert avg(biz) > avg(eco) * 2


def test_output_is_deterministic(enabled):
    """Same inputs, same prices, so a verification run can be repeated."""
    from fareiq.collectors.mock import MockMarketCollector
    a = collect(MockMarketCollector(collection_run_id="r1"), req())
    b = collect(MockMarketCollector(collection_run_id="r2"), req())
    pa = sorted((o.seller_id, o.marketing_carrier, float(o.displayed_total)) for o in a.offers)
    pb = sorted((o.seller_id, o.marketing_carrier, float(o.displayed_total)) for o in b.offers)
    assert pa == pb


def test_different_routes_get_different_prices(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    c = MockMarketCollector(collection_run_id="r1")
    lhr = collect(c, req(route=("LOS", "LHR"))).offers
    abv = collect(c, req(route=("LOS", "ABV"))).offers
    avg = lambda os_: sum(float(o.displayed_total) for o in os_) / len(os_)  # noqa: E731
    assert avg(lhr) > avg(abv) * 3          # long haul against domestic


def test_offers_serialise_to_the_bigquery_row_shape(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    row = result.offers[0].to_bq_row()
    for field in ("snapshot_id", "collection_run_id", "source_id", "collected_at",
                  "request_origin", "request_destination", "displayed_total",
                  "seller_id", "legal_basis"):
        assert field in row and row[field] is not None
    assert isinstance(row["segments"], list)
    assert isinstance(row["quoted_ancillaries"], list)


def test_collection_reports_no_errors(enabled):
    from fareiq.collectors.mock import MockMarketCollector
    result = collect(MockMarketCollector(collection_run_id="r1"), req())
    assert result.errors == []
    assert result.calls_made == 1
