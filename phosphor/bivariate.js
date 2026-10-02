/* Phosphor — bivariate grids, and their legends in the Legend Lab.
 *
 * Kept apart from app.js so it can be removed cleanly: delete this file and bivariate.css, then the
 * lines marked "bivariate" in index.html and app.js. It uses helpers app.js shares as
 * window.Phosphor.
 *
 * The grid mixes two axes in OKLab. Each axis runs in a straight OKLab line from the both-low color
 * to its high color, so its lightness changes evenly. Cell (x, y) adds both axes' offsets from the
 * both-low color: base + (X[x] - base) + (Y[y] - base). Lightness therefore falls (or rises) with
 * each step along either axis, and the top-right cell carries both hues. Colors outside sRGB keep
 * their lightness and hue and lose chroma, as elsewhere in Phosphor.
 */
(function () {
  'use strict';
  const P = window.Phosphor;
  if (!P) return;
  const $ = (id) => document.getElementById(id);

  // Presets: each is a published 3 × 3 grid, top row (high Y) first, and takes its three anchors
  // from its corners: Joshua Stevens's bivariate choropleth guide (2015), a pink-blue scheme from
  // an ArcGIS Pro bivariate style, and Cynthia Brewer's blue–gold scheme. At 3 × 3 the published
  // colors are used as is; other sizes interpolate through them (see buildGrid).
  const preset = (name, rows) => ({ name, rows, base: rows[2][0], x: rows[2][2], y: rows[0][0] });
  /** A preset's published grid as cells[y][x], low first. */
  const presetCells = (p) => p.rows.slice().reverse();
  const PRESET_GROUPS = [
    {
      title: 'Stevens',
      presets: [
        preset('Red–Blue', [['#64acbe', '#627f8c', '#574249'], ['#b0d5df', '#ad9ea5', '#985356'], ['#e8e8e8', '#e4acac', '#c85a5a']]),
        preset('Teal–Pink', [['#be64ac', '#8c62aa', '#3b4994'], ['#dfb0d6', '#a5add3', '#5698b9'], ['#e8e8e8', '#ace4e4', '#5ac8c8']]),
        preset('Blue–Green', [['#73ae80', '#5a9178', '#2a5a5b'], ['#b8d6be', '#90b2b3', '#567994'], ['#e8e8e8', '#b5c0da', '#6c83b5']]),
        preset('Gold–Purple', [['#9972af', '#976b82', '#804d36'], ['#cbb8d7', '#c8ada0', '#af8e53'], ['#e8e8e8', '#e4d9ac', '#c8b35a']]),
      ],
    },
    {
      title: 'Brewer',
      presets: [
        // From a bivariate scheme saved by ArcGIS Pro.
        preset('Blue–Pink', [['#de4fa6', '#843598', '#2a1a8a'], ['#e39bcc', '#9080bd', '#3d64ad'], ['#e9e6f2', '#9ccae1', '#4fadd0']]),
        // Cynthia Brewer's blue–gold scheme.
        preset('Blue–Gold', [['#f3b300', '#b36600', '#000000'], ['#f3e6b3', '#b3b3b3', '#376387'], ['#f3f3f3', '#b4d3e1', '#509dc2']]),
      ],
    },
  ];
  const PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

  const DEFAULT_PRESET = PRESETS.find((p) => p.name === 'Red–Blue');
  // `published` holds a preset's 3 × 3 grid (cells[y][x], low first) until an anchor is edited.
  // `preset` and `swapped` record where a published grid came from, for share links. `xy` is a
  // chosen both-high (top-right) color, or null to mix it from the other three.
  const state = {
    size: 3, curve: 'linear', mode: 'oklab', xy: null, base: DEFAULT_PRESET.base, x: DEFAULT_PRESET.x, y: DEFAULT_PRESET.y,
    published: presetCells(DEFAULT_PRESET), preset: DEFAULT_PRESET.name, swapped: false,
  };
  /** A preset's published grid, mirrored across its diagonal when X and Y are swapped. */
  const transpose = (cells) => cells.map((row, y) => row.map((_, x) => cells[x][y]));
  let nameEdited = false;
  let grid = null;

  const el = {
    presets: $('biv-presets'), presetsToggle: $('biv-presets-toggle'), map: $('biv-map'), proPreview: $('biv-pro-preview'), grid: $('biv-grid'), note: $('biv-note'), cvd: $('biv-cvd'),
    name: $('biv-name'), outHex: $('biv-out-hex'), outPy: $('biv-out-py'), outR: $('biv-out-r'), outQgis: $('biv-out-qgis'),
    qgisCopy: document.querySelector('[data-copy="biv-out-qgis"]'),
    pro: $('biv-pro-download'), proHint: $('biv-pro-hint'), swap: $('biv-swap'),
    anchors: ['base', 'x', 'y', 'xy'].map((k) => ({ key: k, text: $('biv-' + k), picker: $('biv-' + k + '-picker') })),
    xyAuto: $('biv-xy-auto'),
    legendOptions: $('biv-legend-options'),
    curveBtns: [...document.querySelectorAll('.biv-curve-btn')],
    mode: $('biv-mode'),
    share: $('biv-share'), shareStatus: $('biv-share-status'), shareLabel: $('biv-share-label'),
  };

  // ---------- the grid ----------

  // Lightness curves, as on the other tabs: 'up' bows each axis's lightness below a straight line
  // (a parabola opening upward) and 'down' above it, at full strength (1). Along both axes the
  // grid's lightness becomes a bowl or a dome. Cells keep their hue and chroma.
  const CURVES = { linear: 0, up: 1, down: -1 };
  const CURVE_LABELS = { linear: 'linear', up: 'parabolic up', down: 'parabolic down' };

  /**
   * cells[y][x], y and x from 0 (low) to n - 1 (high).
   * Custom grids: each axis is a lightness-corrected ramp from the both-low color to its high
   * color in the chosen interpolation space (as on the Sequential tab), and every other cell
   * combines the two axes' offsets from the both-low color in OKLab.
   * Presets: 3 × 3 is the published colors. Other sizes interpolate through them in the chosen
   * space, along each published row and then each column, so the four corners never change and
   * the steps between follow the published grid (as Sequential keeps its stop colors).
   */
  function buildGrid(st) {
    const n = st.size;
    const mode = st.mode || 'oklab';
    const k = CURVES[st.curve || 'linear'];
    const fromPublished = !!st.published;
    const exact = fromPublished && n === 3;
    const b = chroma(st.base).oklab();
    const X = chroma(st.x).oklab();
    const Y = chroma(st.y).oklab();
    // The curve's lightness offset for a cell t, u along the axes (0 to 1), in OKLab L.
    const bend = (t, u) => k * (Math.abs(X[0] - b[0]) * t * (t - 1) + Math.abs(Y[0] - b[0]) * u * (u - 1));
    const ts = P.positions(n);

    let base; // base[y][x] in OKLab, before any curve
    if (fromPublished && !exact) {
      const rows = st.published.map((row) => { const s = P.makeScale(row, mode); return ts.map((t) => s(t)); });
      base = ts.map((u) => ts.map((_, x) => P.makeScale([rows[0][x], rows[1][x], rows[2][x]], mode)(u).oklab()));
    } else if (!fromPublished && st.xy) {
      // A chosen top-right color: each edge is a lightness-corrected ramp between its corners in the
      // chosen space, and the inside blends the four edges in OKLab (a Coons patch), so every
      // corner is exactly as chosen.
      const ramp = (from, to) => { const s = P.buildSamplers([from, to], mode).result; return ts.map((t) => s(t).oklab()); };
      const bottom = ramp(st.base, st.x), top = ramp(st.y, st.xy), left = ramp(st.base, st.y), right = ramp(st.x, st.xy);
      const XY = chroma(st.xy).oklab();
      base = ts.map((u, y) => ts.map((t, x) => [0, 1, 2].map((i) =>
        (1 - u) * bottom[x][i] + u * top[x][i] + (1 - t) * left[y][i] + t * right[y][i]
        - ((1 - t) * (1 - u) * b[i] + t * (1 - u) * X[i] + (1 - t) * u * Y[i] + t * u * XY[i]))));
    } else if (!fromPublished) {
      const axisX = P.buildSamplers([st.base, st.x], mode).result;
      const axisY = P.buildSamplers([st.base, st.y], mode).result;
      const xs = ts.map((t) => axisX(t).oklab());
      const ys = ts.map((u) => axisY(u).oklab());
      base = ys.map((yl) => xs.map((xl) => [0, 1, 2].map((i) => b[i] + (xl[i] - b[i]) + (yl[i] - b[i]))));
    }

    const cells = [];
    let reduced = 0, clamped = 0;
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) {
        if (exact && !k) {
          const hex = st.published[y][x];
          row.push({ x, y, hex, L: P.lightness(hex), reduced: false });
          continue;
        }
        const lab = exact ? chroma(st.published[y][x]).oklab() : base[y][x];
        const target = lab[0] + bend(ts[x], ts[y]);
        const L = Math.min(1, Math.max(0, target));
        if (L !== target) clamped++;
        const c = P.inGamutOklab(L, lab[1], lab[2]);
        if (c.reduced) reduced++;
        const hex = c.hex();
        row.push({ x, y, hex, L: P.lightness(hex), reduced: !!c.reduced });
      }
      cells.push(row);
    }
    return { n, cells, reduced, clamped, published: exact && !k, fromPublished, exact };
  }

  const allCells = (g) => g.cells.flat();
  /** Rows from the top (high Y) down, as a legend or ArcGIS Pro lays them out. */
  const topRows = (g) => g.cells.slice().reverse();

  // Grids compare every pair of cells, including ones that touch, where the ramps compare only
  // colors at least a quarter (or, across a diverging midpoint, an eighth) of the ramp apart. So
  // the grid cutoff sits a little lower than the ramps' 4.5: still well above the ~2 that's just
  // noticeable. It clears Red–Blue, whose closest pair under protanopia is 3.7 apart, and still
  // flags grids whose cells truly merge (Teal–Pink at 2.0, Blue–Pink at 0.7).
  const CVD_GRID_MIN_DE = 3.5;
  // High X and High Y count as one hue when their OKLCh hues sit closer than this (chroma, 0–100
  // scale, below SAME_HUE_MIN_C has no hue to speak of).
  const SAME_HUE_MAX_DEG = 45;
  const SAME_HUE_MIN_C = 1;

  /**
   * Whether the grid holds up under protanopia and deuteranopia, by the ramps' rule with the grid
   * cutoff: a pair of cells fails if it drops below CVD_GRID_MIN_DE and loses more than half its
   * normal contrast. A pair that's already that close with normal vision (say, High X and High Y
   * set to the same color) fails too: it looks alike to everyone, colorblind or not.
   *
   * So does a grid whose High X and High Y corners share a hue, with normal vision or simulated:
   * the two variables then differ only in lightness, whatever that lightness is. (Blue–Pink and
   * Teal–Pink's corners sit 2–6° apart under simulation; every preset's sit 115° or more apart
   * with normal vision, and the rest stay that far apart simulated.)
   */
  function assess(g) {
    const cells = allCells(g);
    const hiX = cells.find((c) => c.x === g.n - 1 && c.y === 0);
    const hiY = cells.find((c) => c.x === 0 && c.y === g.n - 1);
    const sameHue = (m) => {
      const [a, b] = [hiX, hiY].map((c) => P.simulatedOklab(c.hex, m));
      const chroma = (p) => 100 * Math.hypot(p[1], p[2]);
      // Two near-grays share "no hue"; one gray beside a color still tells the axes apart.
      if (chroma(a) < SAME_HUE_MIN_C || chroma(b) < SAME_HUE_MIN_C) return chroma(a) < SAME_HUE_MIN_C && chroma(b) < SAME_HUE_MIN_C;
      const dh = Math.abs(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) * 180 / Math.PI;
      return Math.min(dh, 360 - dh) < SAME_HUE_MAX_DEG;
    };
    if (sameHue(P.IDENTITY)) return { safe: false, hue: 'normal' };
    const normal = cells.map((c) => P.simulatedOklab(c.hex, P.IDENTITY));
    const d = (p, i, j) => 100 * Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1], p[i][2] - p[j][2]);
    let alike = false;
    for (let i = 0; i < cells.length && !alike; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        if (d(normal, i, j) < CVD_GRID_MIN_DE) { alike = true; break; }
      }
    }
    if (alike) return { safe: false, alike };
    const matrices = ['cvd-protanopia', 'cvd-deuteranopia'].map(P.readCvdMatrix);
    if (matrices.some(sameHue)) return { safe: false, hue: 'cvd' };
    const safe = matrices.every((m) => {
      const sim = cells.map((c) => P.simulatedOklab(c.hex, m));
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const seen = d(sim, i, j);
          if (seen < CVD_GRID_MIN_DE && seen < P.CVD_KEEP * d(normal, i, j)) return false;
        }
      }
      return true;
    });
    return { safe, alike };
  }

  // ---------- rendering ----------

  function render() {
    grid = buildGrid(state);
    const { n } = grid;

    el.grid.style.setProperty('--n', n);
    el.grid.innerHTML = '';
    topRows(grid).forEach((row) => row.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'biv-cell';
      b.style.background = c.hex;
      const where = `X ${c.x + 1}, Y ${c.y + 1}`;
      b.title = `${where}: ${c.hex} · L ${c.L.toFixed(1)}${c.reduced ? ', muted to fit sRGB' : ''}. Click to copy.`;
      b.setAttribute('aria-label', `${where}: ${c.hex}, lightness ${c.L.toFixed(1)}. Copy`);
      b.addEventListener('click', () => P.copy(c.hex));
      el.grid.appendChild(b);
    }));

    const { safe, alike, hue } = assess(grid);
    el.cvd.hidden = false;
    el.cvd.className = 'cvd-badge ' + (safe ? 'is-safe' : 'is-unsafe');
    el.cvd.title = hue === 'normal' ? 'Not colorblind-safe: High X and High Y share a hue, so the two variables differ only in lightness.'
      : hue === 'cvd' ? 'Not red-green colorblind-safe: with simulated protanopia or deuteranopia, High X and High Y look like the same hue, so the two variables differ only in lightness.'
      : alike ? 'Not colorblind-safe: some cells look alike even with normal vision, so no one can tell them apart.'
      : P.CVD_TITLE[safe];
    el.cvd.innerHTML = P.cvdIcon(safe) + (safe ? 'colorblind-safe' : 'not colorblind-safe');

    const notes = [];
    if (grid.clamped) notes.push(`${grid.clamped} cell${grid.clamped > 1 ? 's' : ''} ran past black or white; try lighter high colors.`);
    el.note.hidden = !notes.length;
    el.note.textContent = notes.join(' ');

    el.anchors.forEach((a) => {
      if (document.activeElement !== a.text) a.text.value = corner(a.key);
      a.picker.value = chroma(corner(a.key)).hex();
      a.text.classList.remove('invalid');
    });
    const xyText = el.anchors.find((a) => a.key === 'xy').text;
    xyText.classList.toggle('is-auto', !state.xy);
    xyText.title = state.xy ? '' : 'Mixed from the other three colors. Type or pick a color to set your own.';
    el.xyAuto.hidden = !state.xy;
    const preset = !state.xy && PRESETS.find((p) => p.base === state.base && p.x === state.x && p.y === state.y);
    el.presets.querySelectorAll('.preset-card').forEach((b) => b.setAttribute('aria-pressed', String(!!preset && b.dataset.name === preset.name)));
    if (!nameEdited) el.name.value = `Phosphor ${preset ? preset.name : 'bivariate'} ${n}×${n}`;

    el.curveBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.curve === state.curve)));
    el.proPreview.style.setProperty('--n', n);
    el.proPreview.innerHTML = miniCells(grid);
    renderExports();
    renderMap();
    clearStaleLink();
  }

  // ---------- share links ----------
  // Like the other tabs' links, in the address-bar hash: t=b, the size (n), the curve (k, when not
  // linear), the three anchors (b, x, y) and, for a preset's published grid, its name (p) and
  // whether X and Y were swapped (s). A link clears once the grid is edited.

  const SHARE_PROMPT = 'Like this palette? Get a link to bookmark it or share it.';
  const isBivariateLink = (hash) => /^#(?:.*&)?t=b(?:&|$)/.test(hash);

  function stateHash() {
    const p = new URLSearchParams({ t: 'b', n: String(state.size) });
    if (state.curve !== 'linear') p.set('k', state.curve);
    if (state.mode !== 'oklab') p.set('m', state.mode);
    ['base', 'x', 'y'].forEach((k) => p.set(k === 'base' ? 'b' : k, state[k].replace('#', '')));
    if (state.xy) p.set('h', state.xy.replace('#', ''));
    if (state.published && state.preset) {
      p.set('p', state.preset);
      if (state.swapped) p.set('s', '1');
    }
    return '#' + p.toString();
  }

  function clearStaleLink() {
    if (isBivariateLink(location.hash) && location.hash !== stateHash()) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function readLink() {
    if (!isBivariateLink(location.hash)) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    const hex = (v) => (v && /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : null);
    const [base, x, y] = ['b', 'x', 'y'].map((k) => hex(p.get(k)));
    if (!base || !x || !y) return false;
    const size = [2, 3, 4].includes(+p.get('n')) ? +p.get('n') : 3;
    const curve = ['up', 'down'].includes(p.get('k')) ? p.get('k') : 'linear';
    const modes = [...el.mode.options].map((o) => o.value);
    const mode = modes.includes(p.get('m')) ? p.get('m') : 'oklab';
    const pre = PRESETS.find((q) => q.name === p.get('p'));
    const swapped = !!pre && p.get('s') === '1';
    Object.assign(state, { size, curve, mode, base, x, y, xy: hex(p.get('h')), preset: pre ? pre.name : null, swapped });
    el.mode.value = mode;
    state.published = pre ? (swapped ? transpose(presetCells(pre)) : presetCells(pre)) : null;
    document.querySelectorAll('input[name="biv-size"]').forEach((r) => { r.checked = +r.value === size; });
    return true;
  }

  async function shareGrid() {
    history.replaceState(null, '', stateHash());
    let copied = false;
    try { await navigator.clipboard.writeText(location.href); copied = true; } catch (e) { /* show the link instead */ }
    el.shareStatus.textContent = copied
      ? 'Link copied. Paste it anywhere, or bookmark this page to come back to this palette.'
      : 'Your link is in the address bar. Copy it, or bookmark this page to come back to this palette.';
    el.shareLabel.textContent = copied ? 'Link copied' : 'Link ready';
    clearTimeout(shareGrid.timer);
    shareGrid.timer = setTimeout(() => {
      el.shareStatus.textContent = SHARE_PROMPT;
      el.shareLabel.textContent = 'Copy share link';
    }, 4000);
  }

  /** An anchor's color; Both high shows the grid's own top-right color while it's mixed. */
  const corner = (key) => (key === 'xy' && !state.xy ? grid.cells[grid.n - 1][grid.n - 1].hex : state[key]);

  /** A grid's cells as inline <i> tiles, top row first, for small previews. */
  const miniCells = (g) => topRows(g).flat().map((c) => `<i style="background:${c.hex}"></i>`).join('');

  const schemeName = () => el.name.value.trim() || 'Phosphor bivariate';
  const codeName = () => schemeName().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, 'p_') || 'phosphor_bivariate';

  /** How this grid was made, for the export comments. */
  function howMade() {
    const curve = state.curve === 'linear' ? '' : `, lightness ${CURVE_LABELS[state.curve]}`;
    const space = el.mode.options[el.mode.selectedIndex].text;
    return grid.exact ? `the preset’s published colors${curve}`
      : grid.fromPublished ? `interpolated in ${space} from the preset’s published 3 × 3 colors${curve}`
      : state.xy ? `four corners, edges in ${space}, blended in OKLab${curve}`
      : `axes in ${space}, combined in OKLab${curve}`;
  }

  function renderExports() {
    const { n } = grid;
    const rows = topRows(grid).map((row) => row.map((c) => `"${c.hex}"`).join(', '));
    P.setExport(el.outHex, 'list', rows.join(',\n'));

    const name = codeName();
    P.setExport(el.outPy, 'python', [
      `# Phosphor bivariate grid (${n} × ${n}), ${howMade()}.`,
      '# Rows run from high Y (top) to low Y; columns from low X to high X.',
      `${name} = [`,
      ...rows.map((r) => `    [${r}],`),
      ']',
      '',
      `# The color for classes x and y, each from 0 (low) to ${n - 1} (high):`,
      `#   ${name}[${n - 1} - y][x]`,
    ].join('\n'));

    const named = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) named.push(`"${x + 1}-${y + 1}" = "${grid.cells[y][x].hex}"`);
    const perLine = n;
    const lines = [];
    for (let i = 0; i < named.length; i += perLine) lines.push('  ' + named.slice(i, i + perLine).join(', '));
    P.setExport(el.outR, 'r', [
      'library(biscale)',
      '',
      `# Phosphor bivariate palette (${n} × ${n}), ${howMade()}.`,
      '# Names are "x-y" classes from',
      `# 1 (low) to ${n} (high), as biscale's bi_class() labels them.`,
      `${name} <- c(`,
      lines.join(',\n'),
      ')',
      '',
      '# Usage:',
      `#   bi_scale_fill(pal = ${name}, dim = ${n})`,
      `#   bi_legend(pal = ${name}, dim = ${n})`,
    ].join('\n'));

    // The Bivariate QGIS Plugin's "Custom / Staridas import": one "A1 #hex" line per class, the
    // letter the X class (A low) and the number the Y class (1 low), in its order (A1, A2, … B1, …).
    // It takes 3 × 3 to 5 × 5 grids.
    const qgisOk = n >= 3;
    const qgisLines = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) qgisLines.push(`${String.fromCharCode(65 + x)}${y + 1} ${grid.cells[y][x].hex}`);
    P.setExport(el.outQgis, 'css', qgisOk ? qgisLines.join('\n') : 'The Bivariate QGIS Plugin takes 3 × 3, 4 × 4 and 5 × 5 grids; choose 3 × 3 or 4 × 4.');
    el.qgisCopy.disabled = !qgisOk;

    el.proHint.textContent = `A ${n} × ${n} bivariate color scheme for ArcGIS Pro's Bivariate Colors symbology. Add the file under Catalog → Styles → Add Style, choose Bivariate Colors with a ${n} × ${n} grid, and pick the scheme from the color scheme menu.`;
  }

  // ---------- the map ----------
  // The same counties as the Map preview on the other tabs, baked with two values per county by
  // assets/phosphor/make_specimens.py (R: X value, G: Y value, B: borders, A: 0 where empty). Each
  // value is ranked, so dividing it into n equal ranges gives n classes of equal size. Borders and
  // empty areas take the panel color, as on the other tabs.

  let mapData = null;
  (function loadMap() {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      mapData = { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data };
      renderMap();
    };
    img.src = 'assets/map-bivariate.png';
  })();

  function renderMap() {
    if (!mapData || !grid || !el.map.offsetParent) return; // hidden when the row is narrow
    const { w, h, d } = mapData;
    const n = grid.n;
    const colors = grid.cells.map((row) => row.map((c) => chroma(c.hex).rgb()));
    const bg = chroma(getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()).rgb();
    if (el.map.width !== w) { el.map.width = w; el.map.height = h; }
    const ctx = el.map.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = img.data;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      let c = bg;
      if (d[o + 3] > 127) {
        c = colors[Math.min(n - 1, (d[o + 1] * n) >> 8)][Math.min(n - 1, (d[o] * n) >> 8)];
        const a = (d[o + 2] / 255) * 0.85;
        if (a) c = [c[0] + (bg[0] - c[0]) * a, c[1] + (bg[1] - c[1]) * a, c[2] + (bg[2] - c[2]) * a];
      }
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Borders follow the panel color, so redraw when the theme changes; the map can also appear when
  // the row widens.
  new MutationObserver(renderMap).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new ResizeObserver(renderMap).observe(el.grid);

  // ---------- ArcGIS Pro .stylx ----------
  // Matches a bivariate scheme saved by ArcGIS Pro 3.5: a CIMFixedColorRamp whose colors run row by
  // row from the top left (high Y, low X), marked with "arrangement": "Bivariate".

  const DEFAULT_RGB = { type: 'CIMICCColorSpace', url: 'Default RGB' };
  function cimBivariateScheme(g) {
    return {
      type: 'CIMFixedColorRamp',
      colorSpace: DEFAULT_RGB,
      colors: topRows(g).flat().map((c) => ({ type: 'CIMRGBColor', colorSpace: DEFAULT_RGB, values: [...chroma(c.hex).rgb(), 100] })),
      arrangement: 'Bivariate',
    };
  }

  async function downloadStylx() {
    const name = schemeName();
    const label = el.pro.textContent;
    el.pro.disabled = true;
    el.pro.textContent = 'Building…';
    try {
      const SQL = await P.loadSqlJs();
      const bytes = P.buildStylx(SQL, name, null, cimBivariateScheme(grid), 'Phosphor;bivariate');
      P.downloadText(bytes, P.safeFilename(name) + '.stylx', 'application/octet-stream');
    } catch (err) {
      el.note.hidden = false;
      el.note.textContent = 'Could not build the ArcGIS Pro style: ' + err.message;
    } finally {
      el.pro.textContent = label;
      el.pro.disabled = false;
    }
  }

  // ---------- controls ----------

  // The same dropdown of cards as the Sequential and Diverging tabs, with a 3 × 3 preview.
  function buildPresets() {
    el.presets.innerHTML = PRESET_GROUPS.map((group) => `
      <h2>${group.title}</h2>
      <div class="preset-grid">
        ${group.presets.map((p) => {
          const g = buildGrid({ size: 3, base: p.base, x: p.x, y: p.y, published: presetCells(p) });
          const safe = assess(g).safe;
          return `
          <button type="button" class="preset-card" data-name="${p.name}" aria-pressed="false">
            <span class="preset-preview biv-card-preview" style="--n: 3">${miniCells(g)}</span>
            <span class="preset-meta">
              <span class="preset-name">${p.name}</span>
              <span class="cvd-mark" role="img" aria-label="${safe ? 'Colorblind-safe' : 'Not colorblind-safe'}" title="${P.CVD_TITLE[safe]}">${P.cvdIcon(safe)}</span>
            </span>
          </button>`;
        }).join('')}
      </div>`).join('');
  }

  el.presetsToggle.addEventListener('click', () => {
    const open = el.presets.hidden;
    el.presets.hidden = !open;
    el.presetsToggle.setAttribute('aria-expanded', String(open));
    el.presetsToggle.textContent = open ? 'Hide preset palettes' : 'Show preset palettes';
  });

  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('.preset-card');
    if (!b) return;
    const p = PRESETS.find((q) => q.name === b.dataset.name);
    Object.assign(state, { base: p.base, x: p.x, y: p.y, xy: null, published: presetCells(p), preset: p.name, swapped: false });
    nameEdited = false;
    render();
  });
  document.querySelectorAll('input[name="biv-size"]').forEach((r) => r.addEventListener('change', () => {
    state.size = +r.value;
    render();
  }));
  el.anchors.forEach((a) => {
    a.picker.addEventListener('input', () => { state[a.key] = a.picker.value; dropPublished(); render(); });
    a.text.addEventListener('input', () => {
      const v = a.text.value.trim();
      const hex = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? (v[0] === '#' ? v : '#' + v) : null;
      if (hex && chroma.valid(hex)) {
        const v2 = chroma(hex).hex();
        if (v2 !== corner(a.key)) { state[a.key] = v2; dropPublished(); render(); }
      } else a.text.classList.add('invalid');
    });
    a.text.addEventListener('blur', () => { a.text.value = corner(a.key); a.text.classList.remove('invalid'); });
  });
  el.curveBtns.forEach((b) => b.addEventListener('click', () => { state.curve = b.dataset.curve; render(); }));
  el.mode.addEventListener('change', () => { state.mode = el.mode.value; render(); });
  function dropPublished() { state.published = null; state.preset = null; state.swapped = false; }
  el.xyAuto.addEventListener('click', () => { state.xy = null; render(); });
  // Swapping the axes mirrors a published grid across its diagonal: cell (x, y) becomes (y, x).
  el.swap.addEventListener('click', () => {
    [state.x, state.y] = [state.y, state.x];
    if (state.published) { state.published = transpose(state.published); state.swapped = !state.swapped; }
    render();
  });
  el.name.addEventListener('input', () => { nameEdited = el.name.value.trim() !== ''; renderExports(); });
  el.pro.addEventListener('click', downloadStylx);
  el.share.addEventListener('click', shareGrid);
  // Leaving for another palette tab retires a bivariate link, as editing there would.
  ['tab-sequential', 'tab-diverging'].forEach((id) => $(id).addEventListener('click', () => {
    if (isBivariateLink(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }));

  // ---------- Legend Lab ----------

  const legendRadio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const legendInputs = ['x', 'y', 'tl', 'tr', 'bl', 'br'].reduce((o, k) => ({ ...o, [k]: $('biv-legend-' + k) }), {});
  const univariateOptions = () => [
    ...document.querySelectorAll('#legend-panel .legend-options:not(#biv-legend-options) > :not(.legend-title-field)'),
    $('legend-scale-hint'),
  ];

  /** Shows the bivariate legend when the last palette came from this tab; false otherwise. */
  function renderLegend(lastTab) {
    const on = lastTab === 'bivariate' && !!grid;
    univariateOptions().forEach((node) => { node.hidden = on; });
    el.legendOptions.hidden = !on;
    const svg = P.legendEl.svg;
    if (!on) {
      svg.style.width = svg.style.maxWidth = ''; // back to the univariate legend's own sizing
      return false;
    }
    const corners = legendRadio('biv-legend-labels') === 'corners';
    document.querySelectorAll('.biv-axes-only').forEach((node) => { node.hidden = corners; });
    document.querySelectorAll('.biv-corners-only').forEach((node) => { node.hidden = !corners; });
    drawLegend();
    const L = P.legendEl;
    L.warning.hidden = true;
    L.png.disabled = L.svgDownload.disabled = false;
    return true;
  }

  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** Draws the bivariate legend into the Legend Lab's SVG, sized to fit its labels. */
  function drawLegend() {
    const L = P.LEGEND;
    const o = P.legendSettings();
    const ink = L.ink[o.ink];
    const diamond = legendRadio('biv-legend-shape') === 'diamond';
    const corners = legendRadio('biv-legend-labels') === 'corners';
    const { n } = grid;
    const fs = L.labelSize;
    const w = (t) => P.textWidth(t, fs);
    const parts = [];
    // Bounding box of everything drawn, so the SVG can be cropped to fit.
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (x0, y0, x1, y1) => {
      box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0);
      box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1);
    };
    /** Text at (x, y) with an anchor, optionally rotated about that point. */
    const text = (t, x, y, anchor = 'start', angle = 0) => {
      if (!t) return;
      const tw = w(t);
      const dx = anchor === 'middle' ? -tw / 2 : anchor === 'end' ? -tw : 0;
      const rad = (angle * Math.PI) / 180;
      const pts = [[dx, -fs * 0.8], [dx + tw, -fs * 0.8], [dx, fs * 0.25], [dx + tw, fs * 0.25]]
        .map(([px, py]) => [x + px * Math.cos(rad) - py * Math.sin(rad), y + px * Math.sin(rad) + py * Math.cos(rad)]);
      grow(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
      parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"${angle ? ` transform="rotate(${angle} ${x.toFixed(1)} ${y.toFixed(1)})"` : ''}>${esc(t)}</text>`);
    };
    const labels = {
      x: legendInputs.x.value.trim(), y: legendInputs.y.value.trim(),
      tl: legendInputs.tl.value.trim(), tr: legendInputs.tr.value.trim(), bl: legendInputs.bl.value.trim(), br: legendInputs.br.value.trim(),
    };
    const gap = 7;

    if (!diamond) {
      const G = 120, c = G / n;
      topRows(grid).forEach((row, r) => row.forEach((cell, k) => {
        parts.push(`<rect x="${(k * c).toFixed(2)}" y="${(r * c).toFixed(2)}" width="${(c + 0.4).toFixed(2)}" height="${(c + 0.4).toFixed(2)}" fill="${cell.hex}"/>`);
      }));
      grow(0, 0, G, G);
      if (corners) {
        text(labels.tl, 0, -gap, 'start');
        text(labels.tr, G, -gap, 'end');
        text(labels.bl, 0, G + gap + fs * 0.8, 'start');
        text(labels.br, G, G + gap + fs * 0.8, 'end');
      } else {
        text(labels.x && labels.x + ' →', G / 2, G + gap + fs * 0.8, 'middle');
        text(labels.y && labels.y + ' →', -gap, G / 2, 'middle', -90);
      }
    } else {
      // Low/low at the bottom point, high X to the right, high Y to the left, both high on top.
      const G = 100, c = G / n, r2 = Math.SQRT1_2;
      const pt = (u, v) => [(u - v) * r2, -(u + v) * r2]; // grid units -> screen, bottom point at 0, 0
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const q = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([u, v]) => pt(u * c, v * c));
          const grown = q.map(([px, py], i) => { // a hair of overlap hides seams between cells
            const [cx, cy] = pt((x + 0.5) * c, (y + 0.5) * c);
            return [px + (px - cx) * 0.012, py + (py - cy) * 0.012];
          });
          parts.push(`<polygon points="${grown.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ')}" fill="${grid.cells[y][x].hex}"/>`);
        }
      }
      const H = G * Math.SQRT2;
      grow(-H / 2, -H, H / 2, 0);
      if (corners) {
        text(labels.bl, 0, gap + fs * 0.8, 'middle');
        text(labels.tr, 0, -H - gap, 'middle');
        text(labels.br, H / 2 + gap, -H / 2 + fs * 0.3, 'start');
        text(labels.tl, -H / 2 - gap, -H / 2 + fs * 0.3, 'end');
      } else {
        // Along the two lower edges, set just outside them. Rotated text rises from its baseline
        // toward the grid, so the baseline sits a line's height out.
        const off = gap + fs * 0.85;
        text(labels.x && labels.x + ' →', H / 4 + off * r2, -H / 4 + off * r2, 'middle', -45);
        text(labels.y && '← ' + labels.y, -H / 4 - off * r2, -H / 4 + off * r2, 'middle', 45);
      }
    }

    // Title and subtitle above, flush with the left of the drawing.
    const titleLine = o.title ? L.titleSize * 1.2 : 0;
    const subtitleLine = o.subtitle ? L.subtitleSize * 1.35 : 0;
    const head = titleLine || subtitleLine ? Math.ceil(titleLine + subtitleLine) + L.titleGap : 0;
    const pad = 2;
    const left = box.x0 - pad;
    const titleW = Math.max(o.title ? P.textWidth(o.title, L.titleSize, 'bold') : 0, o.subtitle ? P.textWidth(o.subtitle, L.subtitleSize) : 0);
    const top = box.y0 - pad - head;
    const width = Math.ceil(Math.max(box.x1 + pad, left + titleW + pad) - left);
    const height = Math.ceil(box.y1 + pad - top);
    const svg = P.legendEl.svg;
    svg.setAttribute('viewBox', `${left.toFixed(1)} ${top.toFixed(1)} ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    // Shown at its own size, so its text matches the univariate legends (which fill 600 px).
    svg.style.width = `${width}px`;
    svg.style.maxWidth = '100%';
    svg.innerHTML =
      (o.title ? `<text x="${left + pad}" y="${top + L.titleSize}" font-family="${L.font}" font-size="${L.titleSize}" font-weight="bold" fill="${ink}">${esc(o.title)}</text>` : '') +
      (o.subtitle ? `<text x="${left + pad}" y="${(top + titleLine + L.subtitleSize).toFixed(1)}" font-family="${L.font}" font-size="${L.subtitleSize}" fill="${ink}">${esc(o.subtitle)}</text>` : '') +
      `<g shape-rendering="${diamond ? 'auto' : 'crispEdges'}">${parts.filter((p) => !p.startsWith('<text')).join('')}</g>` +
      `<g font-family="${L.font}" font-size="${fs}" fill="${ink}">${parts.filter((p) => p.startsWith('<text')).join('')}</g>`;
  }

  document.querySelectorAll('input[name="biv-legend-shape"], input[name="biv-legend-labels"]')
    .forEach((r) => r.addEventListener('change', () => P.renderLegend()));
  Object.values(legendInputs).forEach((input) => input.addEventListener('input', () => P.renderLegend()));

  // ---------- setup ----------

  buildPresets();
  const fromLink = readLink();
  render();
  if (fromLink) $('tab-bivariate').click(); // a shared bivariate link opens on this tab

  window.PhosphorBivariate = {
    show: render,
    renderLegend,
    name: schemeName,
  };
})();
