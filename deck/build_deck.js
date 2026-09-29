/**
 * TVD OTA FareIQ :: presentation deck
 *
 * Brand colours sampled directly from the TravelDen lockup.
 * Typography follows the TravelDen report standard: Garamond throughout,
 * title 50pt, slide headers 27pt, KPI values 28pt, agenda titles 18pt,
 * body 12pt, footer 9pt, closing 52pt.
 */
const pptx = require("pptxgenjs");
const p = new pptx();

p.layout = "LAYOUT_16x9";              // 10" x 5.625"
p.author = "Gbenga Akindeko";
p.company = "TravelDen | Finchglow Holdings";
p.title = "TVD OTA FareIQ";

// ---------------------------------------------------------------- brand
const NAVY   = "002A48";   // wordmark navy
const GREEN  = "00A651";   // mane green
const DGREEN = "00502A";   // deep mane green
const ORANGE = "F58220";   // "den" orange
const SKY    = "8ED8F8";
const RUST   = "A42B20";
const INK    = "17262F";
const MUTE   = "5E7079";
const RULE   = "DCE5E1";
const TINT   = "F2F7F4";   // green-biased card
const TINT2  = "EEF3F7";   // navy-biased card
const W      = "FFFFFF";

const F = "Garamond";
const M = 0.55;                 // left margin
const CW = 10 - M * 2;          // content width 8.9

const LOGO_L = "assets/tvd_logo_light.png";
const LOGO_D = "assets/tvd_logo_dark.png";

// ---------------------------------------------------------------- helpers
function logo(s, dark, x, y, w) {
  s.addImage({ path: dark ? LOGO_D : LOGO_L, x: x, y: y, w: w, h: w / 3.383 });
}

/** Standard light content slide with a 27pt header. */
function content(title, kicker) {
  const s = p.addSlide();
  s.background = { color: W };
  if (kicker) {
    s.addText(kicker.toUpperCase(), {
      x: M, y: 0.30, w: CW, h: 0.22, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: GREEN, bold: true, charSpacing: 2.2,
    });
  }
  s.addText(title, {
    x: M, y: kicker ? 0.50 : 0.38, w: CW, h: 0.62, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 27, bold: true, color: NAVY, valign: "top",
  });
  logo(s, false, 8.62, 5.13, 0.82);
  return s;
}

function footer(s, text) {
  s.addText(text, {
    x: M, y: 5.20, w: 7.6, h: 0.25, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 9, color: MUTE, valign: "middle",
  });
}

/** Dark slide used for the title, the three section breaks and the close. */
function dark() {
  const s = p.addSlide();
  s.background = { color: NAVY };
  return s;
}

function sectionBreak(num, title, blurb) {
  const s = dark();
  s.addShape(p.ShapeType.ellipse, {
    x: M, y: 1.72, w: 0.62, h: 0.62, fill: { color: ORANGE },
  });
  s.addText(num, {
    x: M, y: 1.72, w: 0.62, h: 0.62, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 22, bold: true, color: W, align: "center", valign: "middle",
  });
  s.addText(title, {
    x: M, y: 2.52, w: 7.8, h: 0.75, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 40, bold: true, color: W,
  });
  s.addText(blurb, {
    x: M, y: 3.34, w: 7.0, h: 0.7, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: SKY,
  });
  logo(s, true, 8.55, 4.92, 0.90);
  return s;
}

/** Soft tinted card. No edge stripes anywhere in this deck. */
function card(s, x, y, w, h, fill) {
  s.addShape(p.ShapeType.roundRect, {
    x: x, y: y, w: w, h: h, rectRadius: 0.06,
    fill: { color: fill || TINT }, line: { color: RULE, width: 0.75 },
  });
}

/** Green token used as the deck's repeating motif. */
function token(s, x, y, label, d, fill) {
  const dia = d || 0.34;
  s.addShape(p.ShapeType.ellipse, { x: x, y: y, w: dia, h: dia, fill: { color: fill || GREEN } });
  s.addText(label, {
    x: x, y: y, w: dia, h: dia, isTextBox: true, margin: 0,
    fontFace: F, fontSize: dia > 0.4 ? 14 : 11, bold: true, color: W,
    align: "center", valign: "middle",
  });
}

const money = (n) => "₦" + n.toLocaleString("en-NG");

// ================================================================ 1 TITLE
{
  const s = dark();
  logo(s, true, M, 0.55, 1.55);
  s.addText("Competitive pricing intelligence  ·  Platform design", {
    x: M, y: 1.42, w: 8.4, h: 0.26, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: SKY, bold: true, charSpacing: 2,
  });
  s.addText("TVD OTA FareIQ", {
    x: M, y: 1.80, w: 8.6, h: 1.0, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 50, bold: true, color: W,
  });
  s.addText(
    "Knowing what the market charges, what a trip really costs our customer, and what we should price today.",
    { x: M, y: 2.92, w: 7.4, h: 0.7, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: "C9DCE8" });

  const facts = [
    ["150", "routes monitored"],
    ["4", "data source tiers"],
    ["07:00", "daily review lands"],
    ["100%", "changes human approved"],
  ];
  facts.forEach((f, i) => {
    const x = M + i * 2.24;
    s.addText(f[0], {
      x: x, y: 3.86, w: 2.0, h: 0.46, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 28, bold: true, color: ORANGE,
    });
    s.addText(f[1], {
      x: x, y: 4.32, w: 2.0, h: 0.28, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 10.5, color: "9FBACB",
    });
  });

  s.addText("Prepared by Gbenga Akindeko  ·  Data & Process Optimisation  ·  TravelDen, Finchglow Holdings", {
    x: M, y: 4.95, w: 8.9, h: 0.25, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 9, color: "7E9AAC",
  });
  s.addNotes("Opening frame. The deck argues for one thing: a decision support platform that tells us what to price every morning, with a human approving every change.");
}

// ================================================================ 2 AGENDA
{
  const s = content("What we will cover", "Agenda");
  const items = [
    ["01", "The morning question", "What the platform exists to answer, and why today's process cannot."],
    ["02", "Architecture and data", "Seven stages, four source tiers, one warehouse."],
    ["03", "Pricing methodology", "True customer cost, and the test a price cut must pass."],
    ["04", "Delivery", "The Apps Script dashboards, the daily cadence, the roadmap and the risks."],
  ];
  items.forEach((it, i) => {
    const y = 1.32 + i * 0.92;
    token(s, M, y + 0.04, it[0], 0.42, i === 0 ? ORANGE : GREEN);
    s.addText(it[1], {
      x: M + 0.62, y: y, w: 7.9, h: 0.32, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 18, bold: true, color: NAVY,
    });
    s.addText(it[2], {
      x: M + 0.62, y: y + 0.34, w: 7.9, h: 0.28, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: MUTE,
    });
  });
  s.addNotes("Four movements. The middle one is where the commercial argument actually lives.");
}

// ================================================================ 3 THE QUESTION
{
  const s = dark();
  s.addText("THE QUESTION IT ANSWERS EVERY MORNING", {
    x: M, y: 1.15, w: 8.9, h: 0.26, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11, bold: true, color: ORANGE, charSpacing: 2.2,
  });
  s.addText(
    "What is the market charging today, where are we positioned, what price should we offer, why, and what revenue or margin impact should we expect?",
    { x: M, y: 1.62, w: 8.5, h: 2.0, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 27, bold: true, color: W, lineSpacing: 34 });
  s.addText("Today that answer takes an analyst a morning of manual checking, covers a handful of routes, and leaves no record of why a price moved.", {
    x: M, y: 4.02, w: 7.6, h: 0.6, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: SKY, italic: true,
  });
  logo(s, true, 8.55, 4.92, 0.90);
  s.addNotes("Read the question aloud. Everything after this slide is in service of answering it by 07:00 every day.");
}

// ================================================================ 4 WHY NOW
{
  const s = content("Why this is worth building now", "The problem");
  const tiles = [
    ["Manual and partial", "Pricing checks cover the routes someone remembers to check, on the day they remember to check them."],
    ["Headline comparison", "We compare advertised fares. Customers pay fares plus bags, seats and payment fees."],
    ["No margin view", "A price is judged against a competitor, not against what the booking actually earns us."],
    ["No record", "When a price moved, nobody can reconstruct what the market looked like at the time."],
  ];
  tiles.forEach((t, i) => {
    const x = M + (i % 2) * 4.55;
    const y = 1.42 + Math.floor(i / 2) * 1.72;
    card(s, x, y, 4.35, 1.48, i % 2 === 0 ? TINT : TINT2);
    token(s, x + 0.22, y + 0.24, String(i + 1), 0.30, i < 2 ? ORANGE : GREEN);
    s.addText(t[0], {
      x: x + 0.62, y: y + 0.20, w: 3.5, h: 0.30, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, bold: true, color: NAVY,
    });
    s.addText(t[1], {
      x: x + 0.22, y: y + 0.60, w: 3.95, h: 0.78, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: INK,
    });
  });
  footer(s, "Each of these four is a solved problem in the design that follows.");
  s.addNotes("Frame the pain before the solution. The fourth point, the missing record, is the one auditors and the board care about most.");
}

// ================================================================ 5 WHAT IT ANSWERS
{
  const s = content("Seven questions, answered before 07:00", "Scope");
  const qs = [
    "Are we cheaper or more expensive than our competitors?",
    "Which routes are overpriced, and which are underpriced?",
    "Which competitor is genuinely the cheapest?",
    "What does the trip really cost after taxes, baggage and fees?",
    "What price should we offer today, and why that price?",
    "Where can we raise margin without losing the sale?",
    "Which changes need attention this morning, ranked by value?",
  ];
  qs.forEach((q, i) => {
    const y = 1.30 + i * 0.53;
    token(s, M + 0.02, y + 0.02, String(i + 1), 0.28, i === 6 ? ORANGE : GREEN);
    s.addText(q, {
      x: M + 0.48, y: y, w: 8.1, h: 0.34, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13.5, color: INK, valign: "middle",
    });
  });
  footer(s, "Not new questions. The existing ones, answered daily and with the evidence attached.");
  s.addNotes("These are the seven the commercial team already asks. The platform does not invent new questions, it answers the existing ones daily and consistently.");
}

// ================================================================ 6 SECTION 1
sectionBreak("01", "Architecture and data",
  "Seven stages, four source tiers, one warehouse of record. Every stage replayable from the one before it.");

// ================================================================ 7 ARCHITECTURE
{
  const s = content("How a fare becomes a recommendation", "System architecture");
  const stages = [
    ["Sources", "GDS, NDC, licensed feeds, our own PSS"],
    ["Python", "Cloud Run collector, rate limited per source"],
    ["Storage", "Cloud Storage, the replay log"],
    ["BigQuery", "Raw, staging, mart. Source of truth"],
    ["Pricing engine", "True cost, market position, floors"],
    ["Ranking", "Impact, confidence, priority"],
    ["People", "Apps Script dashboard, Sheets, Gmail"],
  ];
  const bw = 1.18, gap = 0.10;
  stages.forEach((st, i) => {
    const x = M + i * (bw + gap);
    const hot = i === 3;
    s.addShape(p.ShapeType.roundRect, {
      x: x, y: 1.50, w: bw, h: 1.62, rectRadius: 0.07,
      fill: { color: hot ? NAVY : TINT }, line: { color: hot ? NAVY : RULE, width: 0.75 },
    });
    s.addText(String(i + 1).padStart(2, "0"), {
      x: x, y: 1.60, w: bw, h: 0.22, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 9.5, bold: true, color: hot ? SKY : GREEN, align: "center",
    });
    s.addText(st[0], {
      x: x + 0.06, y: 1.84, w: bw - 0.12, h: 0.44, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12.5, bold: true, color: hot ? W : NAVY, align: "center",
    });
    s.addText(st[1], {
      x: x + 0.07, y: 2.28, w: bw - 0.14, h: 0.78, isTextBox: true, margin: 0, valign: "top",
      fontFace: F, fontSize: 9.5, color: hot ? "C9DCE8" : MUTE, align: "center",
    });
    if (i < stages.length - 1) {
      s.addText("›", {
        x: x + bw, y: 2.10, w: gap, h: 0.3, isTextBox: true, margin: 0,
        fontFace: F, fontSize: 14, bold: true, color: ORANGE, align: "center",
      });
    }
  });

  card(s, M, 3.38, CW, 1.28, TINT2);
  s.addText("Why we land every response to Cloud Storage before BigQuery", {
    x: M + 0.24, y: 3.52, w: 8.4, h: 0.28, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, bold: true, color: NAVY,
  });
  s.addText([
    { text: "A load job is free where streaming inserts are not.", options: { bullet: true, breakLine: true } },
    { text: "A failed load leaves the file intact for a rerun, rather than a hole in the day.", options: { bullet: true, breakLine: true } },
    { text: "When a parser bug is found in March, January's data can be reprocessed rather than written off.", options: { bullet: true } },
  ], { x: M + 0.28, y: 3.84, w: 8.3, h: 0.75, isTextBox: true, margin: 0,
       fontFace: F, fontSize: 11.5, color: INK, paraSpaceAfter: 3 });
  s.addNotes("The middle box is the point: BigQuery is the analytical source of truth and everything else is either feeding it or reading it.");
}

// ================================================================ 8 STACK
{
  const s = content("Built on what we already run", "Technology stack");
  const groups = [
    ["Collect and process", GREEN, ["Python 3.11, async collectors", "Cloud Run, one service per job", "Cloud Scheduler, Africa/Lagos times", "Cloud Storage for raw JSONL"]],
    ["Store and analyse", NAVY, ["BigQuery: raw, staging, mart, ML", "Partitioned and clustered by route", "BigQuery ML for demand and elasticity", "pandas and scikit-learn for mining"]],
    ["Operate and control", ORANGE, ["Apps Script web app: six dashboards", "Google Sheets for pricing rules", "Gmail for the 07:00 digest", "Secret Manager, IAM, GitHub Actions"]],
  ];
  groups.forEach((g, i) => {
    const x = M + i * 3.02;
    card(s, x, 1.42, 2.86, 3.10, i === 1 ? TINT2 : TINT);
    s.addShape(p.ShapeType.ellipse, { x: x + 0.22, y: 1.64, w: 0.26, h: 0.26, fill: { color: g[1] } });
    s.addText(g[0], {
      x: x + 0.58, y: 1.60, w: 2.2, h: 0.34, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: NAVY, valign: "middle",
    });
    s.addText(g[2].map((t, j) => ({
      text: t, options: { bullet: true, breakLine: j < g[2].length - 1 },
    })), { x: x + 0.24, y: 2.04, w: 2.44, h: 2.30, isTextBox: true, margin: 0,
           fontFace: F, fontSize: 11.5, color: INK, paraSpaceAfter: 7 });
  });
  footer(s, "Nothing here is new to the business. The platform is assembled from tools we already licence and already administer.");
  s.addNotes("Deliberately Google-first, because the approval workflow has to live where the pricing team already works.");
}

// ================================================================ 9 SOURCES
{
  const s = content("Four tiers, in strict preference order", "Data sources");
  const tiers = [
    ["Our own PSS", "1.00", GREEN, "The only source giving supplier cost beside selling price. Every margin figure starts here."],
    ["GDS and NDC", "0.95", NAVY, "Amadeus for breadth, NDC for branded fares and ancillary prices in the same response."],
    ["Licensed feed", "0.85", ORANGE, "Competitor prices under contract. The tier that legitimately answers what the market charges."],
    ["Permitted public", "0.60", RUST, "Off by default. Reviewed terms only, six calls a minute, never the sole basis for a change."],
  ];
  tiers.forEach((t, i) => {
    const y = 1.42 + i * 0.92;
    card(s, M, y, CW, 0.84, i % 2 ? TINT2 : TINT);
    s.addText(t[0], {
      x: M + 0.24, y: y + 0.10, w: 1.9, h: 0.30, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: NAVY,
    });
    s.addText("Tier " + (i + 1), {
      x: M + 0.24, y: y + 0.42, w: 1.9, h: 0.24, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 10, color: MUTE, charSpacing: 1,
    });
    s.addText(t[3], {
      x: M + 2.20, y: y + 0.10, w: 4.75, h: 0.64, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: INK, valign: "middle",
    });
    s.addText(t[1], {
      x: 7.62, y: y + 0.10, w: 1.28, h: 0.42, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 28, bold: true, color: t[2], align: "right",
    });
    s.addText("trust", {
      x: 7.62, y: y + 0.52, w: 1.28, h: 0.20, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 9, color: MUTE, align: "right",
    });
  });
  footer(s, "Trust score is not decoration: it follows the data into the confidence attached to every recommendation.");
  s.addNotes("Tier 3 costs money and is worth it. The alternatives are guessing or scraping, and only one of those survives a commercial dispute.");
}

// ================================================================ 9b MINING
{
  const s = content("Reading the history, not just collecting it", "Collection and mining");

  const left = [
    ["Scraping, where it is permitted", ORANGE,
     ["A source is fetched only if the register lists it and its terms have been reviewed.",
      "A review older than ninety days stops collection by itself.",
      "robots.txt obeyed per path; its crawl delay beats our own rate limit.",
      "No CAPTCHA solving, no logins, no IP rotation. A 403 ends it."]],
    ["What the nightly job finds", GREEN,
     ["Prices far from their own cell's norm, separating a mistake fare from an outlier.",
      "Competitors measured on position, so a market-wide move flags nobody.",
      "A sustained reprice, told apart from a one-day blip.",
      "A seller we usually see and did not see today."]],
  ];
  left.forEach((g, i) => {
    const x = M + i * 4.55;
    card(s, x, 1.40, 4.35, 2.60, i ? TINT : TINT2);
    s.addShape(p.ShapeType.ellipse, { x: x + 0.24, y: 1.62, w: 0.24, h: 0.24, fill: { color: g[1] } });
    s.addText(g[0], {
      x: x + 0.58, y: 1.58, w: 3.6, h: 0.32, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: NAVY, valign: "middle",
    });
    s.addText(g[2].map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < g[2].length - 1 } })), {
      x: x + 0.26, y: 2.00, w: 3.88, h: 1.88, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: INK, paraSpaceAfter: 5,
    });
  });

  card(s, M, 4.16, CW, 0.80, TINT);
  s.addText("Two patterns worth money: the departure day of the week the market charges more for, and the days-to-departure band where it steps up. Our markup is flat across both today, so each one is margin on one side and share on the other.", {
    x: M + 0.24, y: 4.28, w: 8.45, h: 0.58, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  footer(s, "A mining signal is never a price change. It is a reason for a human to look, and an input that lowers the engine's confidence.");
  s.addNotes("Coverage falling silently is the most dangerous failure in the platform: every statistic keeps computing and simply becomes wrong. That is why a missing seller is its own signal.");
}

// ================================================================ 10 COMPLIANCE
{
  const s = content("Compliance built in as a control", "Governance");
  card(s, M, 1.46, 4.30, 1.62, TINT);
  s.addText("The source register is executable", {
    x: M + 0.24, y: 1.62, w: 3.9, h: 0.30, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  s.addText("The public-source collector reads the register at runtime and refuses to run against anything without a current legal review. A review older than ninety days stops collection automatically, with nobody needing to remember.", {
    x: M + 0.24, y: 1.98, w: 3.85, h: 1.04, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });

  card(s, M + 4.60, 1.46, 4.30, 1.62, TINT2);
  s.addText("Every row carries its legal basis", {
    x: M + 4.84, y: 1.62, w: 3.9, h: 0.30, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  s.addText("Contract, licence, own system or permitted public is recorded on each observation. Any figure on any dashboard traces back to the right under which we obtained it, which is what lets us share a report at all.", {
    x: M + 4.84, y: 1.98, w: 3.85, h: 1.04, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });

  s.addText("Standing rules, enforced in code rather than in a policy document", {
    x: M, y: 3.20, w: 8.9, h: 0.30, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  const rules = [
    "robots.txt is parsed and obeyed per path; its crawl delay overrides our own rate limit when slower.",
    "The user agent identifies us honestly with a contact address. Conditional requests never re-fetch an unchanged page.",
    "No CAPTCHA solving, no logins, no session replay, no IP rotation. A 401 or 403 ends collection rather than starting a workaround.",
    "Never let a public source alone justify a price change.",
  ];
  s.addText(rules.map((r, i) => ({ text: r, options: { bullet: true, breakLine: i < rules.length - 1 } })), {
    x: M + 0.04, y: 3.66, w: 8.6, h: 1.34, isTextBox: true, margin: 0, valign: "top",
    fontFace: F, fontSize: 10.5, color: INK, paraSpaceAfter: 4,
  });
  s.addNotes("If Legal asks one question in this meeting, it will be this slide. The controls are in code, not in a policy document nobody reads.");
}

// ================================================================ 11 DATA MODEL
{
  const s = content("One row means exactly one thing", "Data model");
  const rows = [
    ["fact_offer", "One priced offer, per seller, per hour", "Adds true customer cost and FX at the observation date"],
    ["fact_market_snapshot", "Route x date x cabin x hour", "Market statistics. What dashboards and the engine both read"],
    ["fact_price_recommendation", "One recommendation", "Every recommendation ever made, acted on or not"],
    ["fact_price_decision", "One human decision", "Append only. Who priced what, when, on what evidence"],
    ["fact_booking", "One ticketed booking", "One agreed margin definition, used everywhere"],
    ["dim_airline_fee", "One fee version", "Type 2. The fee history is the product, not a side effect"],
  ];
  s.addTable(
    [[
      { text: "TABLE", options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 10, charSpacing: 1.4 } },
      { text: "GRAIN: ONE ROW PER", options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 10, charSpacing: 1.4 } },
      { text: "WHY IT EXISTS", options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 10, charSpacing: 1.4 } },
    ]].concat(rows.map((r, i) => [
      { text: r[0], options: { bold: true, color: NAVY, fontSize: 10 } },
      { text: r[1], options: { color: INK, fontSize: 11 } },
      { text: r[2], options: { color: MUTE, fontSize: 11 } },
    ])),
    { x: M, y: 1.52, w: CW, colW: [2.55, 2.30, 4.05], fontFace: F,
      border: { type: "solid", color: RULE, pt: 0.5 },
      fill: { color: W }, rowH: 0.36, valign: "middle",
      margin: [4, 8, 4, 8] }
  );
  footer(s, "Get the grain wrong and every number downstream is quietly wrong. It is stated on every table in the design.");
  s.addNotes("Five facts, six dimensions. The decision table is the one that makes the platform auditable.");
}

// ================================================================ 12 SECTION 2
sectionBreak("02", "Pricing methodology",
  "Two ideas do most of the work. One stops us comparing the wrong numbers. One stops us cutting price for the wrong reason.");

// ================================================================ 13 TRUE COST
{
  const s = content("Cheaper on screen is not cheaper", "Idea one · True customer cost");

  s.addChart(p.ChartType.bar, [
    { name: "Headline fare", labels: ["Competitor A", "TVD OTA"], values: [950000, 1000000] },
    { name: "First checked bag", labels: ["Competitor A", "TVD OTA"], values: [60000, 0] },
    { name: "Standard seat", labels: ["Competitor A", "TVD OTA"], values: [12000, 0] },
  ], {
    x: M, y: 1.40, w: 5.35, h: 3.05,
    barDir: "bar", barGrouping: "stacked",
    chartColors: [NAVY, ORANGE, SKY],
    showLegend: true, legendPos: "b", legendFontSize: 10, legendColor: MUTE,
    showValue: false,
    catAxisLabelColor: NAVY, catAxisLabelFontSize: 11, catAxisLabelFontBold: true,
    valAxisLabelColor: MUTE, valAxisLabelFontSize: 9,
    valAxisLabelFormatCode: "#,##0,",
    valAxisMinVal: 0, valAxisMaxVal: 1100000, valAxisMajorUnit: 250000,
    valGridLine: { color: RULE, size: 0.75 },
    catGridLine: { style: "none" },
    showTitle: true, title: "What the customer actually pays  (₦ thousands)",
    titleFontSize: 11, titleColor: MUTE, titleFontFace: F,
    chartArea: { fill: { color: W } },
  });

  card(s, 6.20, 1.40, 3.25, 3.05, TINT);
  s.addText("On the headline", {
    x: 6.44, y: 1.56, w: 2.8, h: 0.22, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 10.5, color: MUTE, charSpacing: 1.2,
  });
  s.addText(money(50000) + " dearer", {
    x: 6.44, y: 1.84, w: 2.8, h: 0.44, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 19, bold: true, color: RUST,
  });
  s.addText("All in", {
    x: 6.44, y: 2.42, w: 2.8, h: 0.22, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 10.5, color: MUTE, charSpacing: 1.2,
  });
  s.addText(money(22000) + " cheaper", {
    x: 6.44, y: 2.70, w: 2.8, h: 0.44, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 19, bold: true, color: GREEN,
  });
  s.addText("A platform comparing headline prices discounts here, gives away margin to fix a problem that does not exist, and repeats it every day until somebody notices.", {
    x: 6.44, y: 3.28, w: 2.78, h: 1.10, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  s.addText("Competitor A: ₦950,000 fare + ₦60,000 bag + ₦12,000 seat = ₦1,022,000.   TVD OTA: ₦1,000,000, bag and seat included.", {
    x: M, y: 4.52, w: 5.35, h: 0.44, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 9.5, color: MUTE,
  });
  footer(s, "Every comparison in the platform runs on this figure, never on the advertised fare.");
  s.addNotes("This is the slide to slow down on. It is the clearest single argument for building the platform at all.");
}

// ================================================================ 14 VALUE GATE
{
  const s = content("A cut has to pay for itself", "Idea two · The value gate");
  s.addText("Margin is unchanged by a price cut only when  |elasticity|  =  price ÷ (price − cost).  Below that bar, discounting buys volume at a loss.", {
    x: M, y: 1.16, w: CW, h: 0.32, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12.5, color: INK, italic: true,
  });

  s.addChart(p.ChartType.line, [{
    name: "Break-even |elasticity|",
    labels: ["4%", "5%", "6%", "8%", "10%", "12%", "15%", "20%", "25%", "30%"],
    values: [25.0, 20.0, 16.7, 12.5, 10.0, 8.3, 6.7, 5.0, 4.0, 3.3],
  }], {
    x: M, y: 1.58, w: 5.60, h: 2.90,
    chartColors: [ORANGE], lineSize: 3, lineSmooth: true,
    showLegend: false,
    showValue: false,
    catAxisLabelColor: MUTE, catAxisLabelFontSize: 9,
    valAxisLabelColor: MUTE, valAxisLabelFontSize: 9,
    valGridLine: { color: RULE, size: 0.75 },
    catGridLine: { style: "none" },
    showTitle: true, title: "Elasticity a cut must clear, by gross margin",
    titleFontSize: 11, titleColor: MUTE, titleFontFace: F,
    showCatAxisTitle: true, catAxisTitle: "Gross margin band on the sale",
    catAxisTitleColor: MUTE, catAxisTitleFontSize: 9.5, catAxisTitleFontFace: F,
    chartArea: { fill: { color: W } },
  });

  card(s, 6.45, 1.58, 3.00, 2.90, TINT2);
  s.addText("Read it this way", {
    x: 6.68, y: 1.76, w: 2.6, h: 0.28, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, bold: true, color: NAVY,
  });
  const reads = [
    "At a 20% margin, a cut pays if a 1% price drop wins 5% more share. Flight shopping clears that.",
    "At a 5% margin it must win 20% more share. It will not.",
    "Below roughly 7% margin, no plausible elasticity makes a cut pay.",
  ];
  s.addText(reads.map((r, i) => ({ text: r, options: { bullet: true, breakLine: i < reads.length - 1 } })), {
    x: 6.68, y: 2.12, w: 2.56, h: 2.20, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK, paraSpaceAfter: 8,
  });
  footer(s, "Where the gate fails, the engine escalates instead of discounting: the gap is in the supplier cost, not in the price.");
  s.addNotes("This directly answers the brief's instruction not to cut price simply because a competitor is cheaper. It is a test, not a sentiment.");
}

// ================================================================ 15 ELASTICITY
{
  const s = content("The parameter that decides everything", "A distinction worth the minute");
  const cols = [
    ["Market demand elasticity", "−1.0 to −1.7", RUST,
     "How total travel demand on a route responds to the price level. This is what an airline uses to set fares.",
     "Wrong tool for us."],
    ["Competitive share elasticity", "−4 to −15", GREEN,
     "How our share of a fixed pool of shoppers responds to our position on the same screen as everyone else.",
     "This is the one that governs an OTA pricing decision."],
  ];
  cols.forEach((c, i) => {
    const x = M + i * 4.55;
    card(s, x, 1.48, 4.35, 2.35, i ? TINT : TINT2);
    s.addText(c[0], {
      x: x + 0.24, y: 1.66, w: 3.9, h: 0.30, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: NAVY,
    });
    s.addText(c[1], {
      x: x + 0.24, y: 2.00, w: 3.9, h: 0.46, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 28, bold: true, color: c[2],
    });
    s.addText(c[3], {
      x: x + 0.24, y: 2.54, w: 3.88, h: 0.72, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11.5, color: INK,
    });
    s.addText(c[4], {
      x: x + 0.24, y: 3.32, w: 3.88, h: 0.44, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11.5, bold: true, color: c[2],
    });
  });
  card(s, M, 3.94, CW, 0.86, TINT);
  s.addText("Flights are close to a commodity and metasearch sorts by price, so share moves violently. Using the airline's number where ours belongs makes the break-even test unreachable at any OTA margin, and the engine would never recommend a cut at all. We found this while building, and fixed it.", {
    x: M + 0.24, y: 4.06, w: 8.45, h: 0.66, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  s.addNotes("Worth saying plainly: this was a real error caught during the build. It is the kind of mistake that produces confident, wrong prices for months.");
}

// ================================================================ 16 CLASSIFICATION
{
  const s = content("Five classifications", "Taxonomy");
  const cls = [
    ["COMPETITIVE", GREEN, "index 0.97 to 1.03", "At market on true cost. No action, and no daily churn to prove the system is working."],
    ["WATCH", SKY, "index 0.93 to 1.08", "Drifting. Worth a look when the gap is large in money, not merely in percent."],
    ["UNCOMPETITIVE", RUST, "outside those bands", "A real gap in either direction. Acted on only after the value gate."],
    ["MARGIN OPPORTUNITY", ORANGE, "index below 0.93", "We are leaving money on the table. Usually the most valuable column, and the one teams forget to build."],
    ["PROTECTED", NAVY, "at the floor, or gate failed", "No mechanical answer. Renegotiate, switch carrier, or accept the position. Never a silent hold."],
  ];
  cls.forEach((c, i) => {
    const y = 1.40 + i * 0.74;
    s.addShape(p.ShapeType.roundRect, {
      x: M, y: y, w: 2.05, h: 0.42, rectRadius: 0.05, fill: { color: c[1] },
    });
    s.addText(c[0], {
      x: M, y: y, w: 2.05, h: 0.42, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 10.5, bold: true, color: c[1] === SKY ? NAVY : W,
      align: "center", valign: "middle", charSpacing: 0.6,
    });
    s.addText(c[2], {
      x: M, y: y + 0.44, w: 2.05, h: 0.22, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 9.5, color: MUTE, align: "center",
    });
    s.addText(c[3], {
      x: M + 2.28, y: y, w: 6.6, h: 0.60, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: INK, valign: "middle",
    });
  });
  s.addNotes("MARGIN OPPORTUNITY is the one to point at. Most competitive pricing tools only look downward.");
}

// ================================================================ 17 LOGIC
{
  const s = content("Eight steps, and the guards come first", "Recommendation logic");
  const steps = [
    ["Guard", "Is this cell safe to act on at all? Fewer than three competitors, stale data or an outlier cheapest price and the engine declines to have an opinion."],
    ["Boundaries", "Minimum price from cost plus the binding floor, whichever of the percentage or absolute floor is higher."],
    ["Target", "Market median and cheapest comparable, blended by how tight the market is, then adjusted for our fee position."],
    ["Constrain", "Floor, daily move cap, rounding to a publishable price, and suppression of moves too small to be worth the churn."],
    ["Classify", "One of the five classes on the previous slide."],
    ["Quantify", "Volume response, damped to seventy percent of the modelled effect, then revenue and margin impact."],
    ["Value gate", "If a cut destroys margin it is not a recommendation. Escalate, and name the break-even elasticity."],
    ["Score and explain", "Confidence from six weighted components, priority from value times confidence, and a rationale in plain English."],
  ];
  steps.forEach((st, i) => {
    const x = M + (i % 2) * 4.55;
    const y = 1.34 + Math.floor(i / 2) * 0.94;
    token(s, x, y + 0.02, String(i + 1), 0.30, i === 0 || i === 6 ? ORANGE : GREEN);
    s.addText(st[0], {
      x: x + 0.42, y: y, w: 3.9, h: 0.26, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: NAVY,
    });
    s.addText(st[1], {
      x: x + 0.42, y: y + 0.27, w: 3.92, h: 0.66, isTextBox: true, margin: 0, valign: "top",
      fontFace: F, fontSize: 10.5, color: INK,
    });
  });
  footer(s, "Steps 1 and 7, in orange, are the two that stop the engine doing something expensive.");
  s.addNotes("The most valuable thing this engine does is decline to have an opinion when the evidence is thin.");
}

// ================================================================ 18 SCENARIOS
{
  const s = content("The engine on seven real cells", "Worked output");
  const head = ["SCENARIO", "CURRENT", "FLOOR", "NEW PRICE", "CHG %", "CLASS", "ACTION"];
  const rows = [
    ["Overpriced, healthy margin", "1,150,000", "880,829", "1,058,000", "−8.0%", "UNCOMPETITIVE", "DECREASE", RUST],
    ["Overpriced, razor margin", "1,150,000", "1,119,171", "1,150,000", "—", "PROTECTED", "ESCALATE", NAVY],
    ["Underpriced, margin room", "880,000", "808,290", "940,600", "+6.9%", "MARGIN OPP", "INCREASE", ORANGE],
    ["Bag advantage vs cheapest", "1,050,000", "808,290", "975,000", "−7.1%", "WATCH", "DECREASE", MUTE],
    ["Competitor below our cost", "1,050,000", "932,642", "1,050,000", "—", "PROTECTED", "ESCALATE", NAVY],
    ["Only one competitor seen", "1,050,000", "932,642", "1,050,000", "—", "WATCH", "INVESTIGATE", MUTE],
    ["Outlier cheapest ignored", "1,050,000", "932,642", "1,050,000", "—", "WATCH", "INVESTIGATE", MUTE],
  ];
  s.addTable(
    [head.map((h, i) => ({
      text: h, options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 9,
        align: i === 0 || i > 4 ? "left" : "right", charSpacing: 0.8 },
    }))].concat(rows.map((r) => [
      { text: r[0], options: { color: INK, fontSize: 10 } },
      { text: r[1], options: { color: INK, fontSize: 10.5, align: "right" } },
      { text: r[2], options: { color: MUTE, fontSize: 10.5, align: "right" } },
      { text: r[3], options: { color: INK, bold: true, fontSize: 10.5, align: "right" } },
      { text: r[4], options: { color: r[4] === "—" ? MUTE : r[7], bold: true, fontSize: 10.5, align: "right" } },
      { text: r[5], options: { color: r[7], fontSize: 9, bold: true } },
      { text: r[6], options: { color: INK, fontSize: 9.5 } },
    ])),
    { x: M, y: 1.36, w: CW, colW: [2.35, 1.00, 1.00, 1.10, 0.80, 1.45, 1.20],
      fontFace: F, border: { type: "solid", color: RULE, pt: 0.5 },
      fill: { color: W }, rowH: 0.30, valign: "middle", margin: [3, 6, 3, 6] }
  );
  card(s, M, 4.22, CW, 0.70, TINT);
  s.addText("Four of the seven produce no price change, and that is the point. A tool that recommends a move on every row is reacting to the market rather than reading it, and the analyst learns to ignore it within a fortnight.", {
    x: M + 0.24, y: 4.32, w: 8.45, h: 0.52, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  footer(s, "Figures generated by the pricing engine in the repository, not written by hand. All amounts in naira.");
  s.addNotes("Every number on this slide came out of an actual call to the engine. Offer to run any scenario the room wants to see.");
}

// ================================================================ 19 CONTROL
{
  const s = content("Recommend, then approve", "Control and audit");

  card(s, M, 1.46, 4.30, 1.70, TINT);
  s.addText("What every decision records", {
    x: M + 0.24, y: 1.62, w: 3.9, h: 0.28, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  const rec = ["Price before, recommended and approved", "Who approved it, and exactly when",
               "A frozen copy of the market at that moment", "Expected margin and confidence",
               "The actual outcome at T+7 and T+30"];
  s.addText(rec.map((r, i) => ({ text: r, options: { bullet: true, breakLine: i < rec.length - 1 } })), {
    x: M + 0.26, y: 1.96, w: 3.85, h: 1.12, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11, color: INK, paraSpaceAfter: 3,
  });

  card(s, M + 4.60, 1.46, 4.30, 1.70, TINT2);
  s.addText("What a person may not override", {
    x: M + 4.84, y: 1.62, w: 3.9, h: 0.28, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  s.addText("An analyst may overrule the engine on any price. An analyst may not approve a price below the margin floor: the service refuses it and names the rule. That argument belongs in a versioned, reviewed pricing rule, not in one booking at a time.", {
    x: M + 4.84, y: 1.96, w: 3.85, h: 1.12, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });

  s.addText("Confidence, and what it is for", {
    x: M, y: 3.24, w: 8.9, h: 0.28, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: NAVY,
  });
  const comps = [["Coverage", "0.25"], ["Data quality", "0.20"], ["Fee certainty", "0.20"],
                 ["Freshness", "0.15"], ["Model", "0.10"], ["Stability", "0.10"]];
  comps.forEach((c, i) => {
    const x = M + i * 1.49;
    s.addText(c[1], {
      x: x, y: 3.58, w: 1.35, h: 0.36, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 22, bold: true, color: i === 0 ? ORANGE : GREEN,
    });
    s.addText(c[0], {
      x: x, y: 3.96, w: 1.40, h: 0.24, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 10.5, color: MUTE,
    });
  });
  s.addText("Coverage carries the most weight because it is the assumption most often violated and least often noticed. Confidence gates the priority band, and later it will gate any automation.", {
    x: M, y: 4.30, w: 8.7, h: 0.50, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  s.addNotes("Phase one is decision support, full stop. Automation is earned later, on the evidence of the scorecard.");
}

// ================================================================ 20 SECTION 3
sectionBreak("03", "Delivery",
  "The six dashboards, when the team sees them, how it gets built, and what would make it fail.");

// ================================================================ 21 DASHBOARD
{
  const s = content("Six dashboards, decision on the row", "Apps Script web app");
  const pages = [
    ["Overview", "Price index against the market, with its healthy band, readable in three seconds. Plus a coverage gauge, so we see when the numbers are not trustworthy."],
    ["Daily review", "The working page. Approve, modify or reject in the table itself. A reason is mandatory on every override."],
    ["Competitors", "Who wins on price, how often, whose strategy is changing, and what the mining job flagged overnight."],
    ["Airline fees", "The fee matrix the commercial team will print and keep. Analyst and lead only."],
    ["Routes", "Price and demand on a shared date axis, so a price move can be judged against what it did to volume."],
    ["Opportunities & audit", "Where the money is, and how well the engine's forecasts have actually held up."],
  ];
  pages.forEach((pg, i) => {
    const x = M + (i % 2) * 4.55;
    const y = 1.36 + Math.floor(i / 2) * 1.20;
    card(s, x, y, 4.35, 1.08, i % 2 ? TINT2 : TINT);
    token(s, x + 0.22, y + 0.18, String(i + 1), 0.28, i === 1 ? ORANGE : GREEN);
    s.addText(pg[0], {
      x: x + 0.60, y: y + 0.14, w: 3.6, h: 0.28, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: NAVY,
    });
    s.addText(pg[1], {
      x: x + 0.22, y: y + 0.52, w: 3.95, h: 0.52, isTextBox: true, margin: 0, valign: "top",
      fontFace: F, fontSize: 10, color: INK,
    });
  });
  footer(s, "One URL, no per-user setup, inside the Workspace tenancy the team already signs into. Every page reads one pre-aggregated view, never the raw offer table.");
  s.addNotes("Built in Apps Script rather than Looker Studio for one reason: the daily review is a workflow, not a report, and a report cannot approve a price, enforce the margin floor, or record who decided what.");
}

// ================================================================ 21b WHY APPS SCRIPT
{
  const s = content("Why not a BI report", "The dashboard decision");

  const rows = [
    ["Approve, modify, reject in place", "Yes, and it is the point", "No, read only"],
    ["Access control", "Workspace groups, three roles, per request", "Report sharing only"],
    ["Enforces the margin floor", "In the dialog and again in the service", "No"],
    ["Query cost control", "Byte cap and shared cache on every query", "Per viewer, harder to bound"],
    ["Says when data is stale", "A banner that stops pretending", "A quiet timestamp"],
    ["Licence cost", "Included in Workspace", "BI Engine is extra"],
  ];
  s.addTable(
    [[
      { text: "", options: { fill: { color: NAVY } } },
      { text: "APPS SCRIPT WEB APP", options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 9.5, charSpacing: 1 } },
      { text: "A BI REPORT", options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 9.5, charSpacing: 1 } },
    ]].concat(rows.map((r, i) => [
      { text: r[0], options: { color: NAVY, bold: true, fontSize: 11 } },
      { text: r[1], options: { color: i === 0 ? DGREEN : INK, bold: i === 0, fontSize: 11 } },
      { text: r[2], options: { color: MUTE, fontSize: 11 } },
    ])),
    { x: M, y: 1.42, w: CW, colW: [3.05, 3.35, 2.50], fontFace: F,
      border: { type: "solid", color: RULE, pt: 0.5 }, fill: { color: W },
      rowH: 0.36, valign: "middle", margin: [3, 8, 3, 8] }
  );

  card(s, M, 4.24, CW, 0.72, TINT);
  s.addText("The deciding row is the first one. Putting the decision two clicks from the evidence separates a dashboard the team uses every morning from one they open in week one and never again.", {
    x: M + 0.24, y: 4.34, w: 8.45, h: 0.54, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11.5, color: INK,
  });
  footer(s, "The app holds no BigQuery write grant at all. Approvals post to the pricing service, which owns the audit trail.");
  s.addNotes("If someone asks why we are not using Looker Studio, this is the slide. It is not a preference, it is that a report cannot carry a decision.");
}

// ================================================================ 22 CADENCE
{
  const s = content("The day, in Africa/Lagos time", "Automation");
  const items = [
    ["Hourly", "Sweep the 40 highest revenue routes", GREEN],
    ["Every 4h", "Sweep the secondary routes", GREEN],
    ["03:00", "Sweep the long tail", GREEN],
    ["05:30", "Build offers and market snapshots", NAVY],
    ["06:00", "Refresh the models, weekdays only", NAVY],
    ["06:15", "Write the day's recommendations", ORANGE],
    ["06:45", "Populate the Daily Review sheet", ORANGE],
    ["07:00", "Digest lands in the team's inbox", ORANGE],
    ["Daytime", "Analysts approve, modify or reject", NAVY],
    ["18:00", "Measure outcomes at T+7 and T+30", GREEN],
  ];
  items.forEach((it, i) => {
    const x = M + (i % 2) * 4.55;
    const y = 1.32 + Math.floor(i / 2) * 0.72;
    s.addShape(p.ShapeType.roundRect, {
      x: x, y: y, w: 1.05, h: 0.40, rectRadius: 0.05, fill: { color: it[2] },
    });
    s.addText(it[0], {
      x: x, y: y, w: 1.05, h: 0.40, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, bold: true, color: W, align: "center", valign: "middle",
    });
    s.addText(it[1], {
      x: x + 1.20, y: y, w: 3.20, h: 0.40, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11.5, color: INK, valign: "middle",
    });
  });
  footer(s, "Approvals happen in Google Sheets, where the team already works. A workflow people avoid is worse than none.");
  s.addNotes("Everything before 07:00 is machine work. Everything after is human judgement.");
}

// ================================================================ 23 ROADMAP
{
  const s = content("Something useful by week six", "Implementation roadmap");
  const phases = [
    ["0", "Wks 1–2", "Foundation", "GCP, IAM, CI. Land our own transactions and agree one margin definition with Finance.", ORANGE],
    ["1", "Wks 3–6", "Collection", "Collector service, GDS and NDC, 40 routes. Dashboard shell live.", GREEN],
    ["2", "Wks 7–10", "True cost", "Licensed competitor feed, fee catalogue, true customer cost live.", GREEN],
    ["3", "Wks 11–15", "The engine", "Rules in Sheets, recommendations, in-app approvals, audit trail, mining.", NAVY],
    ["4", "Wks 16–22", "Learning", "Outcome measurement, route elasticity, demand forecast, deliberate price tests.", NAVY],
    ["5", "Wks 23–30", "Earned automation", "Small changes auto-applied on proven routes. Scale to 150 routes.", RUST],
  ];
  phases.forEach((ph, i) => {
    const y = 1.30 + i * 0.62;
    token(s, M, y + 0.06, ph[0], 0.30, ph[4]);
    s.addText(ph[1], {
      x: M + 0.44, y: y + 0.02, w: 0.95, h: 0.36, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 10.5, bold: true, color: MUTE, valign: "middle",
    });
    s.addText(ph[2], {
      x: M + 1.45, y: y + 0.02, w: 1.75, h: 0.36, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: NAVY, valign: "middle",
    });
    s.addText(ph[3], {
      x: M + 3.25, y: y + 0.02, w: 5.6, h: 0.36, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: INK, valign: "middle",
    });
  });
  footer(s, "Phase 0 asks whether supplier cost is reliable per booking. Week two is a far better time to learn that than week fourteen.");
  s.addNotes("Sequenced so nothing is built on data that has not yet proved it exists. Shadow-run the engine for the first two weeks of phase 3.");
}

// ================================================================ 24 RISKS
{
  const s = content("What would make this fail", "Risks, and the answer already designed in");
  const head = ["RISK", "HOW IT SHOWS UP", "WHAT ALREADY ANSWERS IT"];
  const rows = [
    ["Supplier cost unreliable", "Margin figures Finance will not sign", "Phase 0 exists to find this first"],
    ["Thin competitor panel", "Confident advice from two data points", "Hard three-seller minimum, coverage score"],
    ["Ancillary data stays sparse", "True cost quietly reverts to headline", "Fee confidence demotes the recommendation"],
    ["Elasticity from thin data", "Revenue figures nobody should believe", "Shrinkage to a regional prior, source always shown"],
    ["Analysts ignore the tool", "Sheet untouched by week three", "Approval where they already work, sorted by money"],
    ["A licensed feed changes terms", "A commercial dispute nobody saw", "Legal basis on every row, register reviewed quarterly"],
  ];
  s.addTable(
    [head.map((h) => ({ text: h, options: { bold: true, color: W, fill: { color: NAVY }, fontSize: 9.5, charSpacing: 1 } }))]
      .concat(rows.map((r) => [
        { text: r[0], options: { color: NAVY, bold: true, fontSize: 11 } },
        { text: r[1], options: { color: INK, fontSize: 11 } },
        { text: r[2], options: { color: DGREEN, fontSize: 11 } },
      ])),
    { x: M, y: 1.42, w: CW, colW: [2.30, 3.10, 3.50], fontFace: F,
      border: { type: "solid", color: RULE, pt: 0.5 }, fill: { color: W },
      rowH: 0.42, valign: "middle", margin: [4, 8, 4, 8] }
  );
  footer(s, "None of these is hypothetical. Each one has been designed against rather than noted and forgotten.");
  s.addNotes("Showing the failure modes builds more confidence than hiding them. Every row has a control behind it.");
}

// ================================================================ 25 CLOSE
{
  const s = dark();
  s.addText("WHAT WE ARE ASKING FOR", {
    x: M, y: 0.95, w: 8.9, h: 0.26, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11, bold: true, color: ORANGE, charSpacing: 2.2,
  });
  s.addText("Approve phase 0", {
    x: M, y: 1.32, w: 8.6, h: 0.90, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 52, bold: true, color: W,
  });
  const asks = [
    ["Two weeks", "to land our own transaction data and prove supplier cost is reliable"],
    ["One decision", "Finance and Commercial agree a single margin definition, in writing"],
    ["One owner", "a named pricing analyst who will work the daily review from phase 3"],
  ];
  asks.forEach((a, i) => {
    const y = 2.52 + i * 0.62;
    token(s, M, y + 0.02, String(i + 1), 0.30, ORANGE);
    s.addText(a[0], {
      x: M + 0.44, y: y, w: 1.55, h: 0.34, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: SKY, valign: "middle",
    });
    s.addText(a[1], {
      x: M + 2.05, y: y, w: 6.6, h: 0.34, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: "C9DCE8", valign: "middle",
    });
  });
  s.addText("The design, the BigQuery model, the pricing engine and the approval workflow are already written and tested. What phase 0 buys is the confidence that our own data can carry them.", {
    x: M, y: 4.44, w: 7.7, h: 0.55, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: "9FBACB", italic: true,
  });
  logo(s, true, 8.55, 4.92, 0.90);
  s.addNotes("Close on the smallest possible ask. Phase 0 is two weeks and answers the one question that could stop the whole programme.");
}

p.writeFile({ fileName: "TVD_OTA_FareIQ_Platform.pptx" })
  .then((f) => console.log("written:", f));
