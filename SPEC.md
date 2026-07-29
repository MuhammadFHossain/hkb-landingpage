# Capstan Funnel: System Spec

Internal lead-gen funnel platform for HumanKind Bionics. One Node server, zero npm dependencies, JSONL storage. Generates landing page variants from JSON configs, splits traffic with sticky cookies, records events, and shows a stats dashboard with honest sequential testing.

Target runtime: Node 18+. No external packages. No build tooling beyond `node build.js`.

## File layout

```
capstan-funnel/
  SPEC.md               this file
  README.md             run, deploy, wire-in guide
  package.json          scripts only, zero dependencies
  settings.json         site-wide settings (see schema below)
  build.js              renders variants -> dist/
  server.js             http server: split, static, subscribe, events, dashboard
  stats.js              pure functions: funnel aggregation + statistics
  dash.js               renderDash(stats, settings) -> HTML string
  template/page.html    landing page template with {{placeholders}}
  template/thanks.html  thank-you page template
  template/shared.css   design system css
  variants/*.json       one file per variant
  assets/               hero media, favicon (copied to dist by build)
  dist/                 generated output (git-ignorable)
  data/                 events.jsonl, subscribers.jsonl (created at runtime)
```

## settings.json schema

```json
{
  "productName": "Capstan",
  "companyName": "HumanKind Bionics",
  "contactEmail": "contact@humankindbionics.com",
  "stripeLink": "",
  "communityUrl": "",
  "webhookUrl": "",
  "clarityId": "xtssf778gc",
  "siteUrl": "https://humankindbionics.com",
  "control": "capstan-cmt",
  "sequentialN": 300,
  "priceRetail": 399,
  "priceFounding": 349,
  "depositAmount": 25,
  "firstRunUnits": 500
}
```

Env vars override settings: `PORT` (default 4870), `DASH_KEY` (required for /dash; default "letmein" with a loud console warning), `WEBHOOK_URL`, `STRIPE_LINK`, `COMMUNITY_URL`.

Server-only env vars:
- `TRUST_PROXY`: comma-separated IPs of reverse proxies the server sits behind. Default empty, which means `X-Forwarded-For` is ignored and the socket address is always used for rate limiting. When the socket peer IS listed, the server uses the LAST untrusted hop of `X-Forwarded-For` (the value the trusted proxy appended), never the first token.
- `COOKIE_SECURE`: "1" or "true" adds the `Secure` attribute to every cookie. `Secure` is also added automatically when `x-forwarded-proto: https` is present. Plain-http localhost keeps working with neither.

`clarityId`: Microsoft Clarity project id. When it is a non-empty string, build.js injects the Clarity tag into the `<head>` of every built page (landing and thanks). When empty, nothing is injected. Note: `www.clarity.ms` is the second allowed external origin, besides Google Fonts.

`siteUrl`: the public URL of the live site. build.js bakes it into the thanks-page share block: the mailto body and the plain-text "send this link" line, so sharing works without JS.

## Variant config schema (variants/*.json)

```json
{
  "id": "capstan-cmt",
  "label": "CMT category angle",
  "status": "active",            // "active" | "paused"
  "weight": 1,                    // relative traffic share among active
  "page": {
    "title": "...", "metaDescription": "...",
    "eyebrow": "...", "h1": "...", "lead": "...",
    "heroProof": "...",           // short line under CTA, e.g. scarcity line
    "ctaLabel": "Save my spot",
    "gallery": [{"src":"hero.webp","alt":"...","caption":"Open a jar"}, ...],
                                  // horizontal photo strip in the hero; placeholders
                                  // live in assets/ph-*.svg until real shots exist
    "problemHead": "...", "problemBody": ["para", "para"],
    "whyHead": "...", "whyBody": ["para", "para"],
    "whyStats": [{"big":"4 in 10","small":"wear a leg brace"}, ...],
                                  // big scannable stat tiles under whyBody
    "steps": [{"n":1,"head":"...","body":"..."}, ...3 items],
    "proofHead": "...",
    "proofStory": "...",          // Mushruf paragraph, relationship disclosed
    "proofLab": "...",            // MUST label 8N->31N as one user, lab, not typical
    "proofCreds": "...",          // Apple hardware team, Red Dot, patent filed
    "offerHead": "...", "offerBullets": ["...", ...],
    "faq": [{"q":"...","a":"..."}, ... 7-9 items],
    "finalHead": "...",
    "scopeLine": "Capstan is a mechanical grip aid. It does not treat or slow CMT."
  }
}
```

build.js validates required fields and fails loudly on missing ones.

## build.js

- Reads settings.json + all variants/*.json (including paused; paused builds but gets no traffic).
- Renders template/page.html per variant with `{{key}}` substitution (simple string replace; arrays like steps/faq/problemBody rendered by small helper functions in build.js, injected as `{{stepsHtml}}`, `{{faqHtml}}`, etc.).
- Renders template/thanks.html once per variant to dist/<id>/thanks.html (thanks copy is shared; variant id baked in for event attribution).
- Copies template/shared.css -> dist/shared.css and assets/* -> dist/assets/.
- Injects a small inline JS snippet (defined once in build.js, embedded in both templates) that: reads variant id + session id, sends events via `navigator.sendBeacon('/e', ...)` with fetch fallback: pageview on load, scroll_50 / scroll_90 once each, form_start on first focus of email input, ty_pageview / deposit_click / community_click / share_click on the thanks page. De-dupes per page load.
- When settings.clarityId is a non-empty string, injects the Microsoft Clarity tag into the `<head>` of every built page (landing and thanks). Empty string injects nothing.
- Bakes settings.siteUrl into the thanks-page share block: the mailto body and the plain-text "send this link" line, so sharing works without JS.
- Output: dist/<variantId>/index.html for each variant.

## server.js endpoints

- `GET /` : split. Read cookie `cf_v`. If absent or names a non-active variant, pick weighted random among active variants, set cookie (180 days, SameSite=Lax, HttpOnly NOT set because client JS needs to read it for events; that is acceptable, it holds no PII). `?v=<id>` query forces that variant and sets cookie (QA use). Then serve dist/<id>/index.html (200, no redirect, URL stays /).
- First touch UTM: if any `utm_*` params present and cookie `cf_utm` absent, store `{source,medium,campaign,content}` JSON in `cf_utm` cookie (180 days).
- `GET /thanks` : serve dist/<cf_v>/thanks.html (fall back to control).
- `GET /shared.css`, `GET /assets/*` : static from dist. **Path traversal protection required**: resolve and verify the resolved path starts with the dist root; reject `..`, encoded traversal, null bytes. Only GET/HEAD.
- `POST /subscribe` : accepts form-encoded or JSON `{email, hp}`. `hp` is a honeypot field: if non-empty, respond 303 to /thanks normally but do not store (silent discard). Honeypot check and email validation happen BEFORE any storage write. Validate email with a sane regex, lowercase, trim. Read variant + sid + utm from cookies. The server keeps an in-memory subscriber index (email -> position + sid) loaded once at startup from data/subscribers.jsonl and updated on every append; no request handler reads the file. New email: append `{t, email, v, sid, utm}` to data/subscribers.jsonl, position = count of unique emails, fire the webhook. Known email: never write a duplicate row and never re-fire the webhook; echo the stored position ONLY when the request's `cf_sid` matches the sid stored on the original row, otherwise respond with current unique count + 1 (this stops outsiders from probing whether an email is on the list). Webhook: if WEBHOOK_URL set, POST the record there for newly added emails only (fire and forget, 2s timeout, `redirect: 'error'`, failures logged not fatal). Respond 303 Location `/thanks?n=<position>`. Rate limit: in-memory, max 5 POSTs per IP per minute, 429 beyond.
- `POST /e` : event beacon. Body JSON `{e, meta?}`. Allowed event names only (whitelist): pageview, scroll_50, scroll_90, form_start, form_submit, ty_pageview, deposit_click, community_click, share_click, survey. Attach server-side: t (ISO), v (cookie), sid (cookie `cf_sid`, create if absent: random 16 hex), utm (cookie). Append to data/events.jsonl. Cap body at 4KB. Respond 204. Strings sanitized: strip control chars, cap meta at 512 chars serialized (prevents JSONL injection: always JSON.stringify the whole row, never concatenate).
- `POST /survey` : `{who, hand, hsafsa}` from thanks-page micro-survey -> stored as event `survey` with meta. 204.
- `GET /dash?key=...` : requires key === DASH_KEY. Reads both JSONL files, calls stats.js, renders via dash.js. No-cache headers.
- `GET /api/stats?key=...` : same auth, returns the stats object as JSON.
- `GET /healthz` : 200 "ok".
- Everything else: 404. Never serve SPEC.md, data/, variants/, server source.

Form in page.html posts natively to /subscribe (works without JS). The event snippet additionally fires form_submit before submit.

## stats.js contracts (pure, no I/O)

```js
parseJsonl(text) -> row[]                       // tolerant: skips bad lines
computeStats(events, subscribers, settings, variants) -> stats
```

`stats` shape:
```js
{
  generatedAt, totals: {visitors, signups, deposits},
  variants: [{
    id, label, status,
    visitors,          // unique sid with pageview
    scroll50, scroll90, formStarts,
    signups,           // unique emails attributed to variant
    tyViews, depositClicks, communityClicks,
    cvr, cvrCI: [lo, hi],          // Wilson 95%
    depositCtr                      // depositClicks / signups
  }],
  bySource: [{source, visitors, signups, cvr}],
  daily: [{date, visitors, signups}],
  sequential: {                     // control vs each active challenger
    n: settings.sequentialN,
    boundary: Math.ceil(2.25 * Math.sqrt(N)),
    configError,                    // string, present ONLY when settings.control
                                    // is missing or matches no variant; then
                                    // pairs is [] and ztests is []
    pairs: [{challenger, controlSignups, challengerSignups, lead, verdict,
             sinceDecision: {control, challenger}}]
    // verdict: "collecting" | "winner:<id>" | "no-winner"
    // Decided by chronological replay of email-deduped signups for the pair,
    // sorted by t. The verdict FREEZES at the first boundary crossing
    // (winner) or when the pair reaches N total signups (no-winner).
    // controlSignups/challengerSignups/lead report the frozen counts once
    // decided; signups after the freeze go into sinceDecision and can never
    // change the verdict. While collecting, counts and lead are the live
    // snapshot, used for the progress display only.
  },
  ztests: [{challenger, p, note}]   // two-proportion z vs control, reference only
}
```

Math definitions:
- Wilson 95% interval, z=1.96, standard formula.
- Two-proportion z-test, pooled SE, two-sided p via erf-based normal CDF (implement erf approximation, Abramowitz-Stegun 7.1.26 is fine).
- Evan Miller simple sequential rule (evanmiller.org/sequential-ab-testing.html): pre-chosen N conversions; if |controlSignups - challengerSignups| >= ceil(2.25 * sqrt(N)), the leader wins; if controlSignups + challengerSignups >= N with no crossing, stop with no winner. Dashboard must state: "Decide with the sequential rule. The p-value is reference only. Do not stop a test on the p-value."

Also export `sampleSize(baselineCvr, relLift)` (classic two-proportion, alpha .05 two-sided, power .8) used by dash to show context.

## dash.js

`renderDash(stats, settings) -> html`. Self-contained HTML (inline CSS, no external requests). Sections: headline totals; per-variant funnel table (visitors -> form starts -> signups -> deposit clicks, with CVR + CI); sequential test card per challenger with progress toward boundary and verdict in plain words (decided cards also show the frozen counts and the signups since the decision); source table; daily table (last 14 days); a short "rules" footer (max 2 variants live, full weeks, pre-registered stop, don't peek). When `stats.sequential.configError` is set, the dashboard renders a visible warning card in its place. Readable, no JS needed.

## Design system (template/shared.css)

Tokens: bg #FAF6EC; ink #2E2C26; soft ink #5A574C; CTA #3D4A33 (cream text #FAF6EC); gold eyebrow #C09B3A; line #E4DCC8. Fonts via Google Fonts: Fraunces (display, 600) + Inter (body). Body 19px/1.6 desktop, 18px mobile, max-width 68ch. H1 clamp(2rem, 5vw, 3.2rem). Buttons min-height 56px, min-width 200px, radius 999px, font-size 19px. Email input min-height 56px, 18px+, autocomplete="email", inputmode="email". Contrast: all text >= 4.5:1 on bg (ink and soft ink both pass on #FAF6EC; verify). Focus states visible (3px outline). No hover-only affordances, no carousels, no animation beyond subtle. FAQ uses native <details>/<summary> with 56px summary rows. Sticky mobile bottom bar (appears after hero via IntersectionObserver in the snippet; plain sticky fallback) with one CTA scrolling to the form. Zero external links anywhere on the page; footer has contact email as plain text, privacy in a <details> block, and the scope line. `prefers-reduced-motion` respected. Allowed external origins are exactly two: Google Fonts (fonts.googleapis.com / fonts.gstatic.com) and Microsoft Clarity (www.clarity.ms, only when clarityId is set).

## Copy rules (hard requirements, apply to every string in variants and templates)

- Grade 5 to 7 reading level. Short sentences.
- No em dashes anywhere. No personification of the product (the glove does not "want," "love," or "care"). No AI-trope phrasing ("unleash", "elevate", "seamless", "game-changer").
- Privacy line exactly: "We guarantee 100% privacy. Your information will not be shared." Never the word "spam".
- 8N to 31N must always appear as: one user, measured in our lab, not a typical result.
- No FDA mentions. No treatment/cure/progression claims. Scope line required on every page.
- Deposit language on thanks page: "reservation", "fully refundable, any time, for any reason", "credited toward your glove", "This is not a purchase." Never "pre-order", never "buy now".
- Scarcity only if true: "First production run: 500 gloves." Founding price $349 locked (retail $399).
- Thanks page order: 1) confirmation + position number, 2) $25 refundable reservation block (primary, uses STRIPE_LINK; if unset show "Reservations open soon. You are on the list."), 3) referral/share block ("Know someone else with CMT? CMT runs in families." copy-link + mailto), 4) community block (COMMUNITY_URL; if unset, "The Founding 500 group opens soon."), 5) 3-question micro-survey (who is this for: me / a parent / someone else; which hand: left / right / both; would HSA or FSA eligibility matter: yes / no / not sure) posting to /survey.

## Three shipped variants

1. `capstan-cmt` (active, control): category/mechanism angle. H1 "Grip again. No motor, no battery, no surgery." CMT named in eyebrow.
2. `capstan-independence` (active): outcome angle. H1 leads with tasks: jars, keys, buttons, signing your name. CMT named.
3. `capstan-founder` (paused, example): credibility angle. Built by an Apple Vision Pro hardware engineer for his friend with CMT.

All three use the verbatim patient vocabulary from CAPSTAN_GTM_PLAYBOOK.md section 2 and follow the 8-section order from section 4.

## Security requirements

- Static serving confined to dist/ (resolve + prefix check, reject traversal).
- JSONL rows always produced by JSON.stringify of a constructed object.
- Event name whitelist; body size caps (4KB events, 8KB subscribe); in-memory rate limits (subscribe 5/min/IP, events 60/min/IP). Each limiter map is capped at 50,000 tracked IPs; at the cap the entry with the oldest reset is evicted first.
- Rate-limit identity: the socket address, unless the peer is listed in `TRUST_PROXY` (see env vars above). `X-Forwarded-For` from an untrusted peer is never believed.
- Dashboard and stats API behind DASH_KEY (query param acceptable for internal tool; note in README to use a long random key and https).
- No secrets in client HTML. Honeypot field on the form. Emails stored only in subscribers.jsonl.
```
