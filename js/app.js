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
  const cardTemplate = document.getElementById('spot-card-template');
  const subScoreTemplate = document.getElementById('sub-score-template');

  let allSpots = [];
  const activeBands = new Set();
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

  function getFiltered() {
    return allSpots.filter((spot) => {
      if (activeBands.size > 0 && !(spot.conditions && activeBands.has(spot.conditions.band))) {
        return false;
      }
      if (searchTerm) {
        const haystack = `${spot.name} ${spot.region}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return false;
      }
      return true;
    });
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
      grid.innerHTML = '<p class="empty-state">No spots match your filters. Try clearing the search or band filters.</p>';
      statusLine.textContent = '';
      return;
    }

    statusLine.textContent = `Showing ${filtered.length} of ${allSpots.length} spots`;
    for (const spot of filtered) {
      grid.appendChild(buildCard(spot));
    }
  }

  function buildCard(spot) {
    const node = cardTemplate.content.cloneNode(true);
    const article = node.querySelector('.spot-card');
    node.querySelector('.spot-card__name').textContent = spot.name;
    node.querySelector('.spot-card__region').textContent = spot.region;
    node.querySelector('.spot-card__description').textContent = spot.description || '';
    const rockTypeEl = node.querySelector('.spot-card__rock-type');
    rockTypeEl.textContent = spot.rockType
      ? `${spot.rockType.charAt(0).toUpperCase()}${spot.rockType.slice(1)}`
      : '';

    const valueEl = node.querySelector('.score-badge__value');
    const bandEl = node.querySelector('.score-badge__band');
    const metaEl = node.querySelector('.spot-card__meta');

    const c = spot.conditions;
    if (!c) {
      valueEl.textContent = '—';
      bandEl.textContent = 'No data';
      metaEl.textContent = 'Waiting for the next scheduled update.';
      return node;
    }

    valueEl.textContent = c.score;
    bandEl.textContent = c.band;
    article.classList.add(`band-${c.band.toLowerCase()}`);

    const subScoresEl = node.querySelector('.sub-scores');
    for (const [key, label] of Object.entries(SUB_SCORE_LABELS)) {
      const value = c.subScores?.[key];
      if (value == null) continue;
      const row = subScoreTemplate.content.cloneNode(true);
      row.querySelector('.sub-score__label').textContent = label;
      const fill = row.querySelector('.sub-score__fill');
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      subScoresEl.appendChild(row);
    }

    if (c.overridesApplied?.length) {
      const overrideEl = node.querySelector('.spot-card__override');
      overrideEl.hidden = false;
      overrideEl.textContent = c.overridesApplied.map((code) => OVERRIDE_LABELS[code] || code).join(' · ');
    }

    if (c.raw) {
      const staleNote = c.stale ? ' — showing last successful reading' : '';
      metaEl.textContent = `${Math.round(c.raw.temp)}°C · ${Math.round(c.raw.humidity)}% humidity · ${Math.round(c.raw.windKmh)} km/h wind${staleNote}`;
    }

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
      render();
    } catch (err) {
      statusLine.textContent = 'Could not load climbing conditions right now. Please try again shortly.';
      console.error(err);
    }
  }

  init();
})();
