/* Phosphor — builds multi-hue gradients whose CIE L* changes linearly. */
(function () {
  'use strict';

  const DEFAULTS = {
    colors: ['#1b2a49', '#c23b5c', '#f7d154'],
    mode: 'lab',
    steps: 9,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('color-list'), add: $('add-color'), reverse: $('reverse'), sortL: $('sort-l'),
    paste: $('paste'), applyPaste: $('apply-paste'),
    mode: $('mode'), steps: $('steps'), stepsOut: $('steps-out'),
    warning: $('warning'), bar: $('bar'), barLabel: $('bar-label'),
    presetsToggle: $('presets-toggle'), presetsPanel: $('presets-panel'), legendResult: $('legend-result'), legendRaw: $('legend-raw'),
    swatches: $('swatches'), chart: $('chart'), stats: $('stats'),
    outHex: $('out-hex'), outCss: $('out-css'), outJs: $('out-js'),
    proPreview: $('pro-preview'), proName: $('pro-name'), proDownload: $('pro-download'),
  };

  // ArcGIS Pro export: this many colors, joined by CIELAB segments.
  const PRO_RAMP_COLORS = 16;
  const SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/';

  let state = readHash() || { ...DEFAULTS, colors: DEFAULTS.colors.slice() };
  let proHexes = [];
  let proNameEdited = false;

  // ---------- color math ----------

  const lstar = (c) => chroma(c).get('lab.l');

  function makeScale(colors, mode) {
    if (mode === 'bezier') return chroma.bezier(colors).scale();
    return chroma.scale(colors).mode(mode);
  }

  function isMonotonic(values) {
    let up = true, down = true;
    for (let i = 1; i < values.length; i++) {
      if (values[i] < values[i - 1]) up = false;
      if (values[i] > values[i - 1]) down = false;
    }
    return up || down;
  }

  /**
   * Returns { raw(t), result(t), target(t), corrected }. `result` is the gradient shown and
   * exported: the scale after chroma.js correctLightness() when the colors' lightness only rises
   * or only falls, otherwise the uncorrected scale (correctLightness() can't handle that case).
   * `raw` is always the uncorrected scale, kept for comparison.
   */
  function buildSamplers(colors, mode) {
    const L0 = lstar(colors[0]);
    const L1 = lstar(colors[colors.length - 1]);
    const corrected = isMonotonic(colors.map(lstar));
    const raw = makeScale(colors, mode);
    const result = corrected ? makeScale(colors, mode).correctLightness() : raw;
    return {
      raw: (t) => raw(t),
      result: (t) => result(t),
      target: (t) => L0 + t * (L1 - L0),
      corrected,
    };
  }

  const positions = (n) => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : i / (n - 1)));

  // ---------- rendering ----------

  function render() {
    const colors = state.colors.filter((c) => chroma.valid(c)).map((c) => chroma(c).hex());
    el.stepsOut.textContent = state.steps;
    renderLValues();
    el.proDownload.disabled = true;
    writeHash();

    if (colors.length < 2) {
      showWarning('Add at least two valid hex colors.');
      return;
    }

    let s;
    try {
      s = buildSamplers(colors, state.mode);
    } catch (err) {
      showWarning('Could not build this gradient: ' + err.message);
      return;
    }

    const warnings = [];
    if (state.mode === 'bezier' && colors.length > 5) {
      warnings.push('Bezier interpolation works best with 2–5 colors.');
    }

    const stepColors = positions(state.steps).map((t) => s.result(t));
    const clippedCount = stepColors.filter((c) => c.clipped && c.clipped()).length;
    if (clippedCount) {
      warnings.push(`${clippedCount} step${clippedCount > 1 ? 's' : ''} fell outside sRGB and ${clippedCount > 1 ? 'were' : 'was'} clipped (marked “clipped”), which moves L* slightly.`);
    }
    if (warnings.length) showWarning(warnings.join('<br>')); else hideWarning();

    // Bars
    const dense = positions(64);
    el.bar.style.background = cssGradient(dense.map((t) => s.result(t).hex()));
    el.barLabel.textContent = s.corrected
      ? 'Corrected'
      : 'Uncorrected - Your colors go up and down in lightness. Try Sort by lightness.';
    el.barLabel.classList.toggle('bar-label-warn', !s.corrected);

    // Swatches
    const hexes = stepColors.map((c) => c.hex());
    el.swatches.innerHTML = '';
    stepColors.forEach((c, i) => {
      const hex = hexes[i];
      const L = lstar(hex);
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'swatch';
      d.style.background = hex;
      d.style.color = L > 60 ? '#111' : '#fff';
      d.title = 'Click to copy';
      d.innerHTML = `<span>${hex}</span><span>L* ${L.toFixed(1)}</span>` +
        (c.clipped && c.clipped() ? '<span class="clip">clipped</span>' : '');
      d.addEventListener('click', () => copy(hex, d.firstChild));
      el.swatches.appendChild(d);
    });

    renderChart(s, hexes);

    // Exports
    el.outHex.value = hexes.map((h) => `"${h}"`).join(', ');
    el.outCss.value =
      hexes.map((h, i) => `--ramp-${i}: ${h};`).join('\n') +
      `\n\nbackground: ${cssGradient(dense.filter((_, i) => i % 4 === 0 || i === dense.length - 1).map((t) => s.result(t).hex()))};`;
    el.outJs.value = jsSnippet(colors, s.corrected);

    // ArcGIS Pro blends each segment in CIELAB, which is exactly a Lab scale through these stops.
    proHexes = positions(PRO_RAMP_COLORS).map((t) => s.result(t).hex());
    el.proPreview.style.background = cssGradient(chroma.scale(proHexes).mode('lab').colors(64));
    const preset = activePreset();
    markActivePreset(preset);
    if (!proNameEdited) {
      el.proName.value = preset ? `Phosphor ${preset.name}` : `Phosphor ${proHexes[0]}–${proHexes[proHexes.length - 1]}`;
    }
    el.proDownload.disabled = false;
  }

  function cssGradient(hexes) {
    return `linear-gradient(to right, ${hexes.join(', ')})`;
  }

  function jsSnippet(colors, corrected) {
    const list = JSON.stringify(colors);
    const base = state.mode === 'bezier'
      ? `chroma.bezier(${list}).scale()`
      : `chroma.scale(${list}).mode('${state.mode}')`;
    return `${base}${corrected ? '.correctLightness()' : ''}.colors(${state.steps});`;
  }

  function renderChart(s, hexes) {
    const W = 600, H = 260, pad = { l: 36, r: 12, t: 12, b: 28 };
    const x = (t) => pad.l + t * (W - pad.l - pad.r);
    const y = (L) => pad.t + (1 - L / 100) * (H - pad.t - pad.b);
    const css = getComputedStyle(document.documentElement);
    const col = (name) => css.getPropertyValue(name).trim();

    const line = (fn, n = 120) =>
      positions(n).map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(fn(t)).toFixed(1)}`).join('');

    let out = '';
    for (let L = 0; L <= 100; L += 25) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(L)}" y2="${y(L)}" stroke="${col('--chart-grid')}"/>`;
      out += `<text x="${pad.l - 6}" y="${y(L) + 4}" text-anchor="end">${L}</text>`;
    }
    out += `<text x="${pad.l}" y="${H - 8}">start</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end">end</text>`;

    // Actual L* is measured from the displayed (gamut-clipped) hex.
    out += `<path d="${line(s.target, 2)}" fill="none" stroke="${col('--chart-target')}" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    if (s.corrected) {
      out += `<path d="${line((t) => lstar(s.raw(t).hex()))}" fill="none" stroke="${col('--chart-raw')}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    }
    out += `<path d="${line((t) => lstar(s.result(t).hex()))}" fill="none" stroke="${col('--chart-corrected')}" stroke-width="2"/>`;

    positions(hexes.length).forEach((t, i) => {
      out += `<circle cx="${x(t)}" cy="${y(lstar(hexes[i]))}" r="5" fill="${hexes[i]}" stroke="${col('--chart-corrected')}" stroke-width="1.5"/>`;
    });
    el.chart.innerHTML = out;

    const maxDev = (fn) => Math.max(...positions(200).map((t) => Math.abs(lstar(fn(t).hex()) - s.target(t))));
    el.legendResult.textContent = s.corrected ? 'Corrected' : 'Uncorrected';
    el.legendRaw.hidden = !s.corrected;
    el.stats.textContent = s.corrected
      ? `Largest gap from the linear target: corrected ${maxDev(s.result).toFixed(2)} L*, uncorrected ${maxDev(s.raw).toFixed(2)} L*.`
      : `Largest gap from the linear target: ${maxDev(s.result).toFixed(2)} L* (uncorrected).`;
  }

  // ---------- ArcGIS Pro .stylx export ----------
  // A .stylx is a SQLite database. The schema and metadata mirror a style saved by ArcGIS Pro 3.1.

  const STYLX_SCHEMA = `
    CREATE TABLE ITEMS (ID INTEGER PRIMARY KEY, CLASS INTEGER, CATEGORY TEXT, NAME TEXT, TAGS TEXT, CONTENT TEXT, KEY TEXT UNIQUE);
    CREATE INDEX 'ITEMS_ID' ON 'ITEMS' (ID);
    CREATE INDEX 'ITEMS_CLASS' ON 'ITEMS' (CLASS);
    CREATE INDEX 'ITEMS_KEY' ON 'ITEMS' (KEY);
    CREATE TABLE CLASSES (ID INTEGER PRIMARY KEY, NAME TEXT);
    CREATE INDEX 'CLASSES_ID' ON 'CLASSES' (ID);
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE BINARY_CLASSES (ID INTEGER PRIMARY KEY, NAME TEXT);
    CREATE INDEX 'BINARY_CLASSES_ID' ON 'BINARY_CLASSES' (ID);
    CREATE TABLE BINARIES (ID INTEGER PRIMARY KEY, MD5 STRING UNIQUE, CLASS INTEGER, CONTENT BLOB);
    CREATE INDEX 'BINARIES_ID' ON 'BINARIES' (ID);
    CREATE INDEX 'BINARIES_MD5' ON 'BINARIES' (MD5);
    CREATE INDEX 'BINARIES_CLASS' ON 'BINARIES' (CLASS);
    CREATE TABLE STYLE_ITEM_BINARY_REFERENCES (ID INTEGER PRIMARY KEY, ITEMS_ID INTEGER NOT NULL, BINARIES_ID INTEGER NOT NULL, FOREIGN KEY(ITEMS_ID) REFERENCES ITEMS(ID), FOREIGN KEY(BINARIES_ID) REFERENCES BINARIES(ID), UNIQUE(ITEMS_ID, BINARIES_ID));`;

  const STYLX_META = [
    ['version', '1.0'], ['cim_version', '3.1.0'], ['build', '41833'], ['content', 'json'],
    ['colorModel', 'RGB'], ['RGBColorProfile', 'sRGB IEC61966-2.1'], ['CMYKColorProfile', 'U.S. Web Coated (SWOP) v2'],
  ];

  const STYLX_CLASSES = ['Color', 'Color Scheme', 'Point Symbol', 'Line Symbol', 'Polygon Symbol', 'Text Symbol',
    'North Arrow', 'Scale Bar', 'Standard Label Placement', 'Maplex Label Placement', 'Grid', 'Mesh Symbol',
    'Legend', 'Table Frame', 'Map Surround'];
  const CLASS_COLOR_SCHEME = 2;

  const cimColor = (hex) => ({ type: 'CIMRGBColor', values: [...chroma(hex).rgb(), 100] });

  function cimMultipartRamp(hexes) {
    const ramps = hexes.slice(1).map((hex, i) => ({
      type: 'CIMLinearContinuousColorRamp',
      fromColor: cimColor(hexes[i]),
      toColor: cimColor(hex),
    }));
    return {
      type: 'CIMMultipartColorRamp',
      colorRamps: ramps,
      weights: ramps.map(() => 1 / ramps.length),
    };
  }

  let sqlJsPromise;
  function loadSqlJs() {
    sqlJsPromise = sqlJsPromise || new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SQLJS_BASE + 'sql-wasm.min.js';
      script.onload = () => initSqlJs({ locateFile: (f) => SQLJS_BASE + f }).then(resolve, reject);
      script.onerror = () => reject(new Error('could not load sql.js'));
      document.head.appendChild(script);
    }).catch((err) => { sqlJsPromise = null; throw err; });
    return sqlJsPromise;
  }

  function buildStylx(SQL, name, hexes) {
    const db = new SQL.Database();
    db.exec(STYLX_SCHEMA);
    STYLX_META.forEach((row) => db.run('INSERT INTO meta (key, value) VALUES (?, ?)', row));
    STYLX_CLASSES.forEach((cls, i) => db.run('INSERT INTO CLASSES (ID, NAME) VALUES (?, ?)', [i + 1, cls]));
    db.run('INSERT INTO BINARY_CLASSES (ID, NAME) VALUES (1, ?)', ['GLB']);
    db.run('INSERT INTO ITEMS (ID, CLASS, CATEGORY, NAME, TAGS, CONTENT, KEY) VALUES (1, ?, ?, ?, ?, ?, ?)',
      [CLASS_COLOR_SCHEME, 'Phosphor', name, 'Phosphor;linear lightness', JSON.stringify(cimMultipartRamp(hexes)), name]);
    const bytes = db.export();
    db.close();
    return bytes;
  }

  async function downloadStylx() {
    const name = el.proName.value.trim() || 'Phosphor';
    const label = el.proDownload.textContent;
    el.proDownload.disabled = true;
    el.proDownload.textContent = 'Building…';
    try {
      const SQL = await loadSqlJs();
      const blob = new Blob([buildStylx(SQL, name, proHexes)], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/#/g, '') + '.stylx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      showWarning('Could not build the ArcGIS Pro style: ' + err.message);
    } finally {
      el.proDownload.disabled = false;
      el.proDownload.textContent = label;
    }
  }

  function showWarning(html) { el.warning.innerHTML = html; el.warning.hidden = false; }
  function hideWarning() { el.warning.hidden = true; }

  // ---------- color list UI ----------

  function buildList() {
    el.list.innerHTML = '';
    state.colors.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'color-item';
      const valid = chroma.valid(c);
      li.innerHTML = `
        <input type="color" aria-label="Pick color ${i + 1}" value="${valid ? chroma(c).hex('rgb') : '#000000'}">
        <input type="text" aria-label="Hex color ${i + 1}" value="${c}" spellcheck="false" autocomplete="off" class="${valid ? '' : 'invalid'}">
        <span class="lval"></span>
        <button type="button" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-act="down" aria-label="Move down" ${i === state.colors.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-act="del" aria-label="Remove" ${state.colors.length <= 2 ? 'disabled' : ''}>×</button>`;
      const [picker, text] = li.querySelectorAll('input');

      picker.addEventListener('input', () => {
        state.colors[i] = picker.value;
        text.value = picker.value;
        text.classList.remove('invalid');
        render();
      });
      text.addEventListener('input', () => {
        const v = text.value.trim();
        state.colors[i] = v;
        const ok = chroma.valid(v);
        text.classList.toggle('invalid', !ok);
        if (ok) picker.value = chroma(v).hex('rgb');
        render();
      });
      li.addEventListener('click', (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) return;
        if (act === 'del') state.colors.splice(i, 1);
        if (act === 'up') swap(i, i - 1);
        if (act === 'down') swap(i, i + 1);
        buildList();
        render();
      });
      el.list.appendChild(li);
    });
  }

  function renderLValues() {
    el.list.querySelectorAll('.color-item').forEach((li, i) => {
      const c = state.colors[i];
      li.querySelector('.lval').textContent = chroma.valid(c) ? 'L* ' + Math.round(lstar(c)) : '';
    });
  }

  function swap(a, b) {
    [state.colors[a], state.colors[b]] = [state.colors[b], state.colors[a]];
  }

  // ---------- preset palettes ----------

  // ColorBrewer sequential schemes (9 classes) ship with chroma.js as chroma.brewer.
  const brewer = (names) => names.map((name) => ({ name, colors: chroma.brewer[name] }));
  const PRESET_GROUPS = [
    { title: 'ColorBrewer: single hue', presets: brewer(['Blues', 'Greens', 'Greys', 'Oranges', 'Purples', 'Reds']) },
    {
      title: 'ColorBrewer: multi-hue',
      presets: brewer(['BuGn', 'BuPu', 'GnBu', 'OrRd', 'PuBu', 'PuBuGn', 'PuRd', 'RdPu', 'YlGn', 'YlGnBu', 'YlOrBr', 'YlOrRd']),
    },
    {
      // 11 evenly spaced stops from matplotlib's 256-entry colormaps.
      title: 'Perceptually uniform (matplotlib)',
      presets: [
        { name: 'Viridis', colors: ['#440154', '#482576', '#414487', '#355f8d', '#2a788e', '#21918c', '#22a884', '#42be71', '#7ad151', '#bddf26', '#fde725'] },
        { name: 'Plasma', colors: ['#0d0887', '#43039e', '#6a00a8', '#8f0da4', '#b12a90', '#cc4778', '#e16462', '#f1834c', '#fca636', '#fcce25', '#f0f921'] },
        { name: 'Magma', colors: ['#000004', '#150e38', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f66e5c', '#fe9f6d', '#fecf92', '#fcfdbf'] },
        { name: 'Inferno', colors: ['#000004', '#180c3c', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f3761b', '#fca50a', '#f6d746', '#fcffa4'] },
      ],
    },
  ];
  const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

  /** The preset whose colors exactly match the current colors, if any. */
  function activePreset() {
    const key = state.colors.map((c) => c.toLowerCase()).join(',');
    return ALL_PRESETS.find((p) => p.colors.join(',') === key) || null;
  }

  function markActivePreset(preset) {
    el.presetsPanel.querySelectorAll('.preset-card').forEach((card) =>
      card.setAttribute('aria-pressed', String(!!preset && card.dataset.name === preset.name)));
  }

  function buildPresets() {
    el.presetsPanel.innerHTML = PRESET_GROUPS.map((g) => `
      <h2>${g.title}</h2>
      <div class="preset-grid">
        ${g.presets.map((p) => `
          <button type="button" class="preset-card" data-name="${p.name}" aria-pressed="false">
            <span class="preset-preview" style="background: ${cssGradient(p.colors)}"></span>
            <span class="preset-name">${p.name}</span>
          </button>`).join('')}
      </div>`).join('');
    el.presetsPanel.addEventListener('click', (e) => {
      const card = e.target.closest('.preset-card');
      if (!card) return;
      const preset = ALL_PRESETS.find((p) => p.name === card.dataset.name);
      state.colors = preset.colors.slice();
      proNameEdited = false;
      buildList();
      render();
    });
  }

  // ---------- URL state ----------

  function writeHash() {
    const p = new URLSearchParams({
      c: state.colors.map((c) => c.replace('#', '')).join(','),
      m: state.mode, n: String(state.steps),
    });
    history.replaceState(null, '', '#' + p.toString());
  }

  function readHash() {
    if (!location.hash) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    const colors = (p.get('c') || '').split(',').filter(Boolean).map((c) => '#' + c);
    if (colors.length < 2) return null;
    const modes = Array.from(document.querySelectorAll('#mode option')).map((o) => o.value);
    return {
      colors,
      mode: modes.includes(p.get('m')) ? p.get('m') : DEFAULTS.mode,
      steps: Math.min(32, Math.max(2, parseInt(p.get('n'), 10) || DEFAULTS.steps)),
    };
  }

  // ---------- misc ----------

  function copy(text, labelEl) {
    const done = () => {
      if (!labelEl) return;
      const prev = labelEl.textContent;
      labelEl.textContent = 'Copied';
      setTimeout(() => { labelEl.textContent = prev; }, 900);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
  }

  function parseList(str) {
    return (str.match(/#?[0-9a-f]{3,8}\b/gi) || [])
      .map((h) => (h[0] === '#' ? h : '#' + h))
      .filter((h) => chroma.valid(h));
  }

  // ---------- wiring ----------

  el.add.addEventListener('click', () => {
    const last = state.colors[state.colors.length - 1];
    state.colors.push(chroma.valid(last) ? chroma(last).darken(1).hex() : '#888888');
    buildList(); render();
  });
  el.reverse.addEventListener('click', () => { state.colors.reverse(); buildList(); render(); });
  el.sortL.addEventListener('click', () => {
    state.colors.sort((a, b) => (chroma.valid(a) ? lstar(a) : 0) - (chroma.valid(b) ? lstar(b) : 0));
    buildList(); render();
  });
  const applyPaste = () => {
    const list = parseList(el.paste.value);
    if (list.length >= 2) { state.colors = list; el.paste.value = ''; buildList(); render(); }
    else showWarning('Paste at least two hex colors, separated by spaces or commas.');
  };
  el.applyPaste.addEventListener('click', applyPaste);
  el.paste.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPaste(); });

  el.mode.addEventListener('change', () => { state.mode = el.mode.value; render(); });
  el.steps.addEventListener('input', () => { state.steps = +el.steps.value; render(); });
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy($(b.dataset.copy).value, b)));
  el.proName.addEventListener('input', () => { proNameEdited = el.proName.value.trim() !== ''; });
  el.proDownload.addEventListener('click', downloadStylx);

  // Theme: dark by default; an explicit choice is saved.
  const THEME_KEY = 'phosphor-theme';
  const themeToggle = $('theme-toggle');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.setAttribute('aria-label', label);
    themeToggle.title = label;
    render(); // the chart reads theme colors when it draws
  }

  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* choice just won't persist */ }
    applyTheme(next);
  });

  el.presetsToggle.addEventListener('click', () => {
    const open = el.presetsPanel.hidden;
    el.presetsPanel.hidden = !open;
    el.presetsToggle.setAttribute('aria-expanded', String(open));
    el.presetsToggle.textContent = open ? 'Hide preset palettes' : 'Show preset palettes';
  });

  // Color vision deficiency simulation: one type at a time; clicking the active one turns it off.
  const cvdButtons = document.querySelectorAll('.cvd button');
  cvdButtons.forEach((b) => b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') === 'true' ? null : b.dataset.cvd;
    if (next) document.documentElement.setAttribute('data-cvd', next);
    else document.documentElement.removeAttribute('data-cvd');
    cvdButtons.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.cvd === next)));
  }));

  // initial UI sync
  el.mode.value = state.mode;
  el.steps.value = state.steps;
  buildList();
  buildPresets();
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
})();
