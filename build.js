#!/usr/bin/env node
/**
 * build.js
 * Renders variants/*.json through template/page.html and template/thanks.html
 * into dist/<variantId>/, copies shared.css and assets/, and embeds the
 * event-beacon snippet into every page. Zero dependencies. Node 18+.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE_DIR = path.join(ROOT, 'template');
const VARIANTS_DIR = path.join(ROOT, 'variants');
const ASSETS_DIR = path.join(ROOT, 'assets');
const DIST = path.join(ROOT, 'dist');

const SCOPE_LINE = 'Capstan is a mechanical grip aid. It does not treat or slow CMT.';

// ---------------------------------------------------------------------------
// Event-beacon snippet (defined ONCE, embedded in both templates).
// Sends events with navigator.sendBeacon, falls back to fetch keepalive.
// De-dupes every event per page load.
// ---------------------------------------------------------------------------
const EVENT_SNIPPET = `
(function () {
  'use strict';

  function cookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  var page = document.body.getAttribute('data-cf-page') || 'landing';
  var variant = cookie('cf_v') || document.body.getAttribute('data-cf-variant') || '';
  var sent = {};

  // Send one named event, at most once per page load.
  function send(name, meta) {
    if (sent[name]) return;
    sent[name] = true;
    var row = { e: name, v: variant };
    if (meta) row.meta = meta;
    var body = JSON.stringify(row);
    var delivered = false;
    try {
      if (navigator.sendBeacon) {
        delivered = navigator.sendBeacon('/e', new Blob([body], { type: 'application/json' }));
      }
    } catch (err) {
      delivered = false;
    }
    if (!delivered) {
      try {
        fetch('/e', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        });
      } catch (err) { /* nothing else to try */ }
    }
  }

  if (page === 'thanks') {
    send('ty_pageview');

    // Position number from /thanks?n=123
    var match = /[?&]n=(\\d+)/.exec(window.location.search);
    if (match) {
      var slot = document.getElementById('position-number');
      var line = document.getElementById('position-line');
      if (slot && line) {
        slot.textContent = match[1];
        line.hidden = false;
      }
    }

    var deposit = document.getElementById('deposit-link');
    if (deposit) {
      deposit.addEventListener('click', function () { send('deposit_click'); });
    }

    var community = document.getElementById('community-link');
    if (community) {
      community.addEventListener('click', function () { send('community_click'); });
    }

    // The share link and mailto body are baked into the page at build time
    // (settings.siteUrl), so sharing also works with JS turned off.
    var shareEl = document.getElementById('share-url');
    var shareUrl = (shareEl && shareEl.textContent) || (window.location.origin + '/');

    var mail = document.getElementById('share-mail');
    if (mail) {
      mail.addEventListener('click', function () { send('share_click'); });
    }

    var copyBtn = document.getElementById('copy-link');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        send('share_click');
        function done() {
          var note = document.getElementById('copy-done');
          if (note) note.hidden = false;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareUrl).then(done, done);
        } else {
          var scratch = document.createElement('textarea');
          scratch.value = shareUrl;
          document.body.appendChild(scratch);
          scratch.select();
          try { document.execCommand('copy'); } catch (err) { /* best effort */ }
          document.body.removeChild(scratch);
          done();
        }
      });
    }

    // Micro-survey: post answers as JSON, swap in a thank-you note.
    var survey = document.getElementById('survey');
    if (survey) {
      survey.addEventListener('submit', function (event) {
        event.preventDefault();
        var data = new FormData(survey);
        var answers = {
          who: String(data.get('who') || ''),
          hand: String(data.get('hand') || ''),
          hsafsa: String(data.get('hsafsa') || '')
        };
        try {
          fetch('/survey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(answers),
            keepalive: true
          });
        } catch (err) { /* best effort */ }
        survey.hidden = true;
        var doneNote = document.getElementById('survey-done');
        if (doneNote) doneNote.hidden = false;
      });
    }
  } else {
    send('pageview');

    function checkScroll() {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? window.scrollY / max : 1;
      if (ratio >= 0.5) send('scroll_50');
      if (ratio >= 0.9) send('scroll_90');
      if (sent.scroll_50 && sent.scroll_90) {
        window.removeEventListener('scroll', checkScroll);
      }
    }
    window.addEventListener('scroll', checkScroll, { passive: true });
    checkScroll();

    // form_start fires on the first focus of any email input.
    var emailInputs = document.querySelectorAll('input[type="email"]');
    for (var i = 0; i < emailInputs.length; i++) {
      emailInputs[i].addEventListener('focus', function () { send('form_start'); });
    }

    // form_submit fires before the native POST; sendBeacon survives navigation.
    var forms = document.querySelectorAll('form.signup');
    for (var j = 0; j < forms.length; j++) {
      forms[j].addEventListener('submit', function () { send('form_submit'); });
    }

    // Sticky mobile CTA: show once the hero has scrolled out of view.
    // A plain scroll check beats IntersectionObserver here: it works the
    // same in every browser, old or new, and never depends on rendering
    // frames being delivered.
    var bar = document.getElementById('sticky-cta');
    var hero = document.getElementById('hero');
    if (bar) {
      if (hero) {
        var checkBar = function () {
          var heroGone = hero.getBoundingClientRect().bottom < 0;
          bar.classList.toggle('show', heroGone);
        };
        window.addEventListener('scroll', checkBar, { passive: true });
        window.addEventListener('resize', checkBar, { passive: true });
        checkBar();
      } else {
        bar.classList.add('show'); // plain sticky fallback
      }
    }
  }
})();
`.trim();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error('build failed:\n' + message);
  process.exit(1);
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(file + ' could not be read: ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(file + ' is not valid JSON: ' + err.message);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// {{key}} substitution. Every placeholder in the template must exist in map.
function render(template, map, templateName) {
  const unknown = [];
  const out = template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in map)) {
      unknown.push(key);
      return whole;
    }
    return map[key];
  });
  if (unknown.length) {
    fail(templateName + ' has placeholders with no value: ' + unknown.join(', '));
  }
  return out;
}

// Array -> HTML fragment helpers
function parasHtml(paragraphs) {
  return paragraphs.map((p) => '<p>' + escapeHtml(p) + '</p>').join('\n      ');
}

function stepsHtml(steps) {
  return steps
    .map(
      (s) =>
        '<li><span class="step-n" aria-hidden="true">' + escapeHtml(s.n) + '</span>' +
        '<h3>' + escapeHtml(s.head) + '</h3>' +
        '<p>' + escapeHtml(s.body) + '</p></li>'
    )
    .join('\n        ');
}

function bulletsHtml(bullets) {
  return bullets.map((b) => '<li>' + escapeHtml(b) + '</li>').join('\n        ');
}

function faqHtml(faq) {
  return faq
    .map(
      (item) =>
        '<details><summary>' + escapeHtml(item.q) + '</summary>' +
        '<div class="answer"><p>' + escapeHtml(item.a) + '</p></div></details>'
    )
    .join('\n      ');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PAGE_STRING_KEYS = [
  'title', 'metaDescription', 'eyebrow', 'h1', 'lead', 'heroProof', 'ctaLabel',
  'heroImage', 'heroImageAlt', 'problemHead', 'whyHead', 'proofHead',
  'proofStory', 'proofLab', 'proofCreds', 'offerHead', 'finalHead', 'scopeLine'
];
const PAGE_ARRAY_KEYS = ['problemBody', 'whyBody', 'steps', 'offerBullets', 'faq'];

function validateVariant(variant, file) {
  const problems = [];
  const where = path.basename(file);

  for (const key of ['id', 'label', 'status', 'weight', 'page']) {
    if (!(key in variant)) problems.push(where + ': missing key "' + key + '"');
  }
  if (variant.status && variant.status !== 'active' && variant.status !== 'paused') {
    problems.push(where + ': status must be "active" or "paused", got "' + variant.status + '"');
  }
  const page = variant.page;
  if (!page || typeof page !== 'object') {
    problems.push(where + ': missing or invalid "page" object');
    return problems; // nothing more to check
  }

  for (const key of PAGE_STRING_KEYS) {
    if (typeof page[key] !== 'string' || page[key].trim() === '') {
      problems.push(where + ': missing page key "' + key + '"');
    }
  }
  for (const key of PAGE_ARRAY_KEYS) {
    if (!Array.isArray(page[key]) || page[key].length === 0) {
      problems.push(where + ': page key "' + key + '" must be a non-empty array');
    }
  }
  if (Array.isArray(page.steps)) {
    if (page.steps.length !== 3) {
      problems.push(where + ': "steps" must have exactly 3 items, got ' + page.steps.length);
    }
    page.steps.forEach((s, i) => {
      for (const key of ['n', 'head', 'body']) {
        if (!s || !(key in s)) problems.push(where + ': steps[' + i + '] missing "' + key + '"');
      }
    });
  }
  if (Array.isArray(page.faq)) {
    if (page.faq.length < 7 || page.faq.length > 9) {
      problems.push(where + ': "faq" must have 7 to 9 items, got ' + page.faq.length);
    }
    page.faq.forEach((item, i) => {
      for (const key of ['q', 'a']) {
        if (!item || typeof item[key] !== 'string' || item[key].trim() === '') {
          problems.push(where + ': faq[' + i + '] missing "' + key + '"');
        }
      }
    });
  }

  // Hard copy rules: exact scope line, no em or en dashes in any string.
  // (dash characters written as escapes so this file stays dash-free too)
  if (typeof page.scopeLine === 'string' && page.scopeLine !== SCOPE_LINE) {
    problems.push(where + ': scopeLine must be exactly: ' + SCOPE_LINE);
  }
  if (new RegExp("[\\u2013\\u2014]").test(JSON.stringify(variant))) {
    problems.push(where + ': copy contains an em dash or en dash; remove it');
  }

  return problems;
}

function validateSettings(settings) {
  const problems = [];
  const required = [
    'productName', 'companyName', 'contactEmail', 'stripeLink', 'communityUrl',
    'webhookUrl', 'clarityId', 'siteUrl', 'control', 'sequentialN',
    'priceRetail', 'priceFounding', 'depositAmount', 'firstRunUnits'
  ];
  for (const key of required) {
    if (!(key in settings)) problems.push('settings.json: missing key "' + key + '"');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function main() {
  const settings = readJson(path.join(ROOT, 'settings.json'));

  // Env vars override settings (same names the server honors).
  const stripeLink = process.env.STRIPE_LINK || settings.stripeLink || '';
  const communityUrl = process.env.COMMUNITY_URL || settings.communityUrl || '';

  // Public site URL, baked into the thanks-page share block so sharing works
  // without JS and in mail clients.
  const siteUrl = String(settings.siteUrl || '').trim();
  if (siteUrl && !/^https?:\/\/[^\s"'<>]+$/.test(siteUrl)) {
    fail('settings.json: siteUrl must be a plain http(s) URL');
  }

  // Microsoft Clarity: injected into the <head> of every built page when
  // clarityId is a non-empty string. Empty string injects nothing.
  const clarityId = String(settings.clarityId || '').trim();
  if (clarityId && !/^[A-Za-z0-9]+$/.test(clarityId)) {
    fail('settings.json: clarityId must contain only letters and numbers');
  }
  const claritySnippet = clarityId
    ? '<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "' + clarityId + '");</script>'
    : '';
  const withClarity = (html) =>
    claritySnippet ? html.replace('</head>', '  ' + claritySnippet + '\n</head>') : html;

  const pageTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, 'page.html'), 'utf8');
  const thanksTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, 'thanks.html'), 'utf8');

  const variantFiles = fs
    .readdirSync(VARIANTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (variantFiles.length === 0) fail('no variant configs found in variants/');

  const variants = variantFiles.map((f) => ({
    file: path.join(VARIANTS_DIR, f),
    config: readJson(path.join(VARIANTS_DIR, f))
  }));

  // Validate everything first; report every problem at once.
  let problems = validateSettings(settings);
  for (const v of variants) {
    problems = problems.concat(validateVariant(v.config, v.file));
  }
  if (problems.length) fail(problems.join('\n'));

  if (!variants.some((v) => v.config.id === settings.control)) {
    console.warn('warning: settings.control "' + settings.control + '" does not match any variant id');
  }

  // Fresh dist/
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Static files
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'shared.css'), path.join(DIST, 'shared.css'));
  if (fs.existsSync(ASSETS_DIR)) {
    fs.cpSync(ASSETS_DIR, path.join(DIST, 'assets'), { recursive: true });
  }

  const snippetHtml = '<script>\n' + EVENT_SNIPPET + '\n</script>';

  // Thank-you page blocks depend only on settings, build them once.
  const depositBlockHtml = stripeLink
    ? '<a id="deposit-link" class="btn" href="' + escapeHtml(stripeLink) + '">' +
      'Reserve my glove for $' + escapeHtml(settings.depositAmount) + '</a>'
    : '<p><strong>Reservations open soon. You are on the list.</strong></p>';

  const communityBlockHtml = communityUrl
    ? '<p>A private group for the first ' + escapeHtml(settings.firstRunUnits) +
      ' members. Build updates, fitting news, and honest answers.</p>' +
      '<a id="community-link" class="btn btn-secondary" href="' + escapeHtml(communityUrl) + '">' +
      'Join The Founding 500</a>'
    : '<p><strong>The Founding 500 group opens soon.</strong></p>';

  // Share block: the mailto link and the plain-text link both carry siteUrl,
  // so they work with JS turned off.
  const shareMailHref = 'mailto:?subject=' +
    encodeURIComponent('A grip glove for hands made weak by CMT') +
    '&body=' +
    encodeURIComponent(
      'I found a glove that adds grip force for hands made weak by CMT. ' +
      'It is called Capstan, by HumanKind Bionics. Take a look: ' + siteUrl
    );

  for (const v of variants) {
    const config = v.config;
    const page = config.page;

    const map = {
      // settings-level values
      variantId: escapeHtml(config.id),
      productName: escapeHtml(settings.productName),
      companyName: escapeHtml(settings.companyName),
      contactEmail: escapeHtml(settings.contactEmail),
      priceRetail: escapeHtml(settings.priceRetail),
      priceFounding: escapeHtml(settings.priceFounding),
      depositAmount: escapeHtml(settings.depositAmount),
      firstRunUnits: escapeHtml(settings.firstRunUnits),
      // pre-built HTML fragments
      problemBodyHtml: parasHtml(page.problemBody),
      whyBodyHtml: parasHtml(page.whyBody),
      stepsHtml: stepsHtml(page.steps),
      offerBulletsHtml: bulletsHtml(page.offerBullets),
      faqHtml: faqHtml(page.faq),
      depositBlockHtml: depositBlockHtml,
      communityBlockHtml: communityBlockHtml,
      siteUrl: escapeHtml(siteUrl),
      shareMailHref: escapeHtml(shareMailHref),
      eventSnippet: snippetHtml
    };
    // variant copy strings, escaped
    for (const key of PAGE_STRING_KEYS) {
      map[key] = escapeHtml(page[key]);
    }

    const outDir = path.join(DIST, config.id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), withClarity(render(pageTemplate, map, 'page.html')));
    fs.writeFileSync(path.join(outDir, 'thanks.html'), withClarity(render(thanksTemplate, map, 'thanks.html')));
    console.log('built dist/' + config.id + '/ (' + config.status + ')');
  }

  console.log('done: ' + variants.length + ' variants, shared.css and assets copied');
}

main();
