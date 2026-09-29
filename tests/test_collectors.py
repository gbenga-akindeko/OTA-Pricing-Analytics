"""Parser tests for the four production channels.

These run against captured response shapes rather than live APIs, so they
catch the thing that actually breaks in production: a vendor changing where a
field lives. No network, no credentials.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from fareiq.collectors.implementations import (
    COLLECTOR_REGISTRY, PRODUCTION_SOURCES, AmadeusCollector,
    AirlineNdcDirectCollector, SabreCollector, VerteilNdcCollector,
    _ndc_cabin_code, _ndc_segments, _sabre_cabin,
)
from fareiq.core.models import SellerType, ShopRequest

NOW = datetime(2026, 9, 27, 6, 0, 0)


def req() -> ShopRequest:
    return ShopRequest(origin="LOS", destination="LHR",
                       departure_date=date(2026, 10, 27),
                       cabin="ECONOMY", pos_country="NG", currency="NGN")


# ------------------------------------------------------------ the registry
def test_the_four_production_channels_are_registered():
    for sid in ("amadeus", "sabre", "verteil", "ndc_direct"):
        assert sid in COLLECTOR_REGISTRY, f"{sid} missing from the registry"


def test_production_sources_is_what_a_sweep_defaults_to():
    assert PRODUCTION_SOURCES == ["own_pss", "amadeus", "sabre", "verteil", "ndc_direct"]


def test_supply_channels_are_not_typed_as_competitors():
    """The distinction the whole market median depends on."""
    assert AmadeusCollector.seller_id == "channel_amadeus"
    assert SabreCollector.seller_id == "channel_sabre"
    assert VerteilNdcCollector.seller_id == "channel_verteil"
    # Direct NDC is the airline selling to the customer, so it IS a competitor.
    assert AirlineNdcDirectCollector.seller_id == "airline_direct"


# ------------------------------------------------------------ Amadeus
AMADEUS_OFFER = {
    "id": "1",
    "price": {"currency": "NGN", "grandTotal": "1022000.00", "base": "735000.00"},
    "numberOfBookableSeats": 7,
    "itineraries": [{
        "duration": "PT6H35M",
        "segments": [{
            "carrierCode": "VS", "number": "412",
            "departure": {"iataCode": "LOS", "at": "2026-10-27T23:15:00"},
            "arrival": {"iataCode": "LHR", "at": "2026-10-28T05:50:00"},
            "aircraft": {"code": "351"},
            "operating": {"carrierCode": "VS"},
        }],
    }],
    "travelerPricings": [{
        "fareDetailsBySegment": [{
            "fareBasis": "OLWNGB", "brandedFare": "ECONOMY_CLASSIC",
            "class": "O", "includedCheckedBags": {"quantity": 1},
        }],
    }],
}


def test_amadeus_parses_a_priced_offer():
    c = AmadeusCollector(collection_run_id="r1",
                         credentials={"client_id": "x", "client_secret": "y"})
    o = c._parse(AMADEUS_OFFER, req(), NOW)
    assert float(o.displayed_total) == 1_022_000
    assert float(o.taxes_total) == 287_000
    assert o.marketing_carrier == "VS"
    assert o.fare_family == "ECONOMY_CLASSIC"
    assert o.included_checked_bags == 1
    assert o.stops_count == 0
    assert o.total_duration_minutes == 395
    assert o.seller_type is SellerType.GDS_CHANNEL
    assert o.parse_warnings == []


def test_amadeus_flags_a_missing_baggage_allowance():
    offer = {**AMADEUS_OFFER,
             "travelerPricings": [{"fareDetailsBySegment": [{"fareBasis": "X"}]}]}
    c = AmadeusCollector(collection_run_id="r1",
                         credentials={"client_id": "x", "client_secret": "y"})
    o = c._parse(offer, req(), NOW)
    assert "NO_BAGGAGE_IN_RESPONSE" in o.parse_warnings
    assert o.included_checked_bags is None


# ------------------------------------------------------------ Sabre
SABRE_REFS = {
    "legDescs": [{"id": 11, "schedules": [{"ref": 21}]}],
    "scheduleDescs": [{
        "id": 21,
        "departure": {"airport": "LOS", "date": "2026-10-27", "time": "23:15:00"},
        "arrival": {"airport": "LHR", "date": "2026-10-28", "time": "05:50:00"},
        "carrier": {"marketing": "VS", "operating": "VS", "marketingFlightNumber": 412},
        "equipment": {"code": "351"},
    }],
    "baggageAllowanceDescs": [{"id": 31, "pieceCount": 2}],
}
SABRE_ITINERARY = {
    "id": 1,
    "legs": [{"ref": 11}],
    "pricingInformation": [{
        "fare": {
            "totalFare": {"totalPrice": 985000.0, "currency": "NGN",
                          "totalTaxAmount": 265000.0, "equivalentAmount": 720000.0},
            "passengerInfoList": [{"passengerInfo": {
                "baggageInformation": [{"allowance": {"ref": 31}}],
                "fareComponents": [{"fareBasisCode": "OLWSAB",
                                    "brandFeatures": "ECONOMY_FLEX"}],
            }}],
        },
    }],
}


def _sabre() -> SabreCollector:
    return SabreCollector(collection_run_id="r1",
                          credentials={"client_id": "x", "client_secret": "y", "pcc": "ABCD"})


def test_sabre_resolves_its_reference_lists():
    o = _sabre()._parse({"_itinerary": SABRE_ITINERARY, "_refs": SABRE_REFS}, req(), NOW)
    assert float(o.displayed_total) == 985_000
    assert float(o.taxes_total) == 265_000
    assert o.marketing_carrier == "VS"
    assert o.included_checked_bags == 2
    assert o.fare_basis_code == "OLWSAB"
    assert o.seller_type is SellerType.GDS_CHANNEL
    assert len(o.segments) == 1
    assert o.segments[0].origin == "LOS"
    assert o.segments[0].destination == "LHR"


def test_sabre_refuses_an_itinerary_with_no_price():
    from fareiq.collectors.base import PermanentSourceError
    broken = {"id": 2, "legs": [], "pricingInformation": [{"fare": {"totalFare": {}}}]}
    with pytest.raises(PermanentSourceError, match="totalPrice"):
        _sabre()._parse({"_itinerary": broken, "_refs": SABRE_REFS}, req(), NOW)


def test_sabre_request_carries_the_pcc_and_the_cabin():
    rq = _sabre()._build_rq(req())["OTA_AirLowFareSearchRQ"]
    assert rq["POS"]["Source"][0]["PseudoCityCode"] == "ABCD"
    assert rq["TravelPreferences"]["CabinPref"][0]["Cabin"] == "Y"
    assert len(rq["OriginDestinationInformation"]) == 1


def test_sabre_return_trip_adds_a_second_leg():
    r = ShopRequest(origin="LOS", destination="LHR",
                    departure_date=date(2026, 10, 27),
                    return_date=date(2026, 11, 10),
                    trip_type="ROUND_TRIP",
                    cabin="BUSINESS", pos_country="NG", currency="NGN")
    rq = _sabre()._build_rq(r)["OTA_AirLowFareSearchRQ"]
    assert len(rq["OriginDestinationInformation"]) == 2
    assert rq["OriginDestinationInformation"][1]["OriginLocation"]["LocationCode"] == "LHR"
    assert rq["TravelPreferences"]["CabinPref"][0]["Cabin"] == "C"


@pytest.mark.parametrize("cabin,code", [
    ("ECONOMY", "Y"), ("PREMIUM_ECONOMY", "S"), ("BUSINESS", "C"), ("FIRST", "F"),
])
def test_sabre_cabin_mapping(cabin, code):
    assert _sabre_cabin(cabin) == code


# ------------------------------------------------------------ NDC / Verteil
NDC_DATALISTS = {
    "FlightSegmentList": {"FlightSegment": [{
        "SegmentKey": "SEG1",
        "Departure": {"AirportCode": {"value": "LOS"}, "Date": "2026-10-27", "Time": "23:15"},
        "Arrival": {"AirportCode": {"value": "LHR"}, "Date": "2026-10-28", "Time": "05:50"},
        "MarketingCarrier": {"AirlineID": {"value": "VS"}, "FlightNumber": {"value": "412"}},
        "OperatingCarrier": {"AirlineID": {"value": "VS"}},
        "Equipment": {"AircraftCode": {"value": "351"}},
    }]},
    "CheckedBagAllowanceList": {"CheckedBagAllowance": [{
        "CheckedBagAllowanceID": "BAG1",
        "PieceAllowance": [{"TotalQuantity": 2}],
    }]},
}
NDC_OFFER = {
    "OfferID": {"value": "OFFER-1", "Owner": "VS"},
    "TotalPrice": {"DetailCurrencyPrice": {
        "Total": {"value": 1008500, "Code": "NGN"},
        "Base": {"value": 726000},
        "Taxes": {"Total": {"value": 282500}},
    }},
    "PricedOffer": {"OfferPrice": [{
        "FareDetail": {"FareComponent": [{"FareBasis": {"Code": "OLWNDC"}}]},
        "RequestedDate": {"Associations": [{
            "ApplicableFlight": {"FlightSegmentReference": [{
                "ref": "SEG1",
                "BagDetailAssociation": {"CheckedBagReferences": ["BAG1"]},
            }]},
        }]},
    }]},
}


def _verteil() -> VerteilNdcCollector:
    return VerteilNdcCollector(collection_run_id="r1", credentials={
        "base_url": "https://api.example.test", "username": "u", "password": "p"})


def test_verteil_requires_a_base_url_from_the_secret():
    from fareiq.collectors.base import PermanentSourceError
    with pytest.raises(PermanentSourceError, match="base_url"):
        VerteilNdcCollector(collection_run_id="r1", credentials={"username": "u"})


def test_verteil_parses_an_ndc_offer():
    o = _verteil()._parse({"_offer": NDC_OFFER, "_datalists": NDC_DATALISTS}, req(), NOW)
    assert float(o.displayed_total) == 1_008_500
    assert float(o.base_fare) == 726_000
    assert float(o.taxes_total) == 282_500
    assert o.marketing_carrier == "VS"
    assert o.included_checked_bags == 2
    assert o.seller_type is SellerType.NDC_CHANNEL
    assert o.offer_ref == "OFFER-1"


def test_ndc_segments_resolve_out_of_datalists():
    segs = _ndc_segments(NDC_DATALISTS, NDC_OFFER)
    assert len(segs) == 1
    assert segs[0].marketing_carrier == "VS"
    assert segs[0].flight_number == "412"
    assert segs[0].origin == "LOS"
    assert segs[0].departure_local.hour == 23


def test_ndc_parser_tolerates_lowercase_keys():
    """Aggregators differ on casing. Failing on that would be a bad reason to
    lose a whole channel."""
    lower = {"flightSegmentList": NDC_DATALISTS["FlightSegmentList"]}
    assert len(_ndc_segments(lower, NDC_OFFER)) == 1


def test_missing_baggage_is_flagged_not_guessed():
    offer = {**NDC_OFFER, "PricedOffer": {"OfferPrice": [{"FareDetail": {}}]}}
    o = _verteil()._parse({"_offer": offer, "_datalists": NDC_DATALISTS}, req(), NOW)
    assert "NO_BAGGAGE_IN_RESPONSE" in o.parse_warnings
    assert o.included_checked_bags is None


def test_an_offer_with_no_total_price_is_rejected():
    from fareiq.collectors.base import PermanentSourceError
    with pytest.raises(PermanentSourceError, match="TotalPrice"):
        _verteil()._parse({"_offer": {"OfferID": {"value": "x"}}, "_datalists": {}},
                          req(), NOW)


def test_direct_ndc_is_reclassified_as_a_competitor():
    """Same message shape as Verteil, different commercial meaning."""
    c = AirlineNdcDirectCollector(collection_run_id="r1", credentials={
        "base_url": "https://vs.example.test", "default_carrier": "VS"})
    o = c._parse({"_offer": NDC_OFFER, "_datalists": NDC_DATALISTS}, req(), NOW)
    assert o.seller_type is SellerType.AIRLINE_DIRECT
    assert o.seller_id == "airline_VS"


@pytest.mark.parametrize("cabin,code", [
    ("ECONOMY", "3"), ("PREMIUM_ECONOMY", "5"), ("BUSINESS", "2"), ("FIRST", "1"),
])
def test_ndc_cabin_codes(cabin, code):
    assert _ndc_cabin_code(cabin) == code


def test_verteil_request_shape():
    rq = _verteil()._build_rq(req())
    assert rq["CoreQuery"]["OriginDestinations"]["OriginDestination"][0][
        "Departure"]["AirportCode"]["value"] == "LOS"
    assert rq["Preference"]["CabinPreferences"]["CabinType"][0]["Code"] == "3"
    assert len(rq["Travelers"]["Traveler"]) == 1
