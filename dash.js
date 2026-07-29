'use strict';

// dash.js
// renderDash(stats, settings) -> one self-contained HTML string.
// Inline CSS only. No external requests. No client JS needed.

const { sampleSize } = require('./stats');

// Escape every interpolated string before it touches the HTML.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 0.1234 -> "12.3%"
function pct(x) {
  const v = Number.isFinite(x) ? x : 0;
  return (100 * v).toFixed(1) + '%';
}

// Thousands-grouped integer.
function num(x) {
  const v = Number.isFinite(Number(x)) ? Number(x) : 0;
  return v.toLocaleString('en-US');
}

function fmtP(p) {
  if (!Number.isFinite(p)) return 'n/a';
  if (p < 0.001) return '&lt; 0.001';
  return p.toFixed(3);
}

// Clamp a ratio to 0..100 for progress bar widths.
function barWidth(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, (100 * part) / whole)).toFixed(1);
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 20px 72px;
    background: #FFFFFF;
    color: #1E2B38;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.6;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 44px 0 14px; }
  h3 { font-size: 1.02rem; margin: 0 0 10px; }
  .meta { color: #51606E; font-size: 0.88rem; margin: 0 0 28px; }
  .eyebrow {
    color: #0C6B74;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0 0 6px;
  }
  .tiles { display: flex; flex-wrap: wrap; gap: 14px; }
  .tile {
    flex: 1 1 150px;
    background: #FFFFFF;
    border: 1px solid #E2E8EC;
    border-radius: 12px;
    padding: 16px 18px;
  }
  .tile .big { font-size: 1.9rem; font-weight: 700; line-height: 1.2; }
  .tile .small { color: #51606E; font-size: 0.86rem; }
  .tablewrap { overflow-x: auto; }
  table {
    border-collapse: collapse;
    width: 100%;
    background: #FFFFFF;
    border: 1px solid #E2E8EC;
    border-radius: 12px;
    font-size: 0.92rem;
  }
  th, td {
    text-align: right;
    padding: 10px 14px;
    border-bottom: 1px solid #E2E8EC;
    white-space: nowrap;
  }
  th { color: #51606E; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
  th:first-child, td:first-child { text-align: left; }
  tr:last-child td { border-bottom: none; }
  .muted { color: #51606E; font-size: 0.88rem; }
  .status { font-size: 0.78rem; color: #51606E; }
  .card {
    background: #FFFFFF;
    border: 1px solid #E2E8EC;
    border-radius: 12px;
    padding: 20px 22px;
    margin: 0 0 16px;
  }
  .bar {
    background: #E2E8EC;
    border-radius: 999px;
    height: 12px;
    overflow: hidden;
    margin: 6px 0 4px;
  }
  .fill { background: #0F3A47; height: 100%; border-radius: 999px; }
  .fill.soft { background: #B8D2D8; }
  .card.warn { border: 2px solid #D14E19; background: #FDF0EA; }
  .card.warn .eyebrow { color: #D14E19; }
  .verdict { font-weight: 700; margin: 14px 0 6px; }
  .verdict.win { color: #0F3A47; }
  .rules {
    margin-top: 48px;
    border-top: 1px solid #E2E8EC;
    padding-top: 20px;
    color: #51606E;
    font-size: 0.9rem;
  }
  .rules ul { margin: 8px 0 0; padding-left: 20px; }
  .rules li { margin: 4px 0; }
`;

// Plain-words verdict for a sequential pair.
function verdictWords(pair, labelOf) {
  const verdict = typeof pair.verdict === 'string' ? pair.verdict : '';
  if (verdict === 'no-winner') {
    return { cls: '', text: 'The test ended with no winner. Keep the control.' };
  }
  if (verdict.indexOf('winner:') === 0) {
    const id = verdict.slice('winner:'.length);
    return {
      cls: 'win',
      text: 'We have a winner: ' + esc(labelOf(id)) + '. The lead crossed the boundary.',
    };
  }
  return { cls: '', text: 'Still collecting. No decision yet.' };
}

function renderTiles(stats) {
  const t = stats.totals || { visitors: 0, signups: 0, deposits: 0 };
  const cvr = t.visitors > 0 ? t.signups / t.visitors : 0;
  const tiles = [
    ['Visitors', num(t.visitors), 'unique sessions'],
    ['Signups', num(t.signups), 'unique emails'],
    ['Overall CVR', pct(cvr), 'signups over visitors'],
    ['Deposit clicks', num(t.deposits), 'clicks on the reserve button'],
  ];
  return (
    '<div class="tiles">' +
    tiles
      .map(
        ([label, big, small]) =>
          '<div class="tile"><div class="eyebrow">' + esc(label) + '</div>' +
          '<div class="big">' + big + '</div>' +
          '<div class="small">' + esc(small) + '</div></div>'
      )
      .join('') +
    '</div>'
  );
}

function renderVariantTable(stats) {
  const rows = (stats.variants || [])
    .map((v) => {
      const ci = Array.isArray(v.cvrCI) ? v.cvrCI : [0, 0];
      return (
        '<tr>' +
        '<td>' + esc(v.label) + '<br><span class="status">' + esc(v.id) + ' &middot; ' + esc(v.status) + '</span></td>' +
        '<td>' + num(v.visitors) + '</td>' +
        '<td>' + num(v.scroll50) + '</td>' +
        '<td>' + num(v.scroll90) + '</td>' +
        '<td>' + num(v.formStarts) + '</td>' +
        '<td>' + num(v.signups) + '</td>' +
        '<td><strong>' + pct(v.cvr) + '</strong></td>' +
        '<td class="muted">' + pct(ci[0]) + ' to ' + pct(ci[1]) + '</td>' +
        '<td>' + num(v.depositClicks) + '</td>' +
        '<td>' + pct(v.depositCtr) + '</td>' +
        '</tr>'
      );
    })
    .join('');
  // Data-quality footnote: a clamped ratio means the identity spaces
  // disagree (blocked beacons or cleared cookies), and the reader should
  // know the number is a floor or ceiling, not a clean measurement.
  const flagged = (stats.variants || []).filter(
    (v) => v.signupsExceedVisitors || v.depositClicksExceedSignups
  );
  const footnote = flagged.length
    ? '<p class="muted">Data note: ' +
      flagged
        .map((v) => esc(v.label || v.id))
        .join(', ') +
      ' recorded more signups than tracked visits (or more deposit clicks than signups). ' +
      'Ratios for those rows are clamped at 100%. This usually means some visitors block tracking scripts.</p>'
    : '';
  return (
    '<div class="tablewrap"><table>' +
    '<tr><th>Variant</th><th>Visitors</th><th>Scroll 50%</th><th>Scroll 90%</th>' +
    '<th>Form starts</th><th>Signups</th><th>CVR</th><th>95% CI</th>' +
    '<th>Deposit clicks</th><th>Deposit CTR</th></tr>' +
    (rows || '<tr><td colspan="10" class="muted">No variants yet.</td></tr>') +
    '</table></div>' +
    footnote
  );
}

function renderSequential(stats, settings) {
  const seq = stats.sequential || { n: 0, boundary: 0, pairs: [] };
  const controlId = (settings && settings.control) || '';
  const labels = new Map((stats.variants || []).map((v) => [v.id, v.label || v.id]));
  const labelOf = (id) => labels.get(id) || id;
  const zByChallenger = new Map((stats.ztests || []).map((z) => [z.challenger, z]));

  if (seq.configError) {
    return (
      '<div class="card warn"><div class="eyebrow">Sequential test setup problem</div>' +
      '<p><strong>' + esc(seq.configError) + '</strong></p>' +
      '<p class="muted">No test can run until this is fixed. Edit settings.json, rebuild, and redeploy.</p></div>'
    );
  }

  if (!seq.pairs || seq.pairs.length === 0) {
    return (
      '<div class="card"><div class="eyebrow">Sequential test</div>' +
      '<p class="muted">No active challenger right now. Activate a second variant to start a test.</p></div>'
    );
  }

  return seq.pairs
    .map((pair) => {
      const total = pair.controlSignups + pair.challengerSignups;
      const v = verdictWords(pair, labelOf);
      const zt = zByChallenger.get(pair.challenger);
      const decided = pair.verdict && pair.verdict !== 'collecting';
      const sd = pair.sinceDecision || { control: 0, challenger: 0 };
      const sinceLine = decided
        ? '<p class="muted">The verdict froze when the rule was met. ' +
          'Signups since then: ' + num(sd.control) + ' for the control, ' +
          num(sd.challenger) + ' for the challenger. They do not change the verdict.</p>'
        : '';
      return (
        '<div class="card">' +
        '<div class="eyebrow">Sequential test &middot; N = ' + num(seq.n) + ' &middot; boundary = ' + num(seq.boundary) + '</div>' +
        '<h3>' + esc(labelOf(controlId)) + ' (control) vs ' + esc(labelOf(pair.challenger)) + '</h3>' +
        '<p>Control has ' + num(pair.controlSignups) + ' signups. ' +
        'Challenger has ' + num(pair.challengerSignups) + ' signups. ' +
        'The lead is ' + num(pair.lead) + '. ' +
        'A lead of ' + num(seq.boundary) + ' signups decides the test.</p>' +
        '<div class="muted">Lead: ' + num(pair.lead) + ' of ' + num(seq.boundary) + ' needed</div>' +
        '<div class="bar"><div class="fill" style="width:' + barWidth(pair.lead, seq.boundary) + '%"></div></div>' +
        '<div class="muted">Signups collected: ' + num(total) + ' of ' + num(seq.n) + '</div>' +
        '<div class="bar"><div class="fill soft" style="width:' + barWidth(total, seq.n) + '%"></div></div>' +
        '<p class="verdict ' + v.cls + '">' + v.text + '</p>' +
        sinceLine +
        '<p class="muted">Reference p-value: ' + (zt ? fmtP(zt.p) : 'n/a') + '. ' +
        'Decide with the sequential rule. The p-value is reference only. ' +
        'Do not stop a test on the p-value.</p>' +
        '</div>'
      );
    })
    .join('');
}

function renderSourceTable(stats) {
  const rows = (stats.bySource || [])
    .map(
      (s) =>
        '<tr><td>' + esc(s.source) + '</td>' +
        '<td>' + num(s.visitors) + '</td>' +
        '<td>' + num(s.signups) + '</td>' +
        '<td>' + pct(s.cvr) + '</td></tr>'
    )
    .join('');
  return (
    '<div class="tablewrap"><table>' +
    '<tr><th>Source</th><th>Visitors</th><th>Signups</th><th>CVR</th></tr>' +
    (rows || '<tr><td colspan="4" class="muted">No traffic yet.</td></tr>') +
    '</table></div>'
  );
}

function renderDailyTable(stats) {
  const last14 = (stats.daily || []).slice(-14).reverse(); // newest first
  const rows = last14
    .map(
      (d) =>
        '<tr><td>' + esc(d.date) + '</td>' +
        '<td>' + num(d.visitors) + '</td>' +
        '<td>' + num(d.signups) + '</td></tr>'
    )
    .join('');
  return (
    '<div class="tablewrap"><table>' +
    '<tr><th>Date (UTC)</th><th>Visitors</th><th>Signups</th></tr>' +
    (rows || '<tr><td colspan="3" class="muted">No days recorded yet.</td></tr>') +
    '</table></div>'
  );
}

// Fixed-horizon sample size line, for scale next to the sequential rule.
function renderContext(stats, settings) {
  const controlId = (settings && settings.control) || '';
  const control = (stats.variants || []).find((v) => v.id === controlId);
  const totals = stats.totals || { visitors: 0, signups: 0 };
  const baseline =
    control && control.cvr > 0
      ? control.cvr
      : totals.visitors > 0
        ? totals.signups / totals.visitors
        : 0;
  if (!(baseline > 0) || baseline >= 1) {
    return '<p class="muted">No conversions yet, so there is no baseline CVR to size a fixed test against.</p>';
  }
  const perArm = sampleSize(baseline, 0.2);
  return (
    '<p class="muted">For scale: a classic fixed test at the current control CVR of ' +
    pct(baseline) + ' needs about ' + num(perArm) +
    ' visitors per arm to detect a 20% lift. The sequential rule decides on signups instead.</p>'
  );
}

function renderRules() {
  return (
    '<div class="rules"><div class="eyebrow">Testing rules</div>' +
    '<ul>' +
    '<li>Run at most 2 variants live at a time.</li>' +
    '<li>Run full weeks only. Start and stop on the same weekday.</li>' +
    '<li>Pre-register the stop rule before the test starts. Write down N and the boundary.</li>' +
    '<li>Do not peek and stop early. The boundary is the only early stop.</li>' +
    '</ul></div>'
  );
}

function renderDash(stats, settings) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const product = cfg.productName || 'Capstan';

  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    '<title>' + esc(product) + ' funnel dashboard</title>\n' +
    '<style>' + CSS + '</style>\n' +
    '</head>\n<body>\n<div class="wrap">\n' +
    '<div class="eyebrow">' + esc(cfg.companyName || 'HumanKind Bionics') + '</div>\n' +
    '<h1>' + esc(product) + ' funnel dashboard</h1>\n' +
    '<p class="meta">Generated ' + esc(s.generatedAt || '') + ' (UTC)</p>\n' +
    renderTiles(s) +
    '<h2>Variant funnel</h2>\n' + renderVariantTable(s) +
    '<h2>Sequential test</h2>\n' + renderSequential(s, cfg) + renderContext(s, cfg) +
    '<h2>By source</h2>\n' + renderSourceTable(s) +
    '<h2>Daily, last 14 days</h2>\n' + renderDailyTable(s) +
    renderRules() +
    '\n</div>\n</body>\n</html>\n'
  );
}

module.exports = { renderDash };

// ---------------------------------------------------------------------------
// Smoke test: node dash.js writes nothing, just checks rendering.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const assert = require('assert');
  const { computeStats } = require('./stats');
  const settings = {
    productName: 'Capstan',
    companyName: 'HumanKind Bionics',
    control: 'capstan-cmt',
    sequentialN: 300,
  };
  const variants = [
    { id: 'capstan-cmt', label: 'CMT category angle', status: 'active' },
    { id: 'capstan-independence', label: 'Outcome angle', status: 'active' },
  ];
  const events = [
    { t: '2026-07-20T10:00:00Z', e: 'pageview', v: 'capstan-cmt', sid: 's1', utm: { source: 'reddit' } },
    { t: '2026-07-20T11:00:00Z', e: 'pageview', v: 'capstan-independence', sid: 's2' },
    { t: '2026-07-20T11:05:00Z', e: 'form_start', v: 'capstan-independence', sid: 's2' },
    { t: '2026-07-21T09:00:00Z', e: 'pageview', v: 'capstan-cmt', sid: 's3' },
    { t: '2026-07-21T09:05:00Z', e: 'deposit_click', v: 'capstan-independence', sid: 's2' },
  ];
  const subs = [
    { t: '2026-07-20T11:06:00Z', email: 'a@b.com', v: 'capstan-independence', sid: 's2' },
  ];
  const html = renderDash(computeStats(events, subs, settings, variants), settings);
  assert(html.indexOf('<script') === -1, 'no client JS');
  assert(html.indexOf('http://') === -1 && html.indexOf('https://') === -1, 'no external requests');
  assert(html.indexOf('Capstan funnel dashboard') !== -1);
  assert(html.indexOf('Do not stop a test on the p-value.') !== -1);
  assert(html.indexOf('Still collecting. No decision yet.') !== -1);
  assert(html.indexOf('reddit') !== -1);
  assert(html.indexOf('2026-07-21') !== -1);
  assert(html.indexOf('Run at most 2 variants live at a time.') !== -1);
  assert(renderDash({}, {}).indexOf('No variants yet.') !== -1, 'empty stats renders');
  assert(esc('<a b="c">&\'') === '&lt;a b=&quot;c&quot;&gt;&amp;&#39;', 'esc');

  // configError renders a visible warning card.
  const broken = computeStats(events, subs, { control: 'missing-id', sequentialN: 300 }, variants);
  const warnHtml = renderDash(broken, { control: 'missing-id' });
  assert(warnHtml.indexOf('card warn') !== -1, 'warning card present');
  assert(warnHtml.indexOf('Sequential test setup problem') !== -1, 'warning heading present');
  assert(warnHtml.indexOf('missing-id') !== -1, 'bad control id shown');

  console.log('PASS dash.js renders self-contained HTML (' + html.length + ' bytes)');
}
