(() => {
  const SPOTS_URL = './data/spots.json';
  const CONDITIONS_URL = './data/conditions.json';

  const SUB_SCORE_LABELS = {
    temperature: 'Temp',
    wetness: 'Dryness',
    humidity: 'Humidity',
    wind: 'Wind',
  };

  const OVERRIDE_LABELS = {
    active_thunderstorm: 'Active thunderstorm',
    dangerous_wind: 'Dangerous wind',
    precipitating_now: 'Raining or snowing right now',
    wet_sensitive_rock: 'Rock likely still wet',
    verglas_risk: 'Ice risk (freezing and damp)',
    low_visibility: 'Low visibility',
    extreme_heat: 'Extreme heat',
  };

  const grid = document.getElementById('spot-grid');
  const statusLine = document.getElementById('status-line');
  const lastUpdatedEl = document.getElementById('last-updated');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const bandFilters = document.getElementById('band-filters');
  const areaSelect = document.getElementById('area-select');
  const cardTemplate = document.getElementById('spot-card-template');
  const subScoreTemplate = document.getElementById('sub-score-template');

  let allSpots = [];
  const activeBands = new Set();
  let selectedArea = '';
  let searchTerm = '';
  let sortMode = 'score-desc';

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  function mergeData(spots, conditions) {
    return spots.map((spot) => ({
      ...spot,
      conditions: conditions.spots?.[spot.id] || null,
    }));
  }

  function renderLastUpdated(generatedAt) {
    if (!generatedAt) {
      lastUpdatedEl.textContent = 'Awaiting the first data update, which runs automatically shortly.';
      return;
    }
    const date = new Date(generatedAt);
    lastUpdatedEl.textContent = `Last updated ${date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })}`;
  }

  // Strips accents (Śmietniczek -> smietniczek) so searches work regardless of
  // diacritics, then lowercases.
  function normalizeForSearch(str) {
    return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function tokenize(str) {
    return normalizeForSearch(str).split(/[\s,-]+/).filter(Boolean);
  }

  // Standard edit distance (insertions/deletions/substitutions), single-row DP.
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const curr = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[b.length];
  }

  // A query token matches a target token if it's a substring (covers partial
  // typing, e.g. "smietni") or close enough by edit distance (covers typos,
  // e.g. "smietnicek" for "smietniczek") - tolerance scales gently with length
  // so short words still need a near-exact match.
  function tokenMatches(queryToken, targetToken) {
    if (targetToken.includes(queryToken)) return true;
    const maxDistance = Math.max(1, Math.round(queryToken.length / 4));
    return levenshtein(queryToken, targetToken) <= maxDistance;
  }

  function matchesSearch(spot, query) {
    if (!query) return true;
    const queryTokens = tokenize(query);
    const targetTokens = tokenize(`${spot.name} ${spot.region} ${spot.area || ''}`);
    return queryTokens.every((qt) => targetTokens.some((tt) => tokenMatches(qt, tt)));
  }

  function getFiltered() {
    return allSpots.filter((spot) => {
      if (activeBands.size > 0 && !(spot.conditions && activeBands.has(spot.conditions.band))) {
        return false;
      }
      if (selectedArea && spot.area !== selectedArea) {
        return false;
      }
      return matchesSearch(spot, searchTerm);
    });
  }

  // Area options are generated from whatever areas actually appear in the
  // loaded spots, so the dropdown grows on its own as spots.json grows.
  function populateAreaOptions() {
    const areas = Array.from(new Set(allSpots.map((spot) => spot.area).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    for (const area of areas) {
      const option = document.createElement('option');
      option.value = area;
      option.textContent = area;
      areaSelect.appendChild(option);
    }
  }

  function getSorted(spots) {
    const sorted = [...spots];
    switch (sortMode) {
      case 'score-asc':
        sorted.sort((a, b) => (a.conditions?.score ?? -1) - (b.conditions?.score ?? -1));
        break;
      case 'name-asc':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'region-asc':
        sorted.sort((a, b) => a.region.localeCompare(b.region));
        break;
      case 'score-desc':
      default:
        sorted.sort((a, b) => (b.conditions?.score ?? -1) - (a.conditions?.score ?? -1));
        break;
    }
    return sorted;
  }

  function render() {
    if (allSpots.length === 0) {
      statusLine.textContent = '';
      grid.innerHTML = '<p class="empty-state">No climbing spots configured yet.</p>';
      return;
    }

    const filtered = getSorted(getFiltered());
    grid.innerHTML = '';

    if (filtered.length === 0) {
      grid.innerHTML = '<p class="empty-state">No spots match your filters. Try clearing the search or filters.</p>';
      statusLine.textContent = '';
      return;
    }

    statusLine.textContent = `Showing ${filtered.length} of ${allSpots.length} spots`;
    for (const spot of filtered) {
      grid.appendChild(buildCard(spot));
    }
  }

  function formatTime(isoLike) {
    // Open-Meteo local timestamps look like "2026-08-05T22:00" with no offset
    // suffix, already in the spot's local time since we request timezone=auto.
    const date = new Date(isoLike);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // Renders one view (the "now" conditions, or a +Nh prediction) into a card's
  // DOM refs. Both shapes carry the same {score, band, subScores,
  // overridesApplied, raw} fields, so one function serves both.
  function applyView(refs, view, { prefix = '', emptyMessage = '' } = {}) {
    const { article, valueEl, bandEl, subScoresEl, overrideEl, metaEl } = refs;

    for (const cls of Array.from(article.classList)) {
      if (cls.startsWith('band-')) article.classList.remove(cls);
    }

    if (!view) {
      valueEl.textContent = '—';
      bandEl.textContent = 'No data';
      subScoresEl.innerHTML = '';
      overrideEl.hidden = true;
      metaEl.textContent = emptyMessage;
      return;
    }

    valueEl.textContent = view.score;
    bandEl.textContent = view.band;
    article.classList.add(`band-${view.band.toLowerCase()}`);

    subScoresEl.innerHTML = '';
    for (const [key, label] of Object.entries(SUB_SCORE_LABELS)) {
      const value = view.subScores?.[key];
      if (value == null) continue;
      const row = subScoreTemplate.content.cloneNode(true);
      row.querySelector('.sub-score__label').textContent = label;
      row.querySelector('.sub-score__fill').style.width = `${Math.max(0, Math.min(100, value))}%`;
      subScoresEl.appendChild(row);
    }

    overrideEl.hidden = !view.overridesApplied?.length;
    if (!overrideEl.hidden) {
      overrideEl.textContent = view.overridesApplied.map((code) => OVERRIDE_LABELS[code] || code).join(' · ');
    }

    metaEl.textContent = view.raw
      ? `${prefix}${Math.round(view.raw.temp)}°C · ${Math.round(view.raw.humidity)}% humidity · ${Math.round(view.raw.windKmh)} km/h wind`
      : '';
  }

  function buildCard(spot) {
    const node = cardTemplate.content.cloneNode(true);
    const article = node.querySelector('.spot-card');
    node.querySelector('.spot-card__name').textContent = spot.name;
    node.querySelector('.spot-card__region').textContent = spot.region;
    node.querySelector('.spot-card__description').textContent = spot.description || '';
    const rockTypeEl = node.querySelector('.spot-card__rock-type');
    const rockTypeLabel = spot.rockType
      ? `${spot.rockType.charAt(0).toUpperCase()}${spot.rockType.slice(1)}`
      : '';
    rockTypeEl.textContent = [rockTypeLabel, spot.area].filter(Boolean).join(' · ');

    const refs = {
      article,
      valueEl: node.querySelector('.score-badge__value'),
      bandEl: node.querySelector('.score-badge__band'),
      subScoresEl: node.querySelector('.sub-scores'),
      overrideEl: node.querySelector('.spot-card__override'),
      metaEl: node.querySelector('.spot-card__meta'),
    };
    const toggle = node.querySelector('.time-toggle');

    const c = spot.conditions;
    if (!c) {
      applyView(refs, null, { emptyMessage: 'Waiting for the next scheduled update.' });
      toggle.hidden = true;
      return node;
    }

    const nowPrefix = c.stale ? 'Showing last successful reading — ' : '';
    applyView(refs, c, { prefix: nowPrefix });

    for (const btn of toggle.querySelectorAll('.time-btn[data-offset^="+"]')) {
      if (!c.predictions?.[btn.dataset.offset]) btn.disabled = true;
    }

    toggle.addEventListener('click', (event) => {
      const btn = event.target.closest('.time-btn');
      if (!btn || btn.disabled) return;
      for (const b of toggle.querySelectorAll('.time-btn')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      if (btn.dataset.offset === 'now') {
        applyView(refs, c, { prefix: nowPrefix });
        return;
      }
      const prediction = c.predictions?.[btn.dataset.offset];
      const time = formatTime(prediction?.at);
      applyView(refs, prediction, { prefix: time ? `Predicted for ${time} — ` : 'Predicted — ' });
    });

    return node;
  }

  bandFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const band = chip.dataset.band;
    const pressed = chip.getAttribute('aria-pressed') === 'true';
    chip.setAttribute('aria-pressed', String(!pressed));
    if (pressed) {
      activeBands.delete(band);
    } else {
      activeBands.add(band);
    }
    render();
  });

  areaSelect.addEventListener('change', (event) => {
    selectedArea = event.target.value;
    render();
  });

  searchInput.addEventListener('input', (event) => {
    searchTerm = event.target.value.trim().toLowerCase();
    render();
  });

  sortSelect.addEventListener('change', (event) => {
    sortMode = event.target.value;
    render();
  });

  async function init() {
    for (const chip of bandFilters.querySelectorAll('.chip')) {
      chip.setAttribute('aria-pressed', 'false');
    }
    try {
      const [spots, conditions] = await Promise.all([
        fetchJson(SPOTS_URL),
        fetchJson(CONDITIONS_URL),
      ]);
      allSpots = mergeData(spots, conditions);
      renderLastUpdated(conditions.generatedAt);
      populateAreaOptions();
      render();
    } catch (err) {
      statusLine.textContent = 'Could not load climbing conditions right now. Please try again shortly.';
      console.error(err);
    }
  }

  init();
})();
