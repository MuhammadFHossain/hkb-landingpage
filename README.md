# Capstan Funnel

## What this is

A small lead-gen site for Capstan by HumanKind Bionics. It serves landing page variants, splits traffic between them, collects emails and events, and shows a private dashboard that tells you which variant is winning. It is one Node server with zero npm packages. You edit JSON files, rebuild, and deploy.

## Quickstart

```
node build.js
DASH_KEY=your-secret node server.js
```

Then open:

- Site: http://localhost:4870
- Dashboard: http://localhost:4870/dash?key=your-secret

Run `node stats.js` any time to check the math self-tests.

## Deploy on Render

The code lives at `git@github.com:MuhammadFHossain/hkb-landingpage.git`.

1. In Render, create a new **Web Service** from that GitHub repo.
2. Build command: `node build.js`
3. Start command: `node server.js`
4. Environment variables:
   - `DASH_KEY`: a long random string (30+ characters). This is the only lock on your dashboard and your signup data.
   - `COOKIE_SECURE`: `1` (the live site runs on https).
   - `TRUST_PROXY`: Render puts a proxy in front of your app. If rate limiting ever looks wrong (many users blocked at once), set this to the proxy IP shown in your request logs. Leaving it empty is safe; it just rate-limits by the proxy address.
5. Add your custom domain (humankindbionics.com) in Render's settings. Render issues the TLS certificate for you.

Every push to the repo triggers a new deploy.

## Wire-in checklist

All of these live in `settings.json`. Rebuild and push after each change.

- [ ] `stripeLink`: your Stripe payment link for the $25 reservation. Until set, the thanks page shows "Reservations open soon."
- [ ] `communityUrl`: the Founding 500 group link. Until set, the thanks page shows "The group opens soon."
- [ ] `webhookUrl`: where each new signup is POSTed as JSON. Point it at your email tool (Zapier, Make, or a direct endpoint).
- [x] `clarityId`: already set (`xtssf778gc`). Microsoft Clarity session recordings.
- [x] `siteUrl`: already set (`https://humankindbionics.com`). Used in the share links on the thanks page.

## Add or pause a variant

Each variant is one file in `variants/`. To add one: copy an existing file, give it a new `id` and new copy, and set `"status": "active"`. To pause one: set `"status": "paused"`. Then:

```
node build.js
git add . && git commit -m "variant change" && git push
```

The push deploys it. Keep at most 2 variants active at a time.

## How the A/B decision works

The dashboard runs a simple sequential test: control versus challenger, counting signups in the order they arrived. Before the test you fix N (300 in settings) and a boundary (39 for N=300). If one variant gets 39 more signups than the other, it wins and the test is over. If the two sides reach 300 signups combined with no such lead, the test ends with no winner and you keep the control. The verdict freezes at that moment; later signups cannot flip it. The dashboard tells you in plain words when to stop. Do not stop on p-values (the p-value shown is reference only), run full weeks, and keep at most 2 variants live.

## Where data lives

Signups are in `data/subscribers.jsonl` and events in `data/events.jsonl`. Both are plain text, one JSON row per line, and both are gitignored. Back them up.

**Warning: Render's free-tier disk is ephemeral.** Every redeploy or restart wipes `data/`, and your signups vanish with it. Do at least one of these from day one:

- Attach a persistent disk to the service (paid Render feature), or
- Set `webhookUrl` so every signup is mirrored into your email tool the moment it arrives, or
- Download `data/` before each deploy.

The webhook mirror is the cheapest safe option. Set it before you send any traffic.

## Pull stats for analysis

```
curl "https://humankindbionics.com/api/stats?key=YOUR_DASH_KEY"
```

Returns the full stats object as JSON: totals, per-variant funnel, sources, daily counts, and the sequential test state. Pipe it into a file or a notebook whenever you want deeper analysis.
