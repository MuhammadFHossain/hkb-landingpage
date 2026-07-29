'use strict';

// stats.js
// Pure functions, no I/O. Funnel aggregation and statistics for the
// Capstan funnel dashboard. See SPEC.md "stats.js contracts".

const Z95 = 1.96; // z for a 95% two-sided interval

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Tolerant JSONL parser: one JSON object per line, malformed lines skipped.
function parseJsonl(text) {
  const rows = [];
  if (typeof text !== 'string' || text.length === 0) return rows;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch (e) {
      // skip malformed line
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Math primitives
// ---------------------------------------------------------------------------

// erf approximation, Abramowitz & Stegun 7.1.26. Max abs error ~1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// Standard normal CDF.
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Wilson 95% score interval for a proportion. Returns [lo, hi].
// Clean zeros when n is 0 or invalid.
function wilson(successes, n) {
  if (!Number.isFinite(n) || n <= 0) return [0, 0];
  const s = Math.max(0, Math.min(successes || 0, n));
  const p = s / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// Two-proportion z-test with pooled SE. Two-sided p via the erf-based
// normal CDF. Returns { z, p }. Degenerate inputs return { z: 0, p: 1 }.
function twoProportionZ(x1, n1, x2, n2) {
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0 || n2 <= 0) {
    return { z: 0, p: 1 };
  }
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { z, p: Math.min(1, Math.max(0, p)) };
}

// Classic two-proportion sample size per arm. alpha .05 two-sided, power .8.
// baselineCvr is a proportion (0.10 = 10%), relLift is relative (0.20 = +20%).
function sampleSize(baselineCvr, relLift) {
  const p1 = baselineCvr;
  const p2 = baselineCvr * (1 + relLift);
  if (!(p1 > 0) || !(p2 > 0) || p1 >= 1 || p2 >= 1 || p1 === p2) return 0;
  const zAlpha = 1.959963985; // z for alpha/2 = .025
  const zBeta = 0.841621234; // z for power .8
  const pBar = (p1 + p2) / 2;
  const num =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p1 - p2) * (p1 - p2)));
}

// Evan Miller simple sequential rule boundary.
function sequentialBoundary(N) {
  const n = Number.isFinite(N) && N > 0 ? N : 1;
  return Math.ceil(2.25 * Math.sqrt(n));
}

// Snapshot sequential verdict for one control-vs-challenger pair.
// Returns { boundary, lead, verdict } where verdict is
// "collecting" | "winner:<id>" | "no-winner".
// NOTE: computeStats decides with sequentialReplay (chronological, frozen at
// the first crossing); this snapshot form is kept for reference and tests.
function sequentialVerdict(controlSignups, challengerSignups, N, controlId, challengerId) {
  const c = Math.max(0, controlSignups || 0);
  const ch = Math.max(0, challengerSignups || 0);
  const boundary = sequentialBoundary(N);
  const lead = Math.abs(c - ch);
  let verdict = 'collecting';
  if (lead >= boundary) {
    verdict = 'winner:' + (c > ch ? controlId || 'control' : challengerId || 'challenger');
  } else if (c + ch >= (Number.isFinite(N) && N > 0 ? N : 1)) {
    verdict = 'no-winner';
  }
  return { boundary, lead, verdict };
}

// Chronological sequential replay for one control-vs-challenger pair.
// signups: email-deduped rows [{t, v}] for the two variants only, any order.
// Walks them sorted by t and FREEZES the verdict at the first boundary
// crossing (winner) or when the pair reaches N total signups (no-winner).
// Signups after the freeze never change the verdict; they are reported
// separately in sinceDecision. While still collecting, counts and lead are
// the live snapshot (used for the progress display only).
function sequentialReplay(signups, N, controlId, challengerId) {
  const n = Number.isFinite(N) && N > 0 ? N : 1;
  const boundary = sequentialBoundary(N);
  const rows = (Array.isArray(signups) ? signups : [])
    .filter((r) => r && (r.v === controlId || r.v === challengerId))
    .map((r) => {
      const ms = Date.parse(r.t);
      return { v: r.v, ms: Number.isFinite(ms) ? ms : Infinity };
    })
    .sort((a, b) => a.ms - b.ms); // Array.prototype.sort is stable

  let c = 0;
  let ch = 0;
  let frozen = null; // { verdict, c, ch } at the moment the rule was met
  let sinceControl = 0;
  let sinceChallenger = 0;

  for (const row of rows) {
    const isControl = row.v === controlId;
    if (frozen) {
      if (isControl) sinceControl++;
      else sinceChallenger++;
      continue;
    }
    if (isControl) c++;
    else ch++;
    if (Math.abs(c - ch) >= boundary) {
      frozen = { verdict: 'winner:' + (c > ch ? controlId : challengerId), c, ch };
    } else if (c + ch >= n) {
      frozen = { verdict: 'no-winner', c, ch };
    }
  }

  if (frozen) {
    return {
      challenger: challengerId,
      controlSignups: frozen.c,
      challengerSignups: frozen.ch,
      lead: Math.abs(frozen.c - frozen.ch),
      verdict: frozen.verdict,
      sinceDecision: { control: sinceControl, challenger: sinceChallenger },
    };
  }
  return {
    challenger: challengerId,
    controlSignups: c,
    challengerSignups: ch,
    lead: Math.abs(c - ch),
    verdict: 'collecting',
    sinceDecision: { control: 0, challenger: 0 },
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// utm.source with missing treated as "direct".
function utmSource(row) {
  if (row && row.utm && typeof row.utm === 'object' && row.utm.source) {
    return String(row.utm.source);
  }
  return 'direct';
}

// ISO timestamp -> "YYYY-MM-DD" in UTC, or null if unparseable.
function utcDate(t) {
  if (typeof t !== 'string' || !t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function incMap(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

// Events counted once per sid per variant. The beacon de-dupes per page
// load only, so unique-per-sid keeps reloads from inflating the funnel.
const COUNTED_EVENTS = new Set([
  'pageview',
  'scroll_50',
  'scroll_90',
  'form_start',
  'ty_pageview',
  'deposit_click',
  'community_click',
]);

// computeStats(events, subscribers, settings, variants) -> stats
// events: rows from data/events.jsonl        {t, e, v, sid, utm, meta?}
// subscribers: rows from data/subscribers.jsonl  {t, email, v, sid, utm}
// settings: settings.json object; variants: parsed variants/*.json array.
function computeStats(events, subscribers, settings, variants) {
  const evRows = Array.isArray(events) ? events : [];
  const subRows = Array.isArray(subscribers) ? subscribers : [];
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const variantList = Array.isArray(variants) ? variants : [];

  // --- events pass ---
  const perVariant = new Map(); // vid -> { eventName -> Set(sid) }
  const allVisitors = new Set(); // unique sid with pageview, any variant
  const sourceVisitors = new Map(); // source -> Set(sid)
  const dayVisitors = new Map(); // "YYYY-MM-DD" -> Set(sid)
  const depositSids = new Set(); // unique sid with deposit_click, any variant

  for (const row of evRows) {
    if (!row || typeof row !== 'object' || typeof row.e !== 'string') continue;
    const e = row.e;
    if (!COUNTED_EVENTS.has(e)) continue;
    const sid = typeof row.sid === 'string' && row.sid ? row.sid : 'anon';
    const vid = typeof row.v === 'string' ? row.v : '';

    let bucket = perVariant.get(vid);
    if (!bucket) {
      bucket = {};
      perVariant.set(vid, bucket);
    }
    if (!bucket[e]) bucket[e] = new Set();
    bucket[e].add(sid);

    if (e === 'pageview') {
      allVisitors.add(sid);
      addToSetMap(sourceVisitors, utmSource(row), sid);
      const day = utcDate(row.t);
      if (day) addToSetMap(dayVisitors, day, sid);
    }
    if (e === 'deposit_click') depositSids.add(sid);
  }

  // --- subscribers pass: dedupe by email, attribute to first row seen ---
  const seenEmails = new Set();
  const signupsByVariant = new Map();
  const signupsBySource = new Map();
  const signupsByDay = new Map();
  const dedupedSignups = []; // [{t, v}] one per unique email, for the replay
  let totalSignups = 0;

  for (const row of subRows) {
    if (!row || typeof row !== 'object' || typeof row.email !== 'string') continue;
    const email = row.email.trim().toLowerCase();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    totalSignups += 1;
    incMap(signupsByVariant, typeof row.v === 'string' ? row.v : '');
    incMap(signupsBySource, utmSource(row));
    dedupedSignups.push({ t: row.t, v: typeof row.v === 'string' ? row.v : '' });
    const day = utcDate(row.t);
    if (day) incMap(signupsByDay, day);
  }

  // --- per-variant funnel ---
  const variantStats = variantList.map((v) => {
    const bucket = perVariant.get(v.id) || {};
    const size = (name) => (bucket[name] ? bucket[name].size : 0);
    const visitors = size('pageview');
    const signups = signupsByVariant.get(v.id) || 0;
    const depositClicks = size('deposit_click');
    return {
      id: v.id,
      label: v.label || v.id,
      status: v.status || 'active',
      visitors,
      scroll50: size('scroll_50'),
      scroll90: size('scroll_90'),
      formStarts: size('form_start'),
      signups,
      tyViews: size('ty_pageview'),
      depositClicks,
      communityClicks: size('community_click'),
      // Clamped to 1: signups can outnumber visitors when a signup row has
      // no matching pageview (blocked beacon, cleared cookies).
      cvr: visitors > 0 ? Math.min(1, signups / visitors) : 0,
      cvrCI: wilson(signups, visitors),
      depositCtr: signups > 0 ? Math.min(1, depositClicks / signups) : 0,
      // Data-quality flags: identity spaces differ (signups are unique
      // emails, visitors and deposit clicks are unique sessions), so a
      // clamped ratio means beacons were blocked or cookies cleared.
      signupsExceedVisitors: signups > visitors,
      depositClicksExceedSignups: depositClicks > signups,
    };
  });

  // Signups whose variant id is unknown (renamed or deleted variant, or a
  // row with no variant) still count in the totals tile, so they get a
  // synthetic row to keep the table honest. Status 'unknown' keeps the row
  // out of the sequential pairs and z-tests, which filter on 'active'.
  const knownIds = new Set(variantList.map((v) => v.id));
  let orphanSignups = 0;
  for (const [vid, count] of signupsByVariant) {
    if (!knownIds.has(vid)) orphanSignups += count;
  }
  if (orphanSignups > 0) {
    variantStats.push({
      id: '<other>',
      label: 'Unattributed / removed variants',
      status: 'unknown',
      visitors: 0,
      scroll50: 0,
      scroll90: 0,
      formStarts: 0,
      signups: orphanSignups,
      tyViews: 0,
      depositClicks: 0,
      communityClicks: 0,
      cvr: 0,
      cvrCI: [0, 0],
      depositCtr: 0,
      signupsExceedVisitors: false,
      depositClicksExceedSignups: false,
    });
  }

  // --- by source ---
  const sourceNames = new Set([...sourceVisitors.keys(), ...signupsBySource.keys()]);
  const bySource = [...sourceNames]
    .map((source) => {
      const vis = sourceVisitors.has(source) ? sourceVisitors.get(source).size : 0;
      const sg = signupsBySource.get(source) || 0;
      return { source, visitors: vis, signups: sg, cvr: vis > 0 ? sg / vis : 0 };
    })
    .sort((a, b) => b.visitors - a.visitors || a.source.localeCompare(b.source));

  // --- daily rollup (UTC), sorted ascending by date ---
  const dayNames = new Set([...dayVisitors.keys(), ...signupsByDay.keys()]);
  const daily = [...dayNames].sort().map((date) => ({
    date,
    visitors: dayVisitors.has(date) ? dayVisitors.get(date).size : 0,
    signups: signupsByDay.get(date) || 0,
  }));

  // --- sequential test: control vs each active challenger ---
  // Decided by chronological replay: the verdict freezes at the first
  // boundary crossing or at N total signups, and later signups cannot
  // re-open or flip it.
  const controlId = typeof cfg.control === 'string' && cfg.control ? cfg.control : '';
  const N = Number.isFinite(Number(cfg.sequentialN)) && Number(cfg.sequentialN) > 0
    ? Number(cfg.sequentialN)
    : 300;
  const control = variantStats.find((v) => v.id === controlId) || null;

  let sequential;
  let ztests;
  if (!control) {
    // Misconfiguration: without a control there is no valid test.
    sequential = {
      n: N,
      boundary: sequentialBoundary(N),
      configError: controlId
        ? 'settings.control is "' + controlId + '" but no variant has that id. ' +
          'Set settings.control to the id of the control variant.'
        : 'settings.control is not set. Set it to the id of the control variant.',
      pairs: [],
    };
    ztests = [];
  } else {
    const controlVisitors = control.visitors;
    const challengers = variantStats.filter(
      (v) => v.id !== controlId && v.status === 'active'
    );

    const pairs = challengers.map((c) =>
      sequentialReplay(dedupedSignups, N, controlId, c.id)
    );

    ztests = challengers.map((c) => {
      const r = twoProportionZ(control.signups, controlVisitors, c.signups, c.visitors);
      return {
        challenger: c.id,
        z: r.z,
        p: r.p,
        note: 'reference only, decide with the sequential rule',
      };
    });

    sequential = { n: N, boundary: sequentialBoundary(N), pairs };
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      visitors: allVisitors.size,
      signups: totalSignups,
      deposits: depositSids.size,
    },
    variants: variantStats,
    bySource,
    daily,
    sequential,
    ztests,
  };
}

module.exports = {
  parseJsonl,
  computeStats,
  sampleSize,
  wilson,
  twoProportionZ,
  sequentialVerdict,
  sequentialReplay,
};

// ---------------------------------------------------------------------------
// Self-tests: node stats.js
// ---------------------------------------------------------------------------

if (require.main === module) {
  const assert = require('assert');
  const pass = (name) => console.log('PASS ' + name);

  // Wilson 95% CI for 50/100 is about [0.404, 0.596].
  const [lo, hi] = wilson(50, 100);
  assert(Math.abs(lo - 0.404) < 0.005, 'wilson lo ' + lo);
  assert(Math.abs(hi - 0.596) < 0.005, 'wilson hi ' + hi);
  pass('wilson(50,100) = [' + lo.toFixed(4) + ', ' + hi.toFixed(4) + ']');

  // Edge: zero n gives clean zeros.
  assert.deepStrictEqual(wilson(0, 0), [0, 0]);
  pass('wilson(0,0) = [0, 0]');

  // Two-proportion z: equal counts -> p near 1.
  const eq = twoProportionZ(50, 100, 50, 100);
  assert(eq.p > 0.99, 'equal counts p ' + eq.p);
  pass('twoProportionZ equal counts p = ' + eq.p.toFixed(3));

  // Two-proportion z: extreme difference -> p < .001.
  const ex = twoProportionZ(10, 1000, 200, 1000);
  assert(ex.p < 0.001, 'extreme p ' + ex.p);
  pass('twoProportionZ extreme difference p < .001');

  // Sample size: baseline 10%, +20% relative lift, ~3900 per arm.
  const n = sampleSize(0.1, 0.2);
  assert(Math.abs(n - 3900) / 3900 <= 0.1, 'sampleSize ' + n);
  pass('sampleSize(0.10, 0.20) = ' + n + ' per arm (within 10% of 3900)');

  // Sequential boundary for N=300 is ceil(2.25 * sqrt(300)) = 39.
  assert.strictEqual(sequentialVerdict(0, 0, 300, 'a', 'b').boundary, 39);
  pass('sequential boundary for N=300 = 39');

  // Sequential verdicts.
  assert.strictEqual(sequentialVerdict(50, 10, 300, 'a', 'b').verdict, 'winner:a');
  assert.strictEqual(sequentialVerdict(10, 50, 300, 'a', 'b').verdict, 'winner:b');
  assert.strictEqual(sequentialVerdict(160, 140, 300, 'a', 'b').verdict, 'no-winner');
  assert.strictEqual(sequentialVerdict(10, 5, 300, 'a', 'b').verdict, 'collecting');
  pass('sequentialVerdict winner / no-winner / collecting');

  // parseJsonl skips malformed lines.
  const rows = parseJsonl('{"a":1}\nnot json\n\n{bad\n{"b":2}\n');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].a, 1);
  assert.strictEqual(rows[1].b, 2);
  pass('parseJsonl skips malformed lines (' + rows.length + ' of 4 kept)');

  // computeStats: clean zeros on empty data.
  const empty = computeStats([], [], { control: 'x', sequentialN: 300 }, [
    { id: 'x', label: 'X', status: 'active' },
  ]);
  assert.strictEqual(empty.totals.visitors, 0);
  assert.strictEqual(empty.totals.signups, 0);
  assert.strictEqual(empty.variants[0].cvr, 0);
  assert.deepStrictEqual(empty.variants[0].cvrCI, [0, 0]);
  assert.strictEqual(empty.sequential.boundary, 39);
  pass('computeStats clean zeros on empty data');

  // computeStats: synthetic end-to-end aggregation.
  const t1 = '2026-07-01T10:00:00.000Z';
  const t2 = '2026-07-02T10:00:00.000Z';
  const utmA = { source: 'reddit', medium: 'social', campaign: 'c', content: '' };
  const events = [
    { t: t1, e: 'pageview', v: 'a', sid: 's1', utm: utmA },
    { t: t1, e: 'pageview', v: 'a', sid: 's1', utm: utmA }, // reload, deduped
    { t: t1, e: 'scroll_50', v: 'a', sid: 's1', utm: utmA },
    { t: t1, e: 'form_start', v: 'a', sid: 's1', utm: utmA },
    { t: t2, e: 'pageview', v: 'a', sid: 's2' },
    { t: t2, e: 'pageview', v: 'b', sid: 's3' },
    { t: t2, e: 'ty_pageview', v: 'a', sid: 's1', utm: utmA },
    { t: t2, e: 'deposit_click', v: 'a', sid: 's1', utm: utmA },
    { t: t2, e: 'hax_event', v: 'a', sid: 's9' }, // not whitelisted, ignored
  ];
  const subs = [
    { t: t2, email: 'One@Example.com', v: 'a', sid: 's1', utm: utmA },
    { t: t2, email: 'one@example.com ', v: 'b', sid: 's3' }, // dupe email, ignored
    { t: t2, email: 'two@example.com', v: 'b', sid: 's3' },
  ];
  const s = computeStats(events, subs, { control: 'a', sequentialN: 300 }, [
    { id: 'a', label: 'A', status: 'active' },
    { id: 'b', label: 'B', status: 'active' },
  ]);
  const va = s.variants.find((v) => v.id === 'a');
  const vb = s.variants.find((v) => v.id === 'b');
  assert.strictEqual(s.totals.visitors, 3);
  assert.strictEqual(s.totals.signups, 2);
  assert.strictEqual(s.totals.deposits, 1);
  assert.strictEqual(va.visitors, 2);
  assert.strictEqual(va.signups, 1);
  assert.strictEqual(va.scroll50, 1);
  assert.strictEqual(va.formStarts, 1);
  assert.strictEqual(va.tyViews, 1);
  assert.strictEqual(va.depositClicks, 1);
  assert.strictEqual(va.depositCtr, 1);
  assert.strictEqual(vb.visitors, 1);
  assert.strictEqual(vb.signups, 1); // only the non-dupe email
  const reddit = s.bySource.find((r) => r.source === 'reddit');
  const direct = s.bySource.find((r) => r.source === 'direct');
  assert(reddit && reddit.visitors === 1 && reddit.signups === 1);
  assert(direct && direct.visitors === 2 && direct.signups === 1);
  assert.strictEqual(s.daily.length, 2);
  assert.strictEqual(s.daily[0].date, '2026-07-01');
  assert.strictEqual(s.daily[0].visitors, 1);
  assert.strictEqual(s.daily[1].signups, 2);
  assert.strictEqual(s.sequential.pairs.length, 1);
  assert.strictEqual(s.sequential.pairs[0].verdict, 'collecting');
  assert.strictEqual(s.ztests.length, 1);
  assert(s.ztests[0].note.indexOf('sequential') !== -1);
  pass('computeStats synthetic aggregation (attribution, dedupe, sources, daily)');

  // Helper: unique subscriber rows with strictly increasing timestamps.
  const makeSubs = (specs) => {
    // specs: array of variant ids in chronological order
    const base = Date.UTC(2026, 0, 1);
    return specs.map((vid, i) => ({
      t: new Date(base + i * 1000).toISOString(),
      email: 'u' + i + '@example.com',
      v: vid,
      sid: 's' + i,
    }));
  };
  const twoVariants = [
    { id: 'a', label: 'A', status: 'active' },
    { id: 'b', label: 'B', status: 'active' },
  ];

  // Re-decision scenario: 150/150 alternating reaches N=300 with no crossing,
  // so the verdict freezes at no-winner. 40 extra challenger signups after
  // the freeze must NOT re-open the test or produce a winner.
  {
    const order = [];
    for (let i = 0; i < 300; i++) order.push(i % 2 === 0 ? 'a' : 'b');
    for (let i = 0; i < 40; i++) order.push('b');
    const st = computeStats([], makeSubs(order), { control: 'a', sequentialN: 300 }, twoVariants);
    const pair = st.sequential.pairs[0];
    assert.strictEqual(pair.verdict, 'no-winner');
    assert.strictEqual(pair.controlSignups, 150);
    assert.strictEqual(pair.challengerSignups, 150);
    assert.strictEqual(pair.lead, 0);
    assert.deepStrictEqual(pair.sinceDecision, { control: 0, challenger: 40 });
    pass('sequential replay: no-winner verdict stays frozen after 40 late signups');
  }

  // Early-winner scenario: 39 straight control signups cross the boundary
  // (ceil(2.25 * sqrt(300)) = 39), so control wins. 300 challenger signups
  // afterwards dilute the totals but must not overturn the frozen verdict.
  {
    const order = [];
    for (let i = 0; i < 39; i++) order.push('a');
    for (let i = 0; i < 300; i++) order.push('b');
    const st = computeStats([], makeSubs(order), { control: 'a', sequentialN: 300 }, twoVariants);
    const pair = st.sequential.pairs[0];
    assert.strictEqual(pair.verdict, 'winner:a');
    assert.strictEqual(pair.controlSignups, 39);
    assert.strictEqual(pair.challengerSignups, 0);
    assert.strictEqual(pair.lead, 39);
    assert.deepStrictEqual(pair.sinceDecision, { control: 0, challenger: 300 });
    pass('sequential replay: winner verdict stays frozen through later dilution');
  }

  // configError path: control id missing or not matching any variant.
  {
    const bad = computeStats([], [], { control: 'nope', sequentialN: 300 }, twoVariants);
    assert.strictEqual(typeof bad.sequential.configError, 'string');
    assert(bad.sequential.configError.indexOf('nope') !== -1);
    assert.deepStrictEqual(bad.sequential.pairs, []);
    assert.deepStrictEqual(bad.ztests, []);
    const unset = computeStats([], [], { sequentialN: 300 }, twoVariants);
    assert.strictEqual(typeof unset.sequential.configError, 'string');
    assert.deepStrictEqual(unset.sequential.pairs, []);
    pass('sequential configError on missing or unknown control id');
  }

  // cvr clamp: signups without matching pageviews cannot push cvr above 1.
  {
    const t = '2026-07-01T10:00:00.000Z';
    const st = computeStats(
      [
        { t, e: 'pageview', v: 'a', sid: 's1' },
        { t, e: 'deposit_click', v: 'a', sid: 's1' },
        { t, e: 'deposit_click', v: 'a', sid: 's2' },
      ],
      [
        { t, email: 'c1@example.com', v: 'a', sid: 's1' },
        { t, email: 'c2@example.com', v: 'a', sid: 'zz' },
      ],
      { control: 'a', sequentialN: 300 },
      [{ id: 'a', label: 'A', status: 'active' }]
    );
    const va = st.variants[0];
    assert.strictEqual(va.visitors, 1);
    assert.strictEqual(va.signups, 2);
    assert.strictEqual(va.cvr, 1); // clamped, not 2
    assert(va.cvrCI[1] <= 1);
    assert.strictEqual(va.depositCtr, 1); // 2 clicks / 2 signups, capped at 1
    assert.strictEqual(va.signupsExceedVisitors, true); // quality flag surfaces
    pass('cvr and depositCtr clamped to 1, quality flag set');
  }

  // Orphaned signup rows (variant id unknown or null) must not crash and
  // must not leak into any pair.
  {
    const t = '2026-07-01T10:00:00.000Z';
    const st = computeStats(
      [],
      [
        { t, email: 'o1@example.com', v: 'ghost', sid: 's1' },
        { t, email: 'o2@example.com', v: null, sid: 's2' },
      ],
      { control: 'a', sequentialN: 300 },
      twoVariants
    );
    assert.strictEqual(st.totals.signups, 2);
    assert.strictEqual(st.variants.find((v) => v.id === 'a').signups, 0);
    assert.strictEqual(st.variants.find((v) => v.id === 'b').signups, 0);
    // The synthetic row makes the table sum to the totals tile.
    const other = st.variants.find((v) => v.id === '<other>');
    assert(other, 'synthetic <other> row present');
    assert.strictEqual(other.signups, 2);
    assert.strictEqual(other.status, 'unknown');
    const rowSum = st.variants.reduce((s, v) => s + v.signups, 0);
    assert.strictEqual(rowSum, st.totals.signups);
    const pair = st.sequential.pairs[0];
    assert.strictEqual(pair.controlSignups, 0);
    assert.strictEqual(pair.challengerSignups, 0);
    assert.strictEqual(pair.verdict, 'collecting');
    // The synthetic row never becomes a challenger.
    assert.strictEqual(st.sequential.pairs.length, 1);
    pass('orphaned signups get a synthetic row, excluded from pairs');
  }

  console.log('All stats.js self-tests passed.');
}
