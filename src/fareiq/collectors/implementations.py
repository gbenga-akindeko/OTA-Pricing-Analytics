"""Concrete collectors, one per source tier.

These are working skeletons: the HTTP shape, auth, pagination, error mapping
and normalisation are real; the endpoint payloads are the parts you swap for
whatever your contracts actually give you. All four inherit the same
compliance, rate limiting and retry behaviour from BaseCollector.
"""
from __future__ import annotations

import base64
import os
from datetime import datetime, timedelta
from decimal import Decimal

import httpx

from fareiq.collectors.base import (
    BaseCollector, PermanentSourceError, TransientSourceError,
)
from fareiq.core.models import (
    Ancillary, FeeBasis, FeeType, LegalBasis, NormalisedOffer, Segment,
    SellerType, ShopRequest, SourceTier,
)

TIMEOUT = httpx.Timeout(20.0, connect=8.0)


def _raise_for_status(resp: httpx.Response, source_id: str) -> None:
    if resp.status_code in (429, 500, 502, 503, 504):
        raise TransientSourceError(f"{source_id} HTTP {resp.status_code}")
    if resp.status_code >= 400:
        raise PermanentSourceError(f"{source_id} HTTP {resp.status_code}: {resp.text[:400]}")


# ======================================================================
# TIER 1 :: OUR OWN INVENTORY
# The only source that gives us supplier cost as well as selling price.
# ======================================================================
class OwnBookingEngineCollector(BaseCollector):
    source_id = "own_pss"
    source_tier = SourceTier.OWN
    legal_basis = LegalBasis.OWN_SYSTEM
    seller_id = "us"
    rate_limit_per_minute = 600

    def __init__(self, collection_run_id: str, credentials: dict | None = None,
                 base_url: str | None = None):
        super().__init__(collection_run_id, credentials)
        self.base_url = base_url or os.environ["OWN_ENGINE_URL"]

    async def _shop(self, request: ShopRequest) -> list[dict]:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/v1/shop",
                headers={"Authorization": f"Bearer {self.credentials['api_key']}"},
                json={
                    "origin": request.origin, "destination": request.destination,
                    "departureDate": request.departure_date.isoformat(),
                    "returnDate": request.return_date.isoformat() if request.return_date else None,
                    "cabin": request.cabin, "adults": request.adults,
                    "children": request.children, "infants": request.infants,
                    "pointOfSale": request.pos_country, "currency": request.currency,
                    "includeNetFares": True,          # the whole reason this source matters
                },
            )
            _raise_for_status(resp, self.source_id)
            return resp.json().get("offers", [])

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        price = raw["price"]
        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id, source_tier=self.source_tier,
            collected_at=collected_at, legal_basis=self.legal_basis,
            request=request, seller_id=self.seller_id, seller_type=SellerType.US,
            offer_ref=raw.get("offerId"),
            quote_currency=price["currency"],
            displayed_total=Decimal(str(price["total"])),
            base_fare=Decimal(str(price.get("base", 0))),
            taxes_total=Decimal(str(price.get("taxes", 0))),
            marketing_carrier=raw.get("marketingCarrier"),
            operating_carrier=raw.get("operatingCarrier"),
            fare_basis_code=raw.get("fareBasis"),
            fare_family=raw.get("fareFamily"),
            booking_class=raw.get("bookingClass"),
            is_refundable=raw.get("refundable"),
            is_changeable=raw.get("changeable"),
            stops_count=max(len(raw.get("segments", [])) - 1, 0),
            total_duration_minutes=raw.get("durationMinutes"),
            included_checked_bags=raw.get("baggage", {}).get("checkedPieces"),
            segments=[_seg(s, i) for i, s in enumerate(raw.get("segments", []))],
            seats_remaining=raw.get("seatsRemaining"),
            raw_payload=raw,
        )


# ======================================================================
# TIER 2 :: GDS AND NDC
#
# These are the four channels TravelDen actually sells through. They are
# SUPPLY sources: each one tells us what a given flight costs through that
# channel. Read together they answer two commercially distinct questions:
#
#   1. Channel arbitrage. The same flight, priced four ways. Different
#      contracts, fare families and NDC-versus-EDIFACT content mean the
#      spread between channels on one flight is routinely worth more than
#      any markup decision we make on top of it.
#   2. Competitive position against the airline. A direct NDC price is what
#      the carrier sells to the customer itself, and for an OTA that is a
#      real competitor rather than a proxy for one.
#
# What they do NOT give us is what a competing OTA charges. See the note in
# config/sources.yaml before reading any "market median" as a market median.
# ======================================================================
class AmadeusCollector(BaseCollector):
    """Amadeus Self-Service Flight Offers Search.

    Broadest schedule and published-fare coverage of the four, and the one to
    integrate first because it is the easiest to get production access to.
    Its weakness is ancillaries: baggage is frequently absent from the
    response, so the fee catalogue has to fill the gap and fee_confidence
    drops accordingly.
    """
    source_id = "amadeus"
    source_tier = SourceTier.GDS_NDC
    legal_basis = LegalBasis.CONTRACT_API
    seller_id = "channel_amadeus"
    rate_limit_per_minute = 40

    BASE = "https://api.amadeus.com"
    TEST_BASE = "https://test.api.amadeus.com"   # self-service test keys only work here

    def __init__(self, collection_run_id: str, credentials: dict | None = None):
        super().__init__(collection_run_id, credentials)
        # Put "base_url": "https://test.api.amadeus.com" in the secret while on
        # test keys; drop it (or set the production host) at go-live.
        self.base = ((self.credentials or {}).get("base_url") or self.BASE).rstrip("/")
        self._token: str | None = None
        self._token_expiry: datetime | None = None

    async def _get_token(self, client: httpx.AsyncClient) -> str:
        now = datetime.utcnow()
        if self._token and self._token_expiry and now < self._token_expiry:
            return self._token
        resp = await client.post(
            f"{self.base}/v1/security/oauth2/token",
            data={"grant_type": "client_credentials",
                  "client_id": self.credentials["client_id"],
                  "client_secret": self.credentials["client_secret"]},
        )
        _raise_for_status(resp, self.source_id)
        payload = resp.json()
        self._token = payload["access_token"]
        self._token_expiry = now + timedelta(seconds=payload.get("expires_in", 1799) - 60)
        return self._token

    async def _shop(self, request: ShopRequest) -> list[dict]:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            token = await self._get_token(client)
            params = {
                "originLocationCode": request.origin,
                "destinationLocationCode": request.destination,
                "departureDate": request.departure_date.isoformat(),
                "adults": request.adults,
                "travelClass": request.cabin,
                "currencyCode": request.currency,
                "max": 50,
            }
            if request.children:
                params["children"] = request.children
            if request.return_date:
                params["returnDate"] = request.return_date.isoformat()
            resp = await client.get(f"{self.base}/v2/shopping/flight-offers",
                                    params=params,
                                    headers={"Authorization": f"Bearer {token}"})
            _raise_for_status(resp, self.source_id)
            return resp.json().get("data", [])

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        price = raw["price"]
        itin = raw["itineraries"][0]
        segs = itin["segments"]
        traveller = (raw.get("travelerPricings") or [{}])[0]
        fare_detail = (traveller.get("fareDetailsBySegment") or [{}])[0]
        bags = (fare_detail.get("includedCheckedBags") or {})
        warnings: list[str] = []
        if not bags:
            warnings.append("NO_BAGGAGE_IN_RESPONSE")

        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id, source_tier=self.source_tier,
            collected_at=collected_at, legal_basis=self.legal_basis,
            request=request, seller_id=self.seller_id,
            seller_type=SellerType.GDS_CHANNEL,
            offer_ref=raw.get("id"),
            quote_currency=price["currency"],
            displayed_total=Decimal(str(price["grandTotal"])),
            base_fare=Decimal(str(price.get("base", 0))),
            taxes_total=Decimal(str(price["grandTotal"])) - Decimal(str(price.get("base", 0))),
            marketing_carrier=segs[0]["carrierCode"],
            operating_carrier=(segs[0].get("operating") or {}).get("carrierCode"),
            fare_basis_code=fare_detail.get("fareBasis"),
            fare_family=fare_detail.get("brandedFare"),
            booking_class=fare_detail.get("class"),
            stops_count=len(segs) - 1,
            total_duration_minutes=_iso_duration_minutes(itin.get("duration")),
            included_checked_bags=bags.get("quantity"),
            segments=[
                Segment(
                    sequence=i,
                    marketing_carrier=s["carrierCode"],
                    operating_carrier=(s.get("operating") or {}).get("carrierCode"),
                    flight_number=s["number"],
                    origin=s["departure"]["iataCode"],
                    destination=s["arrival"]["iataCode"],
                    departure_local=datetime.fromisoformat(s["departure"]["at"]),
                    arrival_local=datetime.fromisoformat(s["arrival"]["at"]),
                    aircraft=(s.get("aircraft") or {}).get("code"),
                ) for i, s in enumerate(segs)
            ],
            seats_remaining=raw.get("numberOfBookableSeats"),
            raw_payload=raw,
            parse_warnings=warnings,
        )


class SabreCollector(BaseCollector):
    """Sabre Bargain Finder Max, REST v5.

    Worth running alongside Amadeus rather than instead of it. The two GDSs
    hold different negotiated fares, and on West African routes the gap
    between them on the same flight is regularly larger than our markup.
    That spread is the first thing the channel-arbitrage view surfaces.

    Auth is OAuth2 client credentials with a Basic header built from
    base64(client_id:client_secret).
    """
    source_id = "sabre"
    source_tier = SourceTier.GDS_NDC
    legal_basis = LegalBasis.CONTRACT_API
    seller_id = "channel_sabre"
    rate_limit_per_minute = 30

    BASE = "https://api.sabre.com"
    TOKEN_PATH = "/v2/auth/token"
    SHOP_PATH = "/v5/offers/shop"

    def __init__(self, collection_run_id: str, credentials: dict | None = None):
        super().__init__(collection_run_id, credentials)
        self._token: str | None = None
        self._token_expiry: datetime | None = None
        # Sabre lets you point at the certification host while testing.
        self.base = (self.credentials.get("base_url") or self.BASE).rstrip("/")
        self.pcc = self.credentials.get("pcc")

    async def _get_token(self, client: httpx.AsyncClient) -> str:
        now = datetime.utcnow()
        if self._token and self._token_expiry and now < self._token_expiry:
            return self._token
        basic = base64.b64encode(
            f"{self.credentials['client_id']}:{self.credentials['client_secret']}".encode()
        ).decode()
        resp = await client.post(
            f"{self.base}{self.TOKEN_PATH}",
            headers={"Authorization": f"Basic {basic}",
                     "Content-Type": "application/x-www-form-urlencoded"},
            data={"grant_type": "client_credentials"},
        )
        _raise_for_status(resp, self.source_id)
        payload = resp.json()
        self._token = payload["access_token"]
        self._token_expiry = now + timedelta(seconds=payload.get("expires_in", 604799) - 300)
        return self._token

    def _build_rq(self, request: ShopRequest) -> dict:
        legs = [{
            "RPH": "1",
            "DepartureDateTime": f"{request.departure_date.isoformat()}T00:00:00",
            "OriginLocation": {"LocationCode": request.origin},
            "DestinationLocation": {"LocationCode": request.destination},
        }]
        if request.return_date:
            legs.append({
                "RPH": "2",
                "DepartureDateTime": f"{request.return_date.isoformat()}T00:00:00",
                "OriginLocation": {"LocationCode": request.destination},
                "DestinationLocation": {"LocationCode": request.origin},
            })

        pax = [{"Code": "ADT", "Quantity": request.adults}]
        if request.children:
            pax.append({"Code": "CNN", "Quantity": request.children})
        if request.infants:
            pax.append({"Code": "INF", "Quantity": request.infants})

        return {
            "OTA_AirLowFareSearchRQ": {
                "Version": "5",
                "POS": {"Source": [{
                    "PseudoCityCode": self.pcc,
                    "RequestorID": {"Type": "1", "ID": "1",
                                    "CompanyName": {"Code": "TN"}},
                }]},
                "OriginDestinationInformation": legs,
                "TravelPreferences": {
                    "CabinPref": [{"Cabin": _sabre_cabin(request.cabin),
                                   "PreferLevel": "Preferred"}],
                    "TPA_Extensions": {
                        # Ask for branded fares: without them the ancillary
                        # picture is guesswork and fee_confidence collapses.
                        "NumTrips": {"Number": 50},
                        "SmartMarketOption": {"RequestType": {"Name": "MARKET_FARES"}},
                    },
                },
                "TravelerInfoSummary": {
                    "SeatsRequested": [request.paying_pax],
                    "AirTravelerAvail": [{"PassengerTypeQuantity": pax}],
                    "PriceRequestInformation": {"CurrencyCode": request.currency},
                },
                "TPA_Extensions": {
                    "IntelliSellTransaction": {
                        "RequestType": {"Name": "50ITINS"},
                    },
                },
            }
        }

    async def _shop(self, request: ShopRequest) -> list[dict]:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            token = await self._get_token(client)
            resp = await client.post(
                f"{self.base}{self.SHOP_PATH}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json"},
                json=self._build_rq(request),
            )
            _raise_for_status(resp, self.source_id)
            body = resp.json()
            rs = body.get("groupedItineraryResponse") or {}
            itineraries = rs.get("itineraryGroups") or []
            out: list[dict] = []
            # Sabre normalises schedules, legs and fares into separate
            # reference lists to keep the payload small. Carry them along so
            # the parser can resolve the references.
            refs = {
                "legDescs": rs.get("legDescs", []),
                "scheduleDescs": rs.get("scheduleDescs", []),
                "baggageAllowanceDescs": rs.get("baggageAllowanceDescs", []),
            }
            for group in itineraries:
                for itin in group.get("itineraries", []):
                    out.append({"_itinerary": itin, "_refs": refs})
            return out

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        itin = raw["_itinerary"]
        refs = raw["_refs"]
        pricing = (itin.get("pricingInformation") or [{}])[0]
        fare = pricing.get("fare") or {}
        totals = fare.get("totalFare") or {}
        pax_info = (fare.get("passengerInfoList") or [{}])[0].get("passengerInfo") or {}

        warnings: list[str] = []
        total = totals.get("totalPrice")
        if total is None:
            raise PermanentSourceError("Sabre itinerary carried no totalPrice")

        legs = itin.get("legs") or []
        schedule_ids: list[int] = []
        for leg in legs:
            desc = next((d for d in refs["legDescs"] if d.get("id") == leg.get("ref")), None)
            if desc:
                schedule_ids += [s.get("ref") for s in desc.get("schedules", [])]

        segments: list[Segment] = []
        for i, sid in enumerate(schedule_ids):
            sched = next((s for s in refs["scheduleDescs"] if s.get("id") == sid), None)
            if not sched:
                continue
            dep, arr = sched.get("departure", {}), sched.get("arrival", {})
            carrier = (sched.get("carrier") or {})
            try:
                segments.append(Segment(
                    sequence=i,
                    marketing_carrier=carrier.get("marketing", ""),
                    operating_carrier=carrier.get("operating"),
                    flight_number=str(carrier.get("marketingFlightNumber", "")),
                    origin=dep.get("airport", ""),
                    destination=arr.get("airport", ""),
                    departure_local=datetime.fromisoformat(
                        f"{dep.get('date')}T{dep.get('time', '00:00:00')}"),
                    arrival_local=datetime.fromisoformat(
                        f"{arr.get('date')}T{arr.get('time', '00:00:00')}"),
                    aircraft=(sched.get("equipment") or {}).get("code"),
                ))
            except (ValueError, TypeError):
                warnings.append("SEGMENT_TIME_UNPARSED")

        bag_qty = None
        bag_ref = pax_info.get("baggageInformation")
        if isinstance(bag_ref, list) and bag_ref:
            allowance_ref = (bag_ref[0].get("allowance") or {}).get("ref")
            allowance = next((b for b in refs["baggageAllowanceDescs"]
                              if b.get("id") == allowance_ref), None)
            if allowance:
                bag_qty = allowance.get("pieceCount")
        if bag_qty is None:
            warnings.append("NO_BAGGAGE_IN_RESPONSE")

        first = segments[0] if segments else None
        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id, source_tier=self.source_tier,
            collected_at=collected_at, legal_basis=self.legal_basis,
            request=request, seller_id=self.seller_id,
            seller_type=SellerType.GDS_CHANNEL,
            offer_ref=str(itin.get("id", "")),
            quote_currency=totals.get("currency", request.currency),
            displayed_total=Decimal(str(total)),
            base_fare=Decimal(str((fare.get("totalFare") or {}).get("equivalentAmount", 0)) or 0) or None,
            taxes_total=Decimal(str(totals.get("totalTaxAmount", 0))) or None,
            marketing_carrier=first.marketing_carrier if first else None,
            operating_carrier=first.operating_carrier if first else None,
            fare_basis_code=(pax_info.get("fareComponents") or [{}])[0].get("fareBasisCode"),
            fare_family=(pax_info.get("fareComponents") or [{}])[0].get("brandFeatures"),
            stops_count=max(len(segments) - 1, 0),
            included_checked_bags=bag_qty,
            segments=segments,
            raw_payload=itin,
            parse_warnings=warnings,
        )


class VerteilNdcCollector(BaseCollector):
    """Verteil, as an NDC aggregator.

    Verteil fronts many carriers' NDC connections behind one contract, which
    is why it is worth having: NDC responses carry branded fares and priced
    ancillaries in the same message, and that is the single biggest accuracy
    win available for true customer cost.

    The message bodies below follow the IATA NDC AirShopping schema, which is
    what an aggregator serves. The endpoint path, the API version header and
    the exact auth header differ per aggregator and per onboarding, so all
    three are read from the secret rather than hard-coded. Fill them in from
    the Verteil onboarding pack; no code change is needed.
    """
    source_id = "verteil"
    source_tier = SourceTier.GDS_NDC
    legal_basis = LegalBasis.CONTRACT_API
    seller_id = "channel_verteil"
    rate_limit_per_minute = 30

    def __init__(self, collection_run_id: str, credentials: dict | None = None):
        super().__init__(collection_run_id, credentials)
        c = self.credentials
        self.base = (c.get("base_url") or "").rstrip("/")
        if not self.base:
            raise PermanentSourceError(
                "verteil secret needs base_url. Take it from the Verteil "
                "onboarding pack and add it to the secret JSON.")
        self.shop_path = c.get("shop_path", "/entrygate/rest/request:airShopping")
        self.ndc_version = c.get("ndc_version", "17.2")
        self.third_party_id = c.get("third_party_id")   # the carrier or 'ALL'

    def _headers(self) -> dict:
        c = self.credentials
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "service": "AirShopping",
        }
        # Aggregators differ here: some want a bearer token, some a pair of
        # username/password headers, some an API key. Support all three and
        # send whichever the secret provides.
        if c.get("access_token"):
            headers["Authorization"] = f"Bearer {c['access_token']}"
        if c.get("api_key"):
            headers["apikey"] = c["api_key"]
        if c.get("username"):
            headers["username"] = c["username"]
        if c.get("password"):
            headers["password"] = c["password"]
        if self.third_party_id:
            headers["ThirdpartyId"] = self.third_party_id
        return headers

    def _build_rq(self, request: ShopRequest) -> dict:
        travellers = [{"PTC": {"value": "ADT"}}] * request.adults
        travellers += [{"PTC": {"value": "CHD"}}] * request.children
        travellers += [{"PTC": {"value": "INF"}}] * request.infants

        flights = [{
            "Departure": {"AirportCode": {"value": request.origin},
                          "Date": request.departure_date.isoformat()},
            "Arrival": {"AirportCode": {"value": request.destination}},
        }]
        if request.return_date:
            flights.append({
                "Departure": {"AirportCode": {"value": request.destination},
                              "Date": request.return_date.isoformat()},
                "Arrival": {"AirportCode": {"value": request.origin}},
            })

        return {
            "Party": {"Sender": {"CorporateSender": {
                "CorporateCode": self.credentials.get("corporate_code", "TVD")}}},
            "Travelers": {"Traveler": [{"AnonymousTraveler": [t]} for t in travellers]},
            "CoreQuery": {"OriginDestinations": {
                "OriginDestination": [{"Departure": f["Departure"],
                                       "Arrival": f["Arrival"]} for f in flights]}},
            "Preference": {
                "CabinPreferences": {"CabinType": [
                    {"Code": _ndc_cabin_code(request.cabin)}]},
                "FarePreferences": {"Types": {"Type": [{"Code": "PUBL"}]}},
            },
            "EnableGDS": True,
        }

    async def _shop(self, request: ShopRequest) -> list[dict]:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(f"{self.base}{self.shop_path}",
                                     headers=self._headers(),
                                     json=self._build_rq(request))
            _raise_for_status(resp, self.source_id)
            body = resp.json()

            # NDC nests priced offers under OffersGroup > AirlineOffers >
            # AirlineOffer. Aggregators sometimes flatten one level, so accept
            # either shape rather than failing on a structural difference.
            offers: list[dict] = []
            group = body.get("OffersGroup") or body.get("offersGroup") or {}
            airline_offers = group.get("AirlineOffers") or group.get("airlineOffers") or []
            if isinstance(airline_offers, dict):
                airline_offers = [airline_offers]
            for block in airline_offers:
                items = block.get("AirlineOffer") or block.get("airlineOffer") or []
                if isinstance(items, dict):
                    items = [items]
                for o in items:
                    offers.append({"_offer": o, "_datalists": body.get("DataLists", {})})
            if not offers and body.get("Errors"):
                raise PermanentSourceError(f"verteil: {str(body['Errors'])[:300]}")
            return offers

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        offer = raw["_offer"]
        lists = raw.get("_datalists") or {}
        warnings: list[str] = []

        price_node = (offer.get("TotalPrice") or {}).get("DetailCurrencyPrice") or {}
        total_node = price_node.get("Total") or {}
        amount = total_node.get("value")
        currency = total_node.get("Code") or request.currency
        if amount is None:
            raise PermanentSourceError("NDC offer carried no TotalPrice")

        taxes = ((price_node.get("Taxes") or {}).get("Total") or {}).get("value")
        base = ((price_node.get("Base") or {}) or {}).get("value")

        carrier = ((offer.get("OfferID") or {}).get("Owner")
                   or offer.get("Owner")
                   or (offer.get("owner") or {}))
        if isinstance(carrier, dict):
            carrier = carrier.get("value")

        # Branded fare name and baggage come from the offer items.
        items = offer.get("PricedOffer", {}).get("OfferPrice") or []
        if isinstance(items, dict):
            items = [items]
        fare_family = None
        bags = None
        ancillaries: list[Ancillary] = []
        for item in items:
            detail = item.get("FareDetail") or {}
            for comp in (detail.get("FareComponent") or []):
                fare_family = fare_family or (comp.get("FareBasis") or {}).get(
                    "FareBasisCity1") or (comp.get("FareBasis") or {}).get("Code")
            assoc = item.get("RequestedDate", {}).get("Associations") or []
            for a in assoc if isinstance(assoc, list) else [assoc]:
                bag_ref = ((a.get("ApplicableFlight") or {})
                           .get("FlightSegmentReference") or [])
                for seg_ref in bag_ref if isinstance(bag_ref, list) else [bag_ref]:
                    bdc = (seg_ref.get("BagDetailAssociation") or {})
                    refs = bdc.get("CheckedBagReferences") or []
                    for r in refs if isinstance(refs, list) else [refs]:
                        allowance = _ndc_lookup(lists, "CheckedBagAllowanceList",
                                                "CheckedBagAllowance", r)
                        if allowance:
                            pieces = ((allowance.get("PieceAllowance") or [{}])[0]
                                      .get("TotalQuantity"))
                            if pieces is not None:
                                bags = int(pieces)
        if bags is None:
            warnings.append("NO_BAGGAGE_IN_RESPONSE")

        segments = _ndc_segments(lists, offer)
        if not segments:
            warnings.append("NO_SEGMENTS_RESOLVED")

        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id, source_tier=self.source_tier,
            collected_at=collected_at, legal_basis=self.legal_basis,
            request=request, seller_id=self.seller_id,
            seller_type=SellerType.NDC_CHANNEL,
            offer_ref=str((offer.get("OfferID") or {}).get("value", "")),
            quote_currency=currency,
            displayed_total=Decimal(str(amount)),
            base_fare=Decimal(str(base)) if base is not None else None,
            taxes_total=Decimal(str(taxes)) if taxes is not None else None,
            marketing_carrier=carrier,
            fare_family=fare_family,
            stops_count=max(len(segments) - 1, 0),
            included_checked_bags=bags,
            quoted_ancillaries=ancillaries,
            segments=segments,
            raw_payload=offer,
            parse_warnings=warnings,
        )


class AirlineNdcDirectCollector(VerteilNdcCollector):
    """A carrier's own NDC endpoint, connected directly rather than through an
    aggregator.

    Same IATA message shape, so it reuses the Verteil parser. It earns its own
    source id for two reasons: the trust score and the commercial meaning
    differ. A direct NDC price is what the airline sells to the customer, so
    for an OTA it is the single most honest competitor benchmark available
    from a supply feed.

    Configure one secret per carrier, keyed by IATA code in the secret JSON.
    """
    source_id = "ndc_direct"
    seller_id = "airline_direct"

    def __init__(self, collection_run_id: str, credentials: dict | None = None,
                 carrier: str | None = None):
        self.carrier = carrier or (credentials or {}).get("default_carrier")
        super().__init__(collection_run_id, credentials)

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        offer = super()._parse(raw, request, collected_at)
        # Direct NDC is the airline selling to the customer, so it is tagged
        # as a competitor rather than as one of our own channels.
        offer.seller_type = SellerType.AIRLINE_DIRECT
        offer.seller_id = f"airline_{offer.marketing_carrier or self.carrier or 'unknown'}"
        return offer


# ======================================================================
# TIER 3 :: LICENSED AGGREGATOR
# Competitor OTA prices under a data licence. Not yet contracted; see
# config/sources.yaml for why this tier is the only one that answers
# "what is a competing OTA charging".
# ======================================================================
class LicensedMarketFeedCollector(BaseCollector):
    source_id = "licensed_market_feed"
    source_tier = SourceTier.LICENSED_AGGREGATOR
    legal_basis = LegalBasis.LICENSED_FEED
    seller_id = "multi"                      # resolved per offer from the payload
    rate_limit_per_minute = 120

    def __init__(self, collection_run_id: str, credentials: dict | None = None,
                 base_url: str | None = None):
        super().__init__(collection_run_id, credentials)
        self.base_url = base_url or os.environ.get("MARKET_FEED_URL", "")

    async def _shop(self, request: ShopRequest) -> list[dict]:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{self.base_url}/v1/market-prices",
                headers={"X-API-Key": self.credentials["api_key"]},
                params={
                    "origin": request.origin, "destination": request.destination,
                    "date": request.departure_date.isoformat(),
                    "cabin": request.cabin, "pos": request.pos_country,
                    "currency": request.currency, "include_fees": "true",
                },
            )
            _raise_for_status(resp, self.source_id)
            return resp.json().get("results", [])

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        anc = [
            Ancillary(type=FeeType[a["type"]], amount=Decimal(str(a["amount"])),
                      currency=a.get("currency", raw["currency"]),
                      basis=FeeBasis[a.get("basis", "PER_PAX_PER_ITINERARY")])
            for a in raw.get("fees", []) if a.get("type") in FeeType.__members__
        ]
        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id, source_tier=self.source_tier,
            collected_at=collected_at, legal_basis=self.legal_basis,
            request=request,
            seller_id=raw["seller"],                       # e.g. competitor_a
            seller_type=SellerType[raw.get("seller_type", "COMPETITOR_OTA")],
            quote_currency=raw["currency"],
            displayed_total=Decimal(str(raw["total_price"])),
            base_fare=Decimal(str(raw.get("base_fare", 0))) or None,
            taxes_total=Decimal(str(raw.get("taxes", 0))) or None,
            marketing_carrier=raw.get("carrier"),
            fare_family=raw.get("fare_family"),
            is_refundable=raw.get("refundable"),
            stops_count=raw.get("stops"),
            total_duration_minutes=raw.get("duration_minutes"),
            included_checked_bags=raw.get("included_checked_bags"),
            quoted_ancillaries=anc,
            availability_status=raw.get("availability", "AVAILABLE"),
            raw_payload=raw,
        )


# ======================================================================
# TIER 4 :: PERMITTED PUBLIC
# Only ever runs where a documented review says the source permits it.
# The preflight is not decoration: it is the control that keeps this legal.
# ======================================================================
class PermittedPublicCollector(BaseCollector):
    source_id = "permitted_public"
    source_tier = SourceTier.PERMITTED_PUBLIC
    legal_basis = LegalBasis.PERMITTED_PUBLIC
    seller_id = "public"
    rate_limit_per_minute = 6                # deliberately slow

    def __init__(self, collection_run_id: str, credentials: dict | None = None,
                 allowlist: dict | None = None):
        super().__init__(collection_run_id, credentials)
        # allowlist is loaded from config/sources.yaml and is reviewed by legal
        # on a fixed cadence. Absence from the allowlist means no collection.
        self.allowlist = allowlist or {}

    def preflight(self, request: ShopRequest) -> bool:
        entry = self.allowlist.get(self.source_id)
        if not entry:
            return False
        if not entry.get("terms_permit_collection"):
            return False
        if not entry.get("robots_allows_path"):
            return False
        review_age_days = entry.get("days_since_legal_review", 999)
        if review_age_days > 90:
            return False
        if request.pos_country not in entry.get("permitted_pos", []):
            return False
        return True

    async def _shop(self, request: ShopRequest) -> list[dict]:
        raise NotImplementedError(
            "Implement only against a source whose terms and robots.txt have "
            "been reviewed and recorded in config/sources.yaml, at the rate the "
            "source publishes, identifying the client honestly."
        )

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        raise NotImplementedError


# ----------------------------------------------------------------------
def _seg(s: dict, i: int) -> Segment:
    return Segment(
        sequence=i,
        marketing_carrier=s.get("marketingCarrier", ""),
        operating_carrier=s.get("operatingCarrier"),
        flight_number=s.get("flightNumber", ""),
        origin=s["origin"], destination=s["destination"],
        departure_local=datetime.fromisoformat(s["departure"]),
        arrival_local=datetime.fromisoformat(s["arrival"]),
        aircraft=s.get("aircraft"), booking_class=s.get("bookingClass"),
        cabin=s.get("cabin"),
    )


def _sabre_cabin(cabin: str) -> str:
    return {"ECONOMY": "Y", "PREMIUM_ECONOMY": "S",
            "BUSINESS": "C", "FIRST": "F"}.get(cabin, "Y")


def _ndc_cabin_code(cabin: str) -> str:
    """IATA cabin type codes used in NDC CabinPreferences."""
    return {"ECONOMY": "3", "PREMIUM_ECONOMY": "5",
            "BUSINESS": "2", "FIRST": "1"}.get(cabin, "3")


def _ndc_lookup(datalists: dict, list_name: str, item_name: str, ref) -> dict | None:
    """Resolve one reference into an NDC DataLists entry.

    NDC moves every repeated structure into DataLists and refers to it by key,
    so almost nothing useful is inline on the offer itself. Aggregators differ
    on casing and on whether a single entry is wrapped in a list, so this is
    written to tolerate both rather than to assume one vendor's shape.
    """
    if ref is None:
        return None
    key = ref.get("value") if isinstance(ref, dict) else ref
    block = datalists.get(list_name) or datalists.get(list_name[0].lower() + list_name[1:])
    if not block:
        return None
    items = block.get(item_name) or block.get(item_name[0].lower() + item_name[1:]) or []
    if isinstance(items, dict):
        items = [items]
    for item in items:
        if item.get(f"{item_name}ID") == key or item.get("refs") == key or item.get("ListKey") == key:
            return item
    return None


def _ndc_segments(datalists: dict, offer: dict) -> list[Segment]:
    """Resolve an NDC offer's flight segments out of DataLists."""
    segments: list[Segment] = []
    seg_list = (datalists.get("FlightSegmentList")
                or datalists.get("flightSegmentList") or {})
    entries = seg_list.get("FlightSegment") or seg_list.get("flightSegment") or []
    if isinstance(entries, dict):
        entries = [entries]

    for i, seg in enumerate(entries):
        dep, arr = seg.get("Departure") or {}, seg.get("Arrival") or {}
        marketing = (seg.get("MarketingCarrier") or {})
        operating = (seg.get("OperatingCarrier") or {})
        try:
            departure = datetime.fromisoformat(
                f"{dep.get('Date')}T{(dep.get('Time') or '00:00')[:5]}:00")
            arrival = datetime.fromisoformat(
                f"{arr.get('Date')}T{(arr.get('Time') or '00:00')[:5]}:00")
        except (ValueError, TypeError):
            continue
        segments.append(Segment(
            sequence=i,
            marketing_carrier=(marketing.get("AirlineID") or {}).get("value", ""),
            operating_carrier=(operating.get("AirlineID") or {}).get("value"),
            flight_number=str((marketing.get("FlightNumber") or {}).get("value", "")),
            origin=(dep.get("AirportCode") or {}).get("value", ""),
            destination=(arr.get("AirportCode") or {}).get("value", ""),
            departure_local=departure,
            arrival_local=arrival,
            aircraft=((seg.get("Equipment") or {}).get("AircraftCode") or {}).get("value"),
        ))
    return segments


def _iso_duration_minutes(duration: str | None) -> int | None:
    """PT12H35M -> 755."""
    if not duration or not duration.startswith("PT"):
        return None
    body, hours, minutes = duration[2:], 0, 0
    if "H" in body:
        h, body = body.split("H", 1)
        hours = int(h)
    if "M" in body:
        minutes = int(body.split("M", 1)[0])
    return hours * 60 + minutes


COLLECTOR_REGISTRY = {
    c.source_id: c for c in (
        OwnBookingEngineCollector,
        AmadeusCollector, SabreCollector, VerteilNdcCollector,
        AirlineNdcDirectCollector,
        LicensedMarketFeedCollector,
        PermittedPublicCollector,
    )
}

# The four channels TravelDen actually sells through. This is the default set
# a collection sweep uses when the caller does not name sources explicitly.
PRODUCTION_SOURCES = ["own_pss", "amadeus", "sabre", "verteil", "ndc_direct"]

# The synthetic source is registered only when it is explicitly enabled, so it
# cannot be selected by accident in production. See collectors/mock.py.
if os.environ.get("FAREIQ_ALLOW_MOCK") == "1":            # pragma: no cover
    from fareiq.collectors.mock import MockMarketCollector
    COLLECTOR_REGISTRY[MockMarketCollector.source_id] = MockMarketCollector
