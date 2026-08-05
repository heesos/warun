import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPOTS_PATH = path.join(ROOT, 'data', 'spots.json');
const CONDITIONS_PATH = path.join(ROOT, 'data', 'conditions.json');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const CURRENT_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
  'precipitation', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'visibility',
];
const HOURLY_VARS = [
  'relative_humidity_2m', 'precipitation', 'weather_code', 'precipitation_probability',
];

// WMO weather codes: https://open-meteo.com/en/docs
const THUNDERSTORM_CODES = new Set([95, 96, 99]);
const PRECIP_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86]);
const FOG_CODES = new Set([45, 48]);
const WET_CODES = new Set([...THUNDERSTORM_CODES, ...PRECIP_CODES]);

// Rain-sensitivity default by rock type: soft/porous rock (sandstone) is climbed
// wet at real risk of holds breaking, which is a structural/ethics concern, not
// just discomfort - hard rock (granite, limestone, quartzite) has no equivalent
// community rule, so no default is set for them; the continuous wetness sub-score
// already covers their (much smaller) slipperiness-when-damp effect.
const ROCK_TYPE_DEFAULT_RAIN_SENSITIVE_HOURS = {
  sandstone: 24,
};

function rainSensitiveHoursFor(spot) {
  return spot.rainSensitiveHours ?? ROCK_TYPE_DEFAULT_RAIN_SENSITIVE_HOURS[spot.rockType] ?? null;
}

const WEIGHTS = {
  temperature: 0.35,
  wetness: 0.29,
  humidity: 0.18,
  wind: 0.18,
};

// Piecewise-linear interpolation between [x, y] anchor points, clamped at the ends.
function lerp(x, points) {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

const temperatureScore = (c) => lerp(c, [[-15, 0], [-5, 40], [10, 100], [18, 100], [30, 40], [38, 10], [45, 0]]);
const humidityScore = (rh) => lerp(rh, [[0, 100], [40, 100], [60, 80], [75, 50], [90, 20], [95, 0], [100, 0]]);
const windScore = (kmh) => lerp(kmh, [[0, 70], [5, 70], [20, 100], [35, 100], [50, 70], [70, 30], [85, 0]]);
// Hours since last measurable rain -> score. Window is capped at 48h (our past_days lookback).
const wetnessBaseScore = (hours) => lerp(hours, [[0, 0], [3, 10], [6, 30], [12, 50], [24, 75], [48, 100]]);

function round1(n) {
  return Math.round(n * 10) / 10;
}

function bandFor(score) {
  if (score < 20) return 'Poor';
  if (score < 40) return 'Fair';
  if (score < 60) return 'Good';
  if (score < 80) return 'Excellent';
  return 'Prime';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

function buildForecastUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    past_days: '2',
    forecast_days: '2',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    timezone: 'auto',
  });
  return `${FORECAST_URL}?${params}`;
}

// Find the hourly-array index whose hour matches the current reading's hour.
function findNowIndex(hourlyTimes, currentTime) {
  const hourKey = currentTime.slice(0, 13); // 'YYYY-MM-DDTHH'
  let idx = hourlyTimes.findIndex((t) => t.slice(0, 13) === hourKey);
  if (idx === -1) {
    for (let i = hourlyTimes.length - 1; i >= 0; i--) {
      if (hourlyTimes[i] <= currentTime) { idx = i; break; }
    }
  }
  return idx === -1 ? 0 : idx;
}

function hoursSinceRain(hourly, nowIdx) {
  for (let i = nowIdx; i >= 0; i--) {
    const precip = hourly.precipitation[i] ?? 0;
    if (precip > 0.2 || WET_CODES.has(hourly.weather_code[i])) {
      return nowIdx - i;
    }
  }
  return nowIdx; // no rain found anywhere in the window we can see
}

function rainProbabilityNudge(hourly, nowIdx) {
  const upcoming = (hourly.precipitation_probability ?? []).slice(nowIdx + 1, nowIdx + 4);
  const known = upcoming.filter((v) => v != null);
  const maxPop = known.length ? Math.max(...known) : 0;
  if (maxPop >= 60) return 15;
  if (maxPop >= 30) return 7;
  return 0;
}

function dampInWindow(hourly, nowIdx, hoursBack) {
  const start = Math.max(0, nowIdx - hoursBack + 1);
  for (let i = start; i <= nowIdx; i++) {
    const precip = hourly.precipitation[i] ?? 0;
    const rh = hourly.relative_humidity_2m[i] ?? 0;
    if (precip > 0.2 || WET_CODES.has(hourly.weather_code[i]) || rh > 90) return true;
  }
  return false;
}

function scoreSpot(spot, forecast) {
  const current = forecast.current;
  const hourly = forecast.hourly;
  const nowIdx = findNowIndex(hourly.time, current.time);

  const effectiveWindKmh = Math.max(current.wind_speed_10m ?? 0, 0.7 * (current.wind_gusts_10m ?? 0));
  const hSinceRain = hoursSinceRain(hourly, nowIdx);
  const damp6h = dampInWindow(hourly, nowIdx, 6);
  const isPrecipitatingNow = (current.precipitation ?? 0) > 0.2 || WET_CODES.has(current.weather_code);

  const nudge = isPrecipitatingNow ? 0 : rainProbabilityNudge(hourly, nowIdx);

  const subScores = {
    temperature: round1(temperatureScore(current.temperature_2m)),
    wetness: round1(Math.max(0, wetnessBaseScore(hSinceRain) - nudge)),
    humidity: round1(humidityScore(current.relative_humidity_2m)),
    wind: round1(windScore(effectiveWindKmh)),
  };

  const total = Object.keys(WEIGHTS).reduce((sum, key) => sum + WEIGHTS[key] * subScores[key], 0);

  const rainSensitiveHours = rainSensitiveHoursFor(spot);
  const candidates = [];
  if (THUNDERSTORM_CODES.has(current.weather_code)) candidates.push(['active_thunderstorm', 5]);
  if ((current.wind_speed_10m ?? 0) > 60 || (current.wind_gusts_10m ?? 0) > 80) candidates.push(['dangerous_wind', 15]);
  if (isPrecipitatingNow) candidates.push(['precipitating_now', 20]);
  if (rainSensitiveHours != null && hSinceRain < rainSensitiveHours) candidates.push(['wet_sensitive_rock', 25]);
  if (current.temperature_2m < 0 && damp6h) candidates.push(['verglas_risk', 15]);
  if (FOG_CODES.has(current.weather_code) && (current.visibility ?? 99999) < 1000) candidates.push(['low_visibility', 30]);
  if (current.temperature_2m > 40) candidates.push(['extreme_heat', 20]);

  const overridesApplied = candidates.filter(([, cap]) => cap < total).map(([reason]) => reason);
  const finalScore = candidates.length ? Math.min(total, ...candidates.map(([, cap]) => cap)) : total;
  const score = Math.max(0, Math.min(100, Math.round(finalScore)));

  return {
    score,
    band: bandFor(score),
    subScores,
    overridesApplied,
    raw: {
      temp: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      windKmh: round1(current.wind_speed_10m),
      windGustKmh: round1(current.wind_gusts_10m),
      precipMm: current.precipitation,
      visibilityM: current.visibility,
      weatherCode: current.weather_code,
      hoursSinceRain: hSinceRain,
      observedAt: current.time,
      timezone: forecast.timezone,
    },
  };
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const spots = JSON.parse(await readFile(SPOTS_PATH, 'utf8'));
  const previous = await readJsonIfExists(CONDITIONS_PATH, { spots: {} });

  const results = {};
  for (const spot of spots) {
    try {
      const forecast = await fetchJson(buildForecastUrl(spot.lat, spot.lon));
      results[spot.id] = scoreSpot(spot, forecast);
    } catch (err) {
      console.error(`Failed to update "${spot.id}": ${err.message}`);
      if (previous.spots?.[spot.id]) {
        results[spot.id] = { ...previous.spots[spot.id], stale: true };
      }
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    spots: results,
  };

  await writeFile(CONDITIONS_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Updated ${Object.keys(results).length}/${spots.length} spots at ${output.generatedAt}`);
}

await main();
