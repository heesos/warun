# Warun — Climbing Condition Score

A small static site that scores outdoor rock-climbing spots from 0–100 based on real-time and
recent weather, so you can see at a glance where conditions are good right now.

**Live data, no API keys.** Weather comes from [Open-Meteo](https://open-meteo.com/), which is
free for non-commercial use and needs no account or key. A scheduled GitHub Action fetches the
data, computes each spot's score, and commits the result as a small JSON file that the page reads
— so the site itself stays a plain static page with no backend.

## How the score works

Four weighted factors, each scored 0–100, combined into one weighted total:

| Factor | Weight | What it measures |
|---|---|---|
| Temperature | 35% | Comfort/friction curve — best around 10–18°C |
| Precipitation / dryness | 29% | Hours since it last rained, and how sensitive the rock type is to moisture |
| Humidity | 18% | High humidity means greasy holds and poor chalk grip |
| Wind | 18% | Light-to-moderate wind helps drying and cooling; very strong wind is a hazard |

Freezing conditions and poor visibility aren't part of the weighted score or shown as a card
factor — they're rare enough, and unrelated enough to the day-to-day "is it good climbing
weather" question, that they'd mostly just add noise to four numbers that matter every day. They
still act as **safety overrides** (see below): a temperature below freezing combined with recent
dampness (ice risk), and fog with sub-1000m visibility, both still cap the score hard.

**Rock type matters.** Soft/porous rock (sandstone) has a real community rule against climbing it
wet or damp — holds can break, which is a structural/conservation issue, not just a comfort one.
Hard rock (granite, limestone, quartzite) has no equivalent rule; its smaller wet-and-slippery
effect is already captured by the continuous dryness curve above. So sandstone spots automatically
get a minimum 24-hour dry-time requirement after rain (see `rainSensitiveHours` below to override
that default per spot), and other rock types don't.

On top of the weighted total, a handful of **safety overrides** cap the score regardless of the
additive total — an active thunderstorm caps it at 5, currently raining caps it at 20, dangerous
wind caps it at 15, wet sandstone caps it at 25, ice risk caps it at 15, fog/low visibility caps it
at 30, extreme heat caps it at 20. These only ever pull the score down, never up. The exact curves,
thresholds, and override list are in
[`scripts/update-conditions.mjs`](scripts/update-conditions.mjs) — that file is the actual spec,
this is just the summary.

Bands: **0–19 Poor · 20–39 Fair · 40–59 Good · 60–79 Excellent · 80–100 Prime.**

**Where "past" comes from.** Every fetch asks Open-Meteo for the last 48 real hours alongside the
forecast (`past_days=2`), so "hours since it last rained" is computed fresh from genuine historical
data on every run — it's not a self-built log. What *isn't* kept is a history of our own past
scores: `data/conditions.json` is fully overwritten each run with only the latest snapshot, so
there's no "score 6 hours ago" record sitting in that file (only in git's commit history, which
isn't a convenient format for it). That's an intentional simplification, not a bug — the score
itself is always computed correctly, there's just no built-in trend view yet.

**Predictions (+3h / +6h / +12h).** Each card's time buttons run the exact same formula above
against Open-Meteo's forecast for a future hour instead of the current reading — same weights,
same overrides, just fed from a different point in the same hourly array. Stored under each spot's
`predictions` key in `conditions.json`.

## Adding or editing climbing spots

Edit [`data/spots.json`](data/spots.json). Each entry looks like:

```json
{
  "id": "unique-slug",
  "name": "Display name",
  "region": "Region, Country",
  "area": "Named climbing area",
  "lat": 12.3456,
  "lon": -65.4321,
  "rockType": "granite",
  "description": "One line shown on the card."
}
```

`area` is optional - it's a broader grouping (e.g. "Frankenjura", "Polish Jura") shared by several
spots, distinct from `region` which is that one spot's own village/country. Any spot with an `area`
set gets an auto-generated entry in the "All areas" filter dropdown, and it's also searchable.

`rainSensitiveHours` is optional and only needed to override the default: sandstone spots already
get a 24-hour minimum dry-time automatically based on `rockType` (see above). Set this field
explicitly if a specific spot needs a different number, or if some other rock type at your spot
has a similar local rule.

Pushing a change to this file triggers an immediate re-fetch (no need to wait for the next
scheduled run).

## One-time setup

1. **Enable GitHub Pages**: repo Settings → Pages → Source: "Deploy from a branch" → Branch:
   `main`, folder `/ (root)`.
2. **Google Analytics**: wired up behind a cookie-consent banner in [`js/consent.js`](js/consent.js)
   with a real GA4 Measurement ID — the `gtag.js` script only loads after a visitor clicks
   "Accept". To point it at a different GA4 property later, swap the `GA_ID` constant at the top of
   that file.

No API keys or secrets to configure — Open-Meteo's free tier needs none.

## Local preview

Opening `index.html` directly (`file://`) won't work — browsers block `fetch()` calls to local
JSON files under that protocol. Serve the folder over plain HTTP instead (e.g. an editor's "Live
Server" extension, or any static file server) and open it via `http://localhost:...`.

## Data attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
