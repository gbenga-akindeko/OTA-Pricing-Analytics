# Dashboard specification :: Apps Script web app

The BI layer is an Apps Script HTML Service web app, not Looker Studio. Six
pages, one deployment, one URL, served from the same Workspace tenancy the
pricing team already signs into.

Source lives in `appsscript/webapp/`. The Looker Studio specification has been
retired; if the team ever wants a Looker layer it can be added later over the
same views, but nothing in the platform depends on one.

## Why Apps Script rather than Looker Studio

| | Apps Script web app | Looker Studio |
|---|---|---|
| Approve, modify, reject in place | yes, and it is the point | no, read only |
| Access control | Workspace groups, resolved per request, three roles | report-level sharing only |
| Query cost control | `maximumBytesBilled` and a shared cache on every query | per-viewer refresh, harder to bound |
| Freshness honesty | a banner that says when data is stale and stops pretending | a quiet timestamp |
| Custom logic | the margin floor is enforced in the UI and again in the service | none |
| Cost | included in Workspace | included, but BI Engine is not |

The deciding factor is the first row. The daily review is a workflow, not a
report, and putting the decision two clicks from the evidence is the whole
reason the platform gets used at all.

## Architecture

```
Browser
  |  google.script.run
Apps Script  (executes as the FareIQ service identity)
  |  WebApp.gs        routing, Workspace-group authorisation, approvals
  |  DataService.gs   BigQuery reads, parameter binding, chunked cache
  |  Config.gs        script properties, palette, page/role map
  |
  +--> BigQuery mart views           (read only, never fact_offer)
  +--> Cloud Run pricing service     (the only writer to the audit trail)
```

Three properties that matter:

1. **The app has no BigQuery write grant at all.** Every approval posts to the
   pricing service with the signed-in user's identity attached, and the
   service appends to `fact_price_decision`. The dashboard is an interface;
   the service is the system of record.
2. **It executes as a service identity, not as the viewer.** That is what lets
   analysts read the mart without each of them holding a warehouse role.
   Authorisation is then done per request against Workspace groups, so removing
   somebody from a group takes effect on their next page load.
3. **Every query is parameter-bound and byte-capped.** The only strings
   concatenated into SQL are the project id and identifiers checked against a
   regex. A runaway query fails rather than bills.

## Roles

| Role | Group | Sees |
|---|---|---|
| `lead` | `pricing-leads@` | everything, including approvals |
| `analyst` | `pricing-analysts@` | everything, including approvals |
| `exec` | `commercial-exec@` | overview, competitors, routes, opportunities and audit. No fee matrix, no daily review, no approval controls |

Most specific role wins. Membership is cached per user for ten minutes.
A user in no group gets a plain "no access" page naming who to ask.

## Caching

Collection is hourly, so a fifteen minute cache costs nothing in freshness and
takes most page loads to zero BigQuery queries. The working review page uses
two minutes; the fee matrix and the scorecard use an hour.

`CacheService` caps one entry at 100 KB, which a 500 row table exceeds, so
`cachedQuery_` splits large payloads across numbered chunks under an index key
and reassembles them. A cache miss or a corrupt entry is never fatal: the code
falls through and queries.

Approving anything invalidates the review and opportunity caches immediately,
so a decision never appears to have been ignored.

## The six pages

### 1. Overview
Eight stat tiles, then two charts and a table. The tiles carry the numbers an
executive actually asks for: routes, airlines, competitors, average price
index, cells where we are cheapest, P1 actions, margin upside and panel
coverage.

The price index chart is the one chart that should be readable in three
seconds, with a dashed reference line at 1.00. Coverage sits beside it on its
own chart rather than as a second axis, because a coverage number hidden
inside a price chart is a coverage number nobody looks at.

### 2. Daily review
The working page. Filters for date, priority, classification, action, status
and minimum confidence, then a sticky-header table sorted by priority and then
by absolute expected margin impact.

Per row: approve, modify or reject. Modify opens a dialog that pre-fills the
recommended price and states the policy floor. A reason is mandatory on modify
and reject, enforced in the browser, again in `WebApp.gs`, and once more in
the pricing service. Multi-select plus a bulk approve handles the routine
half of a morning in one action, reporting per-row outcomes rather than one
optimistic success message.

Below the table, the engine's own rationale for the top rows in plain English.
An analyst should never have to ask why a recommendation exists.

### 3. Competitors
Cheapest-win-rate over time per seller, median price by seller, the ranking
table, major movements, and the anomalies the mining job flagged. A competitor
whose win rate is climbing has changed strategy, and that is worth knowing
before it shows up in conversion.

### 4. Airline fees
Ancillary load by carrier, the fee change chart, the full carrier-by-fee-type
matrix built to be printed, and the change log. Analyst and lead only: fee
tables can carry contractual content.

### 5. Routes
One route at a time. Price against the market, demand, price index against the
band, and margin. Price and volume are **two charts sharing a date axis, never
one chart with two scales**: a dual axis invites a causal reading the data does
not support.

The elasticity card always shows its source (`ROUTE`, `BLENDED`,
`REGION_PRIOR`) and the weeks behind it. An estimate built from a regional
prior must not look as authoritative as one built from two years of history.

### 6. Opportunities and audit
Where the money is today, and how well the engine's forecasts have held up.
The audit half is what earns the platform its trust: who decided what, on what
benchmark, with what reason, and what actually happened at T+7.

Acceptance rate and override magnitude are on this page on purpose.
Consistently large overrides mean the rules are wrong, not that the analyst is
wrong, and the page is built to surface that rather than to defend the engine.

## Chart rules

The palette was validated with a colourblindness and contrast checker rather
than chosen by eye. Two colour systems are kept apart:

- **Chrome** uses the TravelDen lockup colours: navy `#002A48`, green
  `#00A651`, orange `#F58220`.
- **Series** uses a separate validated categorical ramp, assigned in this fixed
  order and never cycled: `#15618F`, `#F58220`, `#0F7A4C`, `#2E9BD4`,
  `#9C2B22`. Worst adjacent pair separation is ΔE 13.5 under protanopia and
  21.1 under normal vision, both comfortably above the floor.

Rules held throughout:

- One y-axis per chart, always. Two measures of different scale get two charts.
- Colour follows the entity, assigned once, so filtering a competitor out never
  repaints the survivors.
- A legend whenever there are two or more series.
- Status colours are reserved and always ship with a text label. Every
  classification is a chip that says `UNCOMPETITIVE`, not a coloured square.
- Every chart is backed by a table on the same page. That is also the relief
  for the one palette slot that sits under 3:1 contrast on white.
- A chart that fails to draw degrades to a line of text pointing at the table,
  never to an empty box.

Single theme, deliberately. The brand lives on white and the app is used in a
lit office at 07:00; a dark variant would be a second surface to validate for
nobody who asked.

## Deployment

```bash
cd appsscript/webapp
clasp create --type webapp --title "TVD OTA FareIQ"
clasp push
clasp deploy --description "v1"
```

Then, once:

1. In the Apps Script editor, run `setupScriptProperties()` after editing the
   real values into it, or set them in project settings.
2. Enable the BigQuery advanced service (already declared in
   `appsscript.json`).
3. Deploy as **Execute as: Me**, **Who has access: Anyone within the domain**.
4. Grant the service identity `roles/bigquery.dataViewer` on
   `tvd_fareiq_mart` and `roles/run.invoker` on the pricing service. Grant it
   nothing else. `deploy/iam.sh` does this.
5. Circulate the URL. There is no per-user setup.

## What stays in Google Sheets

The pricing rules, the route register and the competitor panel. The Sheet is
the editing surface for configuration, versioned into BigQuery on every sync,
and it remains a fallback approval path if the web app is ever unavailable.
The 07:00 Gmail digest is unchanged and now links to the dashboard.
