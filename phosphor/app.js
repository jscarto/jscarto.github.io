/* Phosphor — builds multi-hue gradients whose OKLab lightness changes linearly. */
(function () {
  'use strict';

  const DEFAULTS = {
    colors: ['#1b2a49', '#c23b5c', '#f7d154'],
    mode: 'oklab',
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
    outHex: $('out-hex'), outCss: $('out-css'), outPy: $('out-py'),
    proPreview: $('pro-preview'), rampName: $('ramp-name'), proDownload: $('pro-download'),
    outQgis: $('out-qgis'), qgisDownload: $('qgis-download'),
    share: $('share'), shareBtnLabel: $('share-label'), shareStatus: $('share-status'),
  };

  // ArcGIS Pro export: this many colors, joined by CIELAB segments.
  const PRO_RAMP_COLORS = 16;
  const SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/';

  let state = readHash() || { ...DEFAULTS, colors: DEFAULTS.colors.slice() };
  let proHexes = [];
  let rampNameEdited = false;
  const SHARE_PROMPT = 'Like this palette? Get a link to bookmark it or share it.';

  // ---------- color math ----------

  // Lightness everywhere is OKLab L, shown on a 0–100 scale (as in CSS oklch()).
  const lightness = (c) => chroma(c).oklab()[0] * 100;

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
   * exported: the scale with OKLab lightness corrected when the colors' lightness only rises
   * or only falls, otherwise the uncorrected scale (the correction can't handle that case).
   * `raw` is always the uncorrected scale, kept for comparison.
   */
  function buildSamplers(colors, mode) {
    const L0 = lightness(colors[0]);
    const L1 = lightness(colors[colors.length - 1]);
    const corrected = isMonotonic(colors.map(lightness));
    const raw = makeScale(colors, mode);
    const result = corrected ? correctOklabLightness(raw) : raw;
    return {
      raw: (t) => raw(t),
      result: (t) => result(t),
      target: (t) => L0 + t * (L1 - L0),
      corrected,
    };
  }

  /**
   * Moves each sample along `scale` until its OKLab L lands on the straight line between the two
   * ends. This is the same bisection chroma.js's correctLightness() runs, but on OKLab L rather
   * than CIE L*. It needs lightness that only rises or only falls along the scale.
   */
  function correctOklabLightness(scale) {
    const L = (t) => scale(t).oklab()[0];
    const L0 = L(0);
    const L1 = L(1);
    const sign = L1 >= L0 ? 1 : -1;
    return (t) => {
      const target = L0 + (L1 - L0) * t;
      let lo = 0, hi = 1, u = t;
      for (let i = 0; i < 24; i++) {
        const diff = (L(u) - target) * sign;
        if (Math.abs(diff) < 1e-4) break;
        if (diff < 0) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return scale(u);
    };
  }

  const positions = (n) => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : i / (n - 1)));

  // ---------- rendering ----------

  // Rendering happens in two layers. render() rebuilds everything that depends on the colors,
  // interpolation space or theme, and caches it in `gradient`. renderSteps() redraws only what
  // depends on the step count, so dragging the Steps slider stays cheap.
  let gradient = null;

  function render() {
    const colors = state.colors.filter((c) => chroma.valid(c)).map((c) => chroma(c).hex());
    renderLValues();
    clearStaleShareLink();
    gradient = null;
    el.proDownload.disabled = true;
    el.qgisDownload.disabled = true;

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

    // Bar
    el.bar.style.background = cssGradient(positions(64).map((t) => s.result(t).hex()));
    el.barLabel.textContent = s.corrected
      ? 'Corrected'
      : 'Uncorrected - Your colors go up and down in lightness. Try Sort by lightness.';
    el.barLabel.classList.toggle('bar-label-warn', !s.corrected);

    // ArcGIS Pro blends each segment in CIELAB, which is exactly a Lab scale through these stops.
    proHexes = positions(PRO_RAMP_COLORS).map((t) => s.result(t).hex());
    el.proPreview.style.background = cssGradient(chroma.scale(proHexes).mode('lab').colors(64));
    const preset = activePreset();
    markActivePreset(preset);
    if (!rampNameEdited) {
      el.rampName.value = preset ? `Phosphor ${preset.name}` : `Phosphor ${proHexes[0]}–${proHexes[proHexes.length - 1]}`;
    }

    gradient = {
      s,
      bezierWarning: state.mode === 'bezier' && colors.length > 5,
      chartBase: chartBase(s),
      dense32: positions(RGB_STOPS).map((t) => s.result(t).hex()),
    };
    setExport(el.outCss, 'css', cssSnippet(positions(CSS_STOPS).map((t) => s.result(t).hex())));
    el.proDownload.disabled = false;
    el.qgisDownload.disabled = false;
    renderSteps();
  }

  function renderSteps() {
    el.stepsOut.textContent = state.steps;
    clearStaleShareLink();
    if (!gradient) return;
    const { s } = gradient;

    const stepColors = positions(state.steps).map((t) => s.result(t));
    const warnings = [];
    if (gradient.bezierWarning) warnings.push('Bezier interpolation works best with 2–5 colors.');
    const clippedCount = stepColors.filter((c) => c.clipped && c.clipped()).length;
    if (clippedCount) {
      warnings.push(`${clippedCount} step${clippedCount > 1 ? 's' : ''} fell outside sRGB and ${clippedCount > 1 ? 'were' : 'was'} clipped (marked “clipped”), which moves lightness slightly.`);
    }
    if (warnings.length) showWarning(warnings.join('<br>')); else hideWarning();

    // Swatches
    const hexes = stepColors.map((c) => c.hex());
    el.swatches.innerHTML = '';
    stepColors.forEach((c, i) => {
      const hex = hexes[i];
      const L = lightness(hex);
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'swatch';
      d.style.background = hex;
      d.style.color = L > 60 ? '#111' : '#fff';
      d.title = 'Click to copy';
      d.innerHTML = `<span>${hex}</span><span>L ${L.toFixed(1)}</span>` +
        (c.clipped && c.clipped() ? '<span class="clip">clipped</span>' : '');
      d.addEventListener('click', () => copy(hex, d.firstChild));
      el.swatches.appendChild(d);
    });

    el.chart.innerHTML = gradient.chartBase + chartDots(hexes);
    setExport(el.outHex, 'list', hexes.map((h) => `"${h}"`).join(', '));
    renderNamedExports(hexes);
  }

  /** Exports that include the ramp name: redrawn when the name or the steps change. */
  function renderNamedExports(hexes = gradient && gradient.stepHexes) {
    if (!gradient) return;
    gradient.stepHexes = hexes;
    setExport(el.outPy, 'python', pythonSnippet(gradient.s, hexes, gradient.dense32));
    setExport(el.outQgis, 'xml', qgisXml(rampName(), gradient.dense32));
  }

  // Coalesce Steps slider input to at most one redraw per animation frame.
  let stepsFrame = 0;
  function scheduleSteps() {
    if (stepsFrame) return;
    stepsFrame = requestAnimationFrame(() => { stepsFrame = 0; renderSteps(); });
  }

  function cssGradient(hexes) {
    return `linear-gradient(to right, ${hexes.join(', ')})`;
  }

  // ---------- code exports ----------

  const CSS_STOPS = 17; // browsers blend CSS gradients in sRGB, so sample densely
  const RGB_STOPS = 32; // matplotlib and QGIS blend linearly in RGB between these samples
  const exportText = {};

  const hexRows = (hexes, perRow, indent, quote) => {
    const rows = [];
    for (let i = 0; i < hexes.length; i += perRow) {
      rows.push(indent + hexes.slice(i, i + perRow).map((h) => quote + h + quote).join(', '));
    }
    return rows.join(',\n');
  };

  function cssSnippet(hexes) {
    return `background: linear-gradient(\n  to right,\n${hexRows(hexes, 4, '  ', '')}\n);`;
  }

  const rampName = () => el.rampName.value.trim() || 'Phosphor';

  function pythonSnippet(s, hexes, dense) {
    const name = rampName().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'phosphor';
    const space = el.mode.options[el.mode.selectedIndex].text;
    const how = s.corrected
      ? `${space} interpolation, lightness-corrected (linear OKLab L).`
      : `${space} interpolation, uncorrected (the colors go up and down in lightness).`;
    return [
      'from matplotlib.colors import LinearSegmentedColormap, ListedColormap',
      '',
      `# Phosphor gradient: ${hexes[0]} to ${hexes[hexes.length - 1]}, ${how}`,
      `# ${RGB_STOPS} samples; matplotlib blends between them.`,
      'colors = [',
      hexRows(dense, 4, '    ', '"') + ',',
      ']',
      `cmap = LinearSegmentedColormap.from_list("${name}", colors)`,
      '',
      `# The ${hexes.length} discrete steps, for classed maps and charts.`,
      `cmap_steps = ListedColormap([`,
      hexRows(hexes, 4, '    ', '"') + ',',
      `], name="${name}_steps")`,
      '',
      '# Usage: plt.imshow(data, cmap=cmap)',
    ].join('\n');
  }

  const xmlAttr = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const qgisColor = (hex) => chroma(hex).rgb().join(',') + ',255';

  /** A QGIS style file (Style Manager > Import) holding one gradient color ramp. */
  function qgisXml(name, hexes) {
    const stops = hexes.slice(1, -1)
      .map((h, i) => `${+((i + 1) / (hexes.length - 1)).toFixed(6)};${qgisColor(h)}`)
      .join(':');
    const opt = (key, value) => `        <Option type="QString" name="${key}" value="${value}"/>`;
    return [
      '<!DOCTYPE qgis_style>',
      '<qgis_style version="2">',
      '  <symbols/>',
      '  <colorramps>',
      `    <colorramp type="gradient" name="${xmlAttr(name)}" tags="Phosphor">`,
      '      <Option type="Map">',
      opt('color1', qgisColor(hexes[0])),
      opt('color2', qgisColor(hexes[hexes.length - 1])),
      opt('discrete', '0'),
      opt('rampType', 'gradient'),
      opt('stops', stops),
      '      </Option>',
      '    </colorramp>',
      '  </colorramps>',
      '</qgis_style>',
    ].join('\n');
  }

  function downloadText(text, filename, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const safeFilename = (name) => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/#/g, '');

  // A small highlighter for the export formats. Hex colors get a color chip.
  const TOKEN_RULES = {
    list: [['str', /"[^"\n]*"/y]],
    css: [
      ['prop', /[a-z-]+(?=\s*:)/y],
      ['fn', /[a-z-]+(?=\()/y],
      ['hex', /#[0-9a-f]{6}\b/iy],
      ['kw', /\bto (?:right|left|top|bottom)\b/y],
    ],
    xml: [
      ['com', /<!DOCTYPE[^>]*>/y],
      ['kw', /<\/?[\w:-]+|\/?>/y],
      ['prop', /[\w:-]+(?==)/y],
      ['str', /"[^"]*"/y],
    ],
    python: [
      ['str', /"[^"\n]*"/y],
      ['com', /#.*/y],
      ['kw', /\b(?:from|import|as)\b/y],
      ['fn', /\b[A-Za-z_]\w*(?=\()/y],
      ['num', /\b\d+\b/y],
    ],
  };
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function highlight(code, lang) {
    const rules = TOKEN_RULES[lang].concat([['', /\w+/y]]);
    let html = '';
    let i = 0;
    while (i < code.length) {
      let hit = null;
      for (const [cls, re] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m[0]) { hit = [cls, m[0]]; break; }
      }
      if (!hit) { html += escapeHtml(code[i]); i += 1; continue; }
      const [cls, text] = hit;
      const hex = /^"?(#[0-9a-f]{6})"?$/i.exec(text);
      const rgb = /^"(\d{1,3},\d{1,3},\d{1,3}),255"$/.exec(text);
      const swatch = cls === 'com' ? null : hex ? hex[1] : rgb ? `rgb(${rgb[1]})` : null;
      const chip = swatch ? `<i class="chip" style="background:${swatch}"></i>` : '';
      html += cls ? `${chip}<span class="tok-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
      i += text.length;
    }
    return html;
  }

  function setExport(codeEl, lang, text) {
    exportText[codeEl.id] = text;
    codeEl.innerHTML = highlight(text, lang);
  }

  const CHART = { W: 600, H: 260, pad: { l: 36, r: 12, t: 12, b: 28 } };
  const chartX = (t) => CHART.pad.l + t * (CHART.W - CHART.pad.l - CHART.pad.r);
  const chartY = (L) => CHART.pad.t + (1 - L / 100) * (CHART.H - CHART.pad.t - CHART.pad.b);
  const themeColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function chartDots(hexes) {
    const stroke = themeColor('--chart-corrected');
    return positions(hexes.length).map((t, i) =>
      `<circle cx="${chartX(t)}" cy="${chartY(lightness(hexes[i]))}" r="5" fill="${hexes[i]}" stroke="${stroke}" stroke-width="1.5"/>`).join('');
  }

  /** Grid, curves, legend and stats: everything on the chart except the step dots. */
  function chartBase(s) {
    const { W, H, pad } = CHART;
    const x = chartX, y = chartY, col = themeColor;

    const line = (fn, n = 120) =>
      positions(n).map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(fn(t)).toFixed(1)}`).join('');

    let out = '';
    for (let L = 0; L <= 100; L += 25) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(L)}" y2="${y(L)}" stroke="${col('--chart-grid')}"/>`;
      out += `<text x="${pad.l - 6}" y="${y(L) + 4}" text-anchor="end">${L}</text>`;
    }
    out += `<text x="${pad.l}" y="${H - 8}">start</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end">end</text>`;

    // Actual OKLab L is measured from the displayed (gamut-clipped) hex.
    out += `<path d="${line(s.target, 2)}" fill="none" stroke="${col('--chart-target')}" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    if (s.corrected) {
      out += `<path d="${line((t) => lightness(s.raw(t).hex()))}" fill="none" stroke="${col('--chart-raw')}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    }
    out += `<path d="${line((t) => lightness(s.result(t).hex()))}" fill="none" stroke="${col('--chart-corrected')}" stroke-width="2"/>`;

    const maxDev = (fn) => Math.max(...positions(200).map((t) => Math.abs(lightness(fn(t).hex()) - s.target(t))));
    el.legendResult.textContent = s.corrected ? 'Corrected' : 'Uncorrected';
    el.legendRaw.hidden = !s.corrected;
    el.stats.textContent = s.corrected
      ? `Largest gap from the linear target: corrected ${maxDev(s.result).toFixed(2)}, uncorrected ${maxDev(s.raw).toFixed(2)} (OKLab L, 0–100).`
      : `Largest gap from the linear target: ${maxDev(s.result).toFixed(2)} (OKLab L, 0–100; uncorrected).`;
    return out;
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
    const name = rampName();
    const label = el.proDownload.textContent;
    el.proDownload.disabled = true;
    el.proDownload.textContent = 'Building…';
    try {
      const SQL = await loadSqlJs();
      const blob = new Blob([buildStylx(SQL, name, proHexes)], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = safeFilename(name) + '.stylx';
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
      li.querySelector('.lval').textContent = chroma.valid(c) ? 'L ' + Math.round(lightness(c)) : '';
    });
  }

  function swap(a, b) {
    [state.colors[a], state.colors[b]] = [state.colors[b], state.colors[a]];
  }

  // ---------- preset palettes ----------

  // ColorBrewer sequential schemes (9 classes) ship with chroma.js as chroma.brewer.
  const brewer = (names) => names.map((name) => ({ name, colors: chroma.brewer[name] }));
  const PRESET_GROUPS = [
    {
      title: 'Stevens',
      presets: [
        { name: 'Tropics', colors: ['#c3f4e9', '#b6e5eb', '#a9d6ec', '#9ac8ee', '#8bbaef', '#7aacf0', '#8898eb', '#9682e5', '#b85fd5', '#c244b4', '#be338e', '#b71f69', '#ad0045'] },
        { name: 'Frostfire', colors: ['#eff7fa', '#cfdff2', '#b0c7ea', '#90b0e0', '#8695cf', '#8178ba', '#7b5ca6', '#895899', '#a96b92', '#c8808a', '#e29786', '#f2b290', '#facfa6', '#fcedc4'] },
        { name: 'Smoggy Sky', colors: ['#ffffff', '#e2eff9', '#c5dff2', '#e1c794', '#eeac49', '#dd9a3f', '#cd8837', '#bc772e', '#ac6626', '#9c551e', '#8c4416', '#7c340f', '#672709', '#541b01'] },
      ],
    },
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
      rampNameEdited = false;
      buildList();
      render();
    });
  }

  // ---------- URL state ----------

  // The URL only changes when someone clicks Share. A shared (or opened) link is cleared on the
  // next edit, so reloading never brings back a palette the visitor has since changed.
  const stateHash = () => '#' + new URLSearchParams({
    c: state.colors.map((c) => c.replace('#', '')).join(','),
    m: state.mode, n: String(state.steps),
  }).toString();

  function clearStaleShareLink() {
    if (location.hash && location.hash !== stateHash()) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  async function sharePalette() {
    history.replaceState(null, '', stateHash());
    let copied = false;
    try { await navigator.clipboard.writeText(location.href); copied = true; } catch (e) { /* show the link instead */ }
    el.shareStatus.textContent = copied
      ? 'Link copied. Paste it anywhere, or bookmark this page to come back to this palette.'
      : 'Your link is in the address bar. Copy it, or bookmark this page to come back to this palette.';
    el.shareBtnLabel.textContent = copied ? 'Link copied' : 'Link ready';
    clearTimeout(sharePalette.timer);
    sharePalette.timer = setTimeout(() => {
      el.shareStatus.textContent = SHARE_PROMPT;
      el.shareBtnLabel.textContent = 'Copy share link';
    }, 4000);
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
    state.colors.sort((a, b) => (chroma.valid(a) ? lightness(a) : 0) - (chroma.valid(b) ? lightness(b) : 0));
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
  el.steps.addEventListener('input', () => { state.steps = +el.steps.value; scheduleSteps(); });
  el.share.addEventListener('click', sharePalette);
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(exportText[b.dataset.copy], b)));
  el.rampName.addEventListener('input', () => { rampNameEdited = el.rampName.value.trim() !== ''; renderNamedExports(); });
  el.qgisDownload.addEventListener('click', () =>
    downloadText(exportText['out-qgis'], safeFilename(rampName()) + '.xml', 'application/xml'));
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
