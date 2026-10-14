/**
 * Exchange rate fluctuation analytics for the dashboard.
 *
 * For a look-back window (7, 30, 90, 180 or 365 days) this works out, for every
 * currency and category: the rate at the start of the window, the current
 * rate, the change, the high and low, how many times the rate moved, the
 * biggest single move, and a daily closing series for the chart.
 */

var ALLOWED_WINDOWS = [7, 30, 90, 180, 365];

function getFluctuations_(payload) {
  var days = Number(payload && payload.days) || 30;
  if (ALLOWED_WINDOWS.indexOf(days) === -1) days = 30;

  var pubs = loadPublications_().filter(function (p) { return p.status === 'ACTIVE'; });
  pubs.reverse(); // oldest first

  var now = new Date();
  var todayKey = fmtDate_(now, 'yyyy-MM-dd');
  var startDay = Utilities.parseDate(todayKey + ' 00:00:00', tz_(), 'yyyy-MM-dd HH:mm:ss');
  startDay = new Date(startDay.getTime() - (days - 1) * 86400000);

  var dayKeys = [];
  var dayLabels = [];
  for (var t = startDay.getTime(); dayKeys.length < days; t += 86400000) {
    var d = new Date(t + 12 * 3600000); // midday avoids any DST edge
    dayKeys.push(fmtDate_(d, 'yyyy-MM-dd'));
    dayLabels.push(fmtDate_(d, 'dd MMM'));
  }

  var events = {};
  pubs.forEach(function (p) {
    p.rates.forEach(function (r) {
      var k = rateKey_(r.currency, r.category);
      (events[k] = events[k] || []).push({ at: p.effectiveAt, day: fmtDate_(p.effectiveAt, 'yyyy-MM-dd'), rate: r.rate });
    });
  });

  var groups = groupCategories_(getCategories_(false)).map(function (g) {
    return {
      currency: g.currency,
      displayName: g.displayName,
      series: g.categories.map(function (cat) {
        return summarizeSeries_(cat, events[rateKey_(g.currency, cat)] || [], startDay, dayKeys);
      })
    };
  });

  var book = getBookRates_().entries[0] || null;
  groups.forEach(function (g) {
    var bookRate = book ? book[g.currency.toLowerCase()] : null;
    g.bookRate = bookRate || null;
    g.series.forEach(function (s) {
      s.markupOverBook = bookRate && s.current ? round2_((s.current - bookRate) / bookRate * 100) : null;
    });
  });

  return {
    days: days,
    windows: ALLOWED_WINDOWS,
    labels: dayLabels,
    dayKeys: dayKeys,
    groups: groups,
    book: book,
    publicationsInWindow: pubs.filter(function (p) { return p.effectiveAt >= startDay; }).length
  };
}

function summarizeSeries_(category, evts, startDay, dayKeys) {
  var open = null;
  var inWindow = [];
  evts.forEach(function (e) {
    if (e.at < startDay) open = e.rate;
    else inWindow.push(e);
  });

  // Daily close: the last rate published on or before each day.
  var closes = [];
  var idx = 0;
  var last = open;
  dayKeys.forEach(function (key) {
    while (idx < inWindow.length && inWindow[idx].day <= key) {
      last = inWindow[idx].rate;
      idx++;
    }
    closes.push(last);
  });

  var all = (open !== null ? [open] : []).concat(inWindow.map(function (e) { return e.rate; }));
  var current = all.length ? all[all.length - 1] : null;
  var base = open !== null ? open : (inWindow.length ? inWindow[0].rate : null);

  var moves = 0;
  var biggest = null;
  var prev = open;
  inWindow.forEach(function (e) {
    if (prev !== null && e.rate !== prev) {
      moves++;
      var delta = round2_(e.rate - prev);
      if (!biggest || Math.abs(delta) > Math.abs(biggest.change)) {
        biggest = { change: delta, from: prev, to: e.rate, label: fmtDate_(e.at, 'dd/MM/yy') + ' @ ' + fmtDate_(e.at, 'HH:mm') };
      }
    }
    prev = e.rate;
  });

  return {
    category: category,
    current: current,
    open: base,
    change: current !== null && base !== null ? round2_(current - base) : null,
    changePct: current !== null && base ? round2_((current - base) / base * 100) : null,
    high: all.length ? Math.max.apply(null, all) : null,
    low: all.length ? Math.min.apply(null, all) : null,
    moves: moves,
    biggestMove: biggest,
    closes: closes
  };
}
