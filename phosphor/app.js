/* Phosphor — builds multi-hue gradients whose OKLab lightness changes linearly. */
(function () {
  'use strict';

  // Frostfire is both a diverging preset and the diverging tab's starting palette.
  const FROSTFIRE = { name: 'Frostfire', mid: 6, colors: ['#eff6ff', '#cfdff2', '#b0c7ea', '#90b0e0', '#8695cf', '#8178ba', '#7b5ca6', '#895899', '#a96b92', '#c8808a', '#e29786', '#f2b290', '#facfa6', '#fff5da'] };

  // Each tab keeps its own settings; `state` always points at the active tab's.
  const DEFAULTS = {
    sequential: { type: 'sequential', colors: ['#1b2a49', '#c23b5c', '#f7d154'], mid: 1, mode: 'oklab', steps: 9, curve: 'linear' },
    diverging: { type: 'diverging', colors: FROSTFIRE.colors, mid: FROSTFIRE.mid, mode: 'oklab', steps: 11, curve: 'linear' },
  };
  const freshState = (type) => ({ ...DEFAULTS[type], colors: DEFAULTS[type].colors.slice(), lightness: null });

  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('color-list'), add: $('add-color'), reverse: $('reverse'), sortL: $('sort-l'),
    paste: $('paste'), applyPaste: $('apply-paste'),
    mode: $('mode'), steps: $('steps'), stepsOut: $('steps-out'),
    warning: $('warning'), bar: $('bar'), barLabel: $('bar-label'), cvdBadge: $('cvd-badge'),
    presetsToggle: $('presets-toggle'), presetsPanel: $('presets-panel'), legendResult: $('legend-result'), legendRaw: $('legend-raw'),
    swatches: $('swatches'), chart: $('chart'), stats: $('stats'),
    curveGroup: $('curve-group'), curveBtns: [...document.querySelectorAll('.curve-btn')], chartHint: $('chart-hint'), clipNote: $('clip-note'),
    divHint: $('div-hint'), divNote: $('div-note'), tabPanel: $('tab-panel'),
    outHex: $('out-hex'), outCss: $('out-css'), outPy: $('out-py'),
    proPreview: $('pro-preview'), rampName: $('ramp-name'), proDownload: $('pro-download'),
    outQgis: $('out-qgis'), qgisDownload: $('qgis-download'),
    outGdal: $('out-gdal'), gdalDownload: $('gdal-download'),
    gdalMin: $('gdal-min'), gdalMax: $('gdal-max'), gdalNodata: $('gdal-nodata'),
    share: $('share'), shareBtnLabel: $('share-label'), shareStatus: $('share-status'),
  };

  // ArcGIS Pro export: this many colors, joined by CIELAB segments.
  const PRO_RAMP_COLORS = 17; // odd, so a diverging midpoint lands exactly on a stop
  const SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/';

  const tabStates = { sequential: freshState('sequential'), diverging: freshState('diverging') };
  const fromLink = readHash();
  if (fromLink) tabStates[fromLink.type] = fromLink;
  let state = tabStates[fromLink ? fromLink.type : 'sequential'];
  const isDiverging = () => state.type === 'diverging';
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
    let okSamples = null;
    return {
      raw: (t) => raw(t),
      result: (t) => result(t),
      target: (t) => L0 + t * (L1 - L0),
      corrected,
      // The corrected gradient in OKLab at 257 points, built once on first use, so hand-adjusted
      // lightness can be applied while dragging without re-running the correction's search.
      oklabSamples: () => (okSamples = okSamples || positions(257).map((t) => result(t).oklab())),
    };
  }

  /**
   * Diverging gradients are two sequential gradients joined at the midpoint color: start → mid
   * over the first half, mid → end over the second. Each side is corrected to linear OKLab L,
   * running from the start's lightness to the midpoint's and back to the start's, so the two sides
   * mirror each other. If the end color's own lightness differs from the start's, it keeps its hue
   * and chroma and takes the start's lightness (`endShift` reports by how much).
   */
  function buildDivergingSamplers(colors, mid, mode) {
    const left = colors.slice(0, mid + 1);
    const right = colors.slice(mid);
    const L0 = lightness(colors[0]);
    const Lm = lightness(colors[mid]);
    const Lend = lightness(colors[colors.length - 1]);
    const corrected = isMonotonic(left.map(lightness)) && isMonotonic(right.map(lightness));
    const rawL = makeScale(left, mode);
    const rawR = makeScale(right, mode);
    const raw = (t) => (t <= 0.5 ? rawL(t * 2) : rawR(t * 2 - 1));
    const target = (t) => (t <= 0.5 ? L0 + (Lm - L0) * t * 2 : Lm + (L0 - Lm) * (t * 2 - 1));

    let result = raw;
    if (corrected) {
      const corrL = correctOklabLightness(rawL);
      const corrR = correctOklabLightness(rawR);
      const matchEnd = Math.abs(Lend - L0) >= 0.05;
      result = (t) => {
        if (t <= 0.5) return corrL(t * 2);
        const c = corrR(t * 2 - 1);
        if (!matchEnd) return c;
        const [, a, b] = c.oklab();
        return chroma.oklab(target(t) / 100, a, b);
      };
    }
    let okSamples = null;
    return {
      raw, result, target, corrected, diverging: true,
      endShift: corrected ? L0 - Lend : 0,
      oklabSamples: () => (okSamples = okSamples || positions(257).map((t) => result(t).oklab())),
    };
  }

  // How far the curve buttons bend lightness away from linear, as a share of each run's lightness
  // range. At 1, the most that keeps lightness moving one way, each curve is a full parabola with
  // zero slope at one end; in a diverging gradient the curve that suits the palette's shape then
  // meets the midpoint smoothly: one parabola, no kink.
  const CURVE_STRENGTH = 1;
  const CURVE_LABELS = {
    sequential: { linear: 'linear', up: 'concave up', down: 'concave down' },
    diverging: { linear: 'linear', up: 'parabolic up', down: 'parabolic down' },
  };
  const curveLabel = () => CURVE_LABELS[state.type][state.curve];

  /**
   * Lightness at t for the chosen curve: the linear target plus a parabola, so the bend is smooth
   * and even (a constant second derivative). "Up" opens upward on the chart and "down" downward,
   * whichever way the lightness runs. Diverging gradients bend each half on its own.
   */
  function curveTarget(s, curve) {
    if (curve !== 'up' && curve !== 'down') return s.target;
    const k = (curve === 'up' ? 1 : -1) * CURVE_STRENGTH;
    const bend = (t, from, to, u) => s.target(t) + k * Math.abs(s.target(to) - s.target(from)) * u * (u - 1);
    return s.diverging
      ? (t) => (t <= 0.5 ? bend(t, 0, 0.5, t * 2) : bend(t, 0.5, 1, t * 2 - 1))
      : (t) => bend(t, 0, 1, t);
  }

  /** The lightness the gradient follows before any hand adjustment: linear or a curve. */
  const shapeTarget = (s) => curveTarget(s, state.curve);

  /**
   * The gradient as shown and exported. Without hand adjustments or a curve it is the corrected
   * gradient. Otherwise each color keeps the corrected gradient's hue and chroma (OKLab a and b)
   * and takes its lightness from the curve, or from a line through the hand-adjusted step values.
   */
  function adjustedSampler(s) {
    const pts = state.lightness;
    const profile = pts ? (t) => profileAt(pts, t) : state.curve !== 'linear' ? shapeTarget(s) : null;
    if (!s.corrected || !profile) return s.result;
    const samples = s.oklabSamples();
    const lerp = (arr, t) => {
      const x = t * (arr.length - 1);
      const i = Math.min(arr.length - 2, Math.floor(x));
      const f = x - i;
      return [arr[i], arr[i + 1], f];
    };
    return (t) => {
      const [c0, c1, g] = lerp(samples, t);
      return inGamutOklab(profile(t) / 100, c0[1] + (c1[1] - c0[1]) * g, c0[2] + (c1[2] - c0[2]) * g);
    };
  }

  /**
   * An OKLab color, brought inside sRGB by lowering its chroma (a and b scaled toward gray) rather
   * than by clipping RGB, so its lightness and hue stay exactly as asked. Clipping would pull
   * lightness off a curve or hand-set value wherever a bend pushes a color out of gamut. Colors
   * that needed it are marked `reduced`.
   */
  function inGamutOklab(L, a, b) {
    const c = chroma.oklab(L, a, b);
    if (!c.clipped()) return c;
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const k = (lo + hi) / 2;
      if (chroma.oklab(L, a * k, b * k).clipped()) hi = k; else lo = k;
    }
    const out = chroma.oklab(L, a * lo, b * lo);
    out.reduced = true;
    return out;
  }

  /**
   * Hand-adjusted lightness belongs to one set of colors, midpoint and interpolation space.
   * A function declaration, because readHash() needs it before the rest of the setup runs.
   */
  function gradientKey(st = state) {
    return [st.type, st.type === 'diverging' ? st.mid : '', st.mode, st.colors.join(',').toLowerCase()].join('|');
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

  // Rendering happens in three layers:
  //   render()        rebuilds the samplers when the colors, interpolation space or theme change;
  //   renderOutputs() redraws everything built from the gradient (used while dragging chart dots);
  //   renderSteps()   redraws only what depends on the step count (used by the Steps slider).
  let gradient = null;

  function render() {
    const colors = state.colors.filter((c) => chroma.valid(c)).map((c) => chroma(c).hex());
    renderLValues();
    if (state.lightness && state.lightnessKey !== gradientKey()) state.lightness = null;
    gradient = null;
    el.cvdBadge.hidden = true;
    el.proDownload.disabled = true;
    el.qgisDownload.disabled = true;
    el.gdalDownload.disabled = true;

    el.divHint.hidden = !isDiverging();
    el.divNote.hidden = true;
    const needed = isDiverging() ? 3 : 2;
    // Sequential gradients skip invalid entries (e.g. while a hex is being typed); diverging ones
    // can't, because the midpoint is a position in the list.
    const invalid = isDiverging() && colors.length !== state.colors.length;
    if (colors.length < needed || invalid) {
      clearStaleShareLink();
      showWarning(invalid
        ? 'Finish or remove the invalid hex color to see the diverging gradient.'
        : isDiverging()
        ? 'Diverging gradients need at least three colors: a start, a midpoint and an end.'
        : 'Add at least two valid hex colors.');
      return;
    }

    let s;
    try {
      s = isDiverging() ? buildDivergingSamplers(colors, state.mid, state.mode) : buildSamplers(colors, state.mode);
    } catch (err) {
      clearStaleShareLink();
      showWarning('Could not build this gradient: ' + err.message);
      return;
    }
    gradient = { s, bezierWarning: state.mode === 'bezier' && colors.length > 5 };
    if (s.diverging && Math.abs(s.endShift) >= 0.5) {
      el.divNote.hidden = false;
      el.divNote.textContent = `The end color's lightness moves from L ${(lightness(colors[colors.length - 1])).toFixed(1)} to L ${lightness(colors[0]).toFixed(1)} to match the start, so both sides mirror each other.`;
    }
    renderOutputs();
  }

  function renderOutputs() {
    if (!gradient) return;
    const { s } = gradient;
    const result = adjustedSampler(s);
    const adjusted = result !== s.result;
    Object.assign(gradient, { result, adjusted });

    // Bar
    el.bar.style.background = cssGradient(positions(65).map((t) => result(t).hex()));
    el.barLabel.textContent = !s.corrected
      ? (s.diverging
        ? 'Uncorrected - One side of your colors goes up and down in lightness. Try Sort by lightness.'
        : 'Uncorrected - Your colors go up and down in lightness. Try Sort by lightness.')
      : state.lightness && adjusted ? 'Corrected, adjusted by hand'
      : adjusted ? `Corrected, ${curveLabel()}` : 'Corrected';
    el.barLabel.classList.toggle('bar-label-warn', !s.corrected);
    renderCvdBadge(isColorblindSafe(result, !!s.diverging));
    renderCurveButtons(s);
    el.chartHint.hidden = !s.corrected;

    // ArcGIS Pro blends each segment in CIELAB, which is exactly a Lab scale through these stops.
    proHexes = positions(PRO_RAMP_COLORS).map((t) => result(t).hex());
    el.proPreview.style.background = cssGradient(chroma.scale(proHexes).mode('lab').colors(64));
    const preset = activePreset();
    markActivePreset(preset);
    if (!rampNameEdited) {
      el.rampName.value = preset ? `Phosphor ${preset.name}` : `Phosphor ${proHexes[0]}–${proHexes[proHexes.length - 1]}`;
    }

    gradient.chartBase = chartBase(s, result, adjusted);
    gradient.dense32 = positions(RGB_STOPS).map((t) => result(t).hex());
    setExport(el.outCss, 'css', cssSnippet(positions(CSS_STOPS).map((t) => result(t).hex())));
    el.proDownload.disabled = false;
    el.qgisDownload.disabled = false;
    renderSteps();
  }

  function renderSteps() {
    el.stepsOut.textContent = state.steps;
    clearStaleShareLink();
    if (!gradient) return;

    const stepColors = positions(state.steps).map((t) => gradient.result(t));
    // Only the Bezier note uses the banner above the gradient; it can't change mid-drag. The
    // clipping note can, so it sits below the chart where it never shifts the dots being dragged.
    if (gradient.bezierWarning) showWarning('Bezier interpolation works best with 2–5 colors.'); else hideWarning();
    const clippedCount = stepColors.filter((c) => c.clipped && c.clipped()).length;
    const reducedCount = stepColors.filter((c) => c.reduced).length;
    const plural = (n, one, many) => `${n} step${n > 1 ? 's' : ''} ${n > 1 ? many : one}`;
    el.clipNote.hidden = !clippedCount && !reducedCount;
    el.clipNote.textContent = [
      clippedCount ? `${plural(clippedCount, 'fell', 'fell')} outside sRGB and ${clippedCount > 1 ? 'were' : 'was'} clipped, which moves lightness slightly.` : '',
      reducedCount ? `${plural(reducedCount, 'was', 'were')} outside sRGB at ${reducedCount > 1 ? 'their' : 'its'} new lightness, so ${reducedCount > 1 ? 'their' : 'its'} chroma was lowered to fit. Lightness and hue are unchanged.` : '',
    ].filter(Boolean).join(' ');

    // Swatches
    const hexes = stepColors.map((c) => c.hex());
    el.swatches.innerHTML = '';
    stepColors.forEach((c, i) => {
      const hex = hexes[i];
      const L = lightness(hex);
      const gamut = c.clipped && c.clipped() ? ', clipped' : c.reduced ? ', muted to fit sRGB' : '';
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'swatch';
      d.style.background = hex;
      d.title = `${hex} · L ${L.toFixed(1)}${gamut}. Click to copy.`;
      d.setAttribute('aria-label', `Step ${i + 1}: ${hex}, lightness ${L.toFixed(1)}${gamut}. Copy`);
      d.addEventListener('click', () => copy(hex));
      el.swatches.appendChild(d);
    });

    el.chart.innerHTML = gradient.chartBase + chartDots(hexes, gradient.s.corrected);
    setExport(el.outHex, 'list', hexes.map((h) => `"${h}"`).join(', '));
    renderNamedExports(hexes);
  }

  /** Exports that include the ramp name: redrawn when the name or the steps change. */
  function renderNamedExports(hexes = gradient && gradient.stepHexes) {
    if (!gradient) return;
    gradient.stepHexes = hexes;
    setExport(el.outPy, 'python', pythonSnippet(gradient, hexes, gradient.dense32));
    setExport(el.outQgis, 'xml', qgisXml(rampName(), gradient.dense32));
    renderGdal();
  }

  /** The GDAL color file: depends on the steps and on the min, max and no-data inputs. */
  function renderGdal() {
    if (!gradient || !gradient.stepHexes) return;
    const min = parseNumber(el.gdalMin.value);
    const max = parseNumber(el.gdalMax.value);
    const valid = min !== null && max !== null && min !== max;
    el.gdalMin.setAttribute('aria-invalid', String(min === null));
    el.gdalMax.setAttribute('aria-invalid', String(max === null));
    el.gdalDownload.disabled = !valid;
    setExport(el.outGdal, 'gdal', valid
      ? gdalColorFile(gradient.stepHexes, min, max, el.gdalNodata.checked)
      : '# Enter a numeric min and max that differ.');
  }

  // Coalesce slider and drag input to at most one redraw per animation frame. A pending full
  // redraw (renderOutputs) also covers the steps.
  let frame = 0;
  let frameNeedsOutputs = false;
  function schedule(outputs) {
    frameNeedsOutputs = frameNeedsOutputs || outputs;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const full = frameNeedsOutputs;
      frameNeedsOutputs = false;
      if (full) renderOutputs(); else renderSteps();
    });
  }
  const scheduleSteps = () => schedule(false);
  const scheduleOutputs = () => schedule(true);

  // ---------- hand-adjusted lightness (draggable chart dots) ----------

  /** Lightness at t from a line through the step values `pts` (0–100). */
  function profileAt(pts, t) {
    const x = t * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(x));
    return pts[i] + (pts[i + 1] - pts[i]) * (x - i);
  }

  function setStepLightness(i, L) {
    if (!gradient || !gradient.s.corrected) return;
    if (!state.lightness) {
      state.lightness = positions(state.steps).map(shapeTarget(gradient.s));
      state.lightnessKey = gradientKey();
    }
    state.lightness[i] = Math.max(0, Math.min(100, L));
    scheduleOutputs();
  }

  /** Applies a whole-curve shape ('linear', 'up' or 'down'), replacing any hand adjustments. */
  function setCurve(curve) {
    state.curve = curve;
    state.lightness = null;
    renderOutputs();
  }

  /**
   * Shows the curve buttons for this tab, marks the active one (none while hand-adjusted) and
   * mirrors the sequential icons when lightness falls, so each icon matches the chart.
   */
  function renderCurveButtons(s) {
    el.curveGroup.classList.toggle('falling', s.target(1) < s.target(0));
    el.curveGroup.classList.toggle('valley', !!s.diverging && s.target(0.5) < s.target(0));
    el.curveBtns.forEach((b) => {
      b.hidden = b.dataset.for && b.dataset.for !== state.type;
      b.disabled = !s.corrected;
      b.setAttribute('aria-pressed', String(!state.lightness && state.curve === b.dataset.curve));
    });
    el.curveGroup.querySelectorAll('[data-icon-for]').forEach((svg) => { svg.hidden = svg.dataset.iconFor !== state.type; });
  }

  const stepLightness = (i) => (state.lightness ? state.lightness[i] : shapeTarget(gradient.s)(positions(state.steps)[i]));

  // Drags are relative: the new value is the starting value plus how far the pointer has moved.
  // That keeps the dot from jumping to the pointer on press, and means any layout change during
  // the drag can't feed back into the value being set.
  let drag = null;
  el.chart.addEventListener('pointerdown', (e) => {
    const dot = e.target.closest('.dot');
    if (!dot) return;
    e.preventDefault();
    const i = +dot.dataset.i;
    const plotPx = el.chart.getScreenCTM().d * (CHART.H - CHART.pad.t - CHART.pad.b);
    drag = { i, startY: e.clientY, startL: stepLightness(i), pxPerL: plotPx / 100 };
    el.chart.setPointerCapture(e.pointerId);
    el.chart.classList.add('dragging');
  });
  el.chart.addEventListener('pointermove', (e) => {
    if (drag) setStepLightness(drag.i, drag.startL + (drag.startY - e.clientY) / drag.pxPerL);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    el.chart.classList.remove('dragging');
    if (el.chart.hasPointerCapture(e.pointerId)) el.chart.releasePointerCapture(e.pointerId);
  };
  el.chart.addEventListener('pointerup', endDrag);
  el.chart.addEventListener('pointercancel', endDrag);

  // Keyboard: focus a dot, then Up/Down moves it by 1 (Shift: 5).
  el.chart.addEventListener('keydown', (e) => {
    const dot = e.target.closest('.dot');
    if (!dot || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const i = +dot.dataset.i;
    const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1);
    setStepLightness(i, stepLightness(i) + step);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const again = el.chart.querySelector(`.dot[data-i="${i}"]`);
      if (again) again.focus();
    }));
  });

  function cssGradient(hexes) {
    return `linear-gradient(to right, ${hexes.join(', ')})`;
  }

  // ---------- code exports ----------

  const CSS_STOPS = 17; // browsers blend CSS gradients in sRGB, so sample densely
  const RGB_STOPS = 33; // matplotlib and QGIS blend linearly in RGB between these samples (odd: see PRO_RAMP_COLORS)
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

  function pythonSnippet(g, hexes, dense) {
    const name = rampName().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'phosphor';
    const space = el.mode.options[el.mode.selectedIndex].text;
    const kind = g.s.diverging ? 'diverging, ' : '';
    const how = g.adjusted && state.lightness
      ? `${kind}${space} interpolation, lightness-corrected, then OKLab L adjusted by hand.`
      : g.adjusted
      ? `${kind}${space} interpolation, lightness-corrected to a ${curveLabel()} OKLab L curve.`
      : g.s.corrected && g.s.diverging
      ? `diverging, ${space} interpolation, lightness-corrected (OKLab L linear to the midpoint and back).`
      : g.s.corrected
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

  const parseNumber = (text) => {
    const t = text.trim();
    return t !== '' && Number.isFinite(+t) ? +t : null;
  };

  // Enough digits to tell neighbors apart, without float noise like 0.30000000000000004.
  const gdalValue = (v) => String(+v.toPrecision(12));
  const gdalColor = (hex) => chroma(hex).rgb().join(', ') + ', 255';

  /**
   * A color file for `gdaldem color-relief`: one `value, R, G, B, A` row per step, with values
   * spaced evenly from min to max. The optional `nv` row colors no-data pixels (the min color).
   */
  function gdalColorFile(hexes, min, max, nodata) {
    const rows = hexes.map((h, i) => `${gdalValue(min + (max - min) * i / (hexes.length - 1))}, ${gdalColor(h)}`);
    if (nodata) rows.push(`nv, ${gdalColor(hexes[0])}`);
    return rows.join('\n');
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
    gdal: [
      ['com', /#.*/y],
      ['rgba', /\d{1,3}, \d{1,3}, \d{1,3}, \d{1,3}(?=\n|$)/y],
      ['kw', /\bnv\b/y],
      ['num', /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy],
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
      const rgb = /^"(\d{1,3},\d{1,3},\d{1,3}),255"$|^(\d{1,3}, \d{1,3}, \d{1,3}), \d{1,3}$/.exec(text);
      const swatch = cls === 'com' ? null : hex ? hex[1] : rgb ? `rgb(${rgb[1] || rgb[2]})` : null;
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

  function chartDots(hexes, draggable) {
    const stroke = themeColor('--chart-corrected');
    // 10 px dots, shrunk only when many steps would make neighbors overlap.
    const spacing = (CHART.W - CHART.pad.l - CHART.pad.r) / Math.max(1, hexes.length - 1);
    const r = Math.min(10, Math.max(5, spacing / 2 - 1));
    return positions(hexes.length).map((t, i) => {
      const L = lightness(hexes[i]);
      const attrs = draggable
        ? ` class="dot" data-i="${i}" tabindex="0" role="slider" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${L.toFixed(1)}" aria-label="Step ${i + 1} lightness"`
        : '';
      return `<circle${attrs} cx="${chartX(t)}" cy="${chartY(L)}" r="${r}" fill="${hexes[i]}" stroke="${stroke}" stroke-width="1.5"/>`;
    }).join('');
  }

  /** Grid, curves, legend and stats: everything on the chart except the step dots. */
  function chartBase(s, result, adjusted) {
    const { W, H, pad } = CHART;
    const x = chartX, y = chartY, col = themeColor;

    const line = (fn, n = 121) =>
      positions(n).map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(fn(t)).toFixed(1)}`).join('');

    let out = '';
    for (let L = 0; L <= 100; L += 25) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(L)}" y2="${y(L)}" stroke="${col('--chart-grid')}"/>`;
      out += `<text x="${pad.l - 6}" y="${y(L) + 4}" text-anchor="end">${L}</text>`;
    }
    out += `<text x="${pad.l}" y="${H - 8}">start</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end">end</text>`;

    // Actual OKLab L is measured from each color after any gamut clipping, but before rounding to
    // an 8-bit hex: rounding adds up to ±0.2 L of noise that would make the lines look jagged.
    out += `<path d="${line(s.target, 3)}" fill="none" stroke="${col('--chart-target')}" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    if (s.corrected) {
      out += `<path d="${line((t) => lightness(s.raw(t)))}" fill="none" stroke="${col('--chart-raw')}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    }
    out += `<path d="${line((t) => lightness(result(t)))}" fill="none" stroke="${col('--chart-corrected')}" stroke-width="2"/>`;

    const maxDev = (fn) => Math.max(...positions(201).map((t) => Math.abs(lightness(fn(t).hex()) - s.target(t))));
    const byHand = adjusted && !!state.lightness;
    el.legendResult.textContent = !s.corrected ? 'Uncorrected' : byHand ? 'Adjusted' : adjusted ? 'Curved' : 'Corrected';
    el.legendRaw.hidden = !s.corrected;
    el.stats.textContent = adjusted && !byHand
      ? `Lightness follows a ${curveLabel()} curve: up to ${maxDev(result).toFixed(2)} from the linear target (OKLab L, 0–100).`
      : adjusted
      ? `Lightness adjusted by hand: up to ${maxDev(result).toFixed(2)} from the linear target (OKLab L, 0–100).`
      : s.corrected
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

  /** Keeps a diverging midpoint strictly between the first and last colors. */
  function clampMid() {
    state.mid = Math.max(1, Math.min(state.colors.length - 2, state.mid));
  }

  function buildList() {
    const div = isDiverging();
    if (div) clampMid();
    el.list.innerHTML = '';
    el.list.classList.toggle('diverging', div);
    const minColors = div ? 3 : 2;
    const last = state.colors.length - 1;
    // A move is blocked if it would push the midpoint into the first or last slot.
    const canMove = (from, to) => to >= 0 && to <= last && !(div && (
      (from === state.mid && (to === 0 || to === last)) || (to === state.mid && (from === 0 || from === last))));
    state.colors.forEach((c, i) => {
      const li = document.createElement('li');
      const isMid = div && i === state.mid;
      li.className = 'color-item' + (isMid ? ' is-mid' : '');
      const valid = chroma.valid(c);
      const canBeMid = i > 0 && i < state.colors.length - 1;
      const midBtn = div
        ? `<button type="button" class="mid-btn" data-act="mid" aria-pressed="${isMid}" aria-label="Use as midpoint" title="${canBeMid ? 'Use as midpoint' : 'The first and last colors can’t be the midpoint'}" ${canBeMid ? '' : 'disabled'}>◆</button>`
        : '';
      li.innerHTML = `
        <input type="color" aria-label="Pick color ${i + 1}" value="${valid ? chroma(c).hex('rgb') : '#000000'}">
        <input type="text" aria-label="Hex color ${i + 1}${isMid ? ' (midpoint)' : ''}" value="${c}" spellcheck="false" autocomplete="off" class="${valid ? '' : 'invalid'}">
        <span class="lval"></span>
        ${midBtn}
        <button type="button" data-act="up" aria-label="Move up" ${canMove(i, i - 1) ? '' : 'disabled'}>↑</button>
        <button type="button" data-act="down" aria-label="Move down" ${canMove(i, i + 1) ? '' : 'disabled'}>↓</button>
        <button type="button" data-act="del" aria-label="Remove" ${state.colors.length <= minColors ? 'disabled' : ''}>×</button>`;
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
        const btn = e.target.closest('button');
        const act = btn && btn.dataset.act;
        if (!act) return;
        if (act === 'mid') state.mid = i;
        if (act === 'del') {
          state.colors.splice(i, 1);
          if (i < state.mid) state.mid -= 1;
        }
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

  /** Swaps two colors; a diverging midpoint travels with its color. */
  function swap(a, b) {
    [state.colors[a], state.colors[b]] = [state.colors[b], state.colors[a]];
    if (state.mid === a) state.mid = b;
    else if (state.mid === b) state.mid = a;
  }

  const byLightness = (a, b) => (chroma.valid(a) ? lightness(a) : 0) - (chroma.valid(b) ? lightness(b) : 0);

  /**
   * Sequential: dark to light. Diverging: the midpoint stays put and each side is ordered so its
   * lightness moves steadily toward the midpoint (lighter or darker, whichever the midpoint is).
   */
  function sortByLightness() {
    if (!isDiverging()) {
      state.colors.sort(byLightness);
      return;
    }
    const mid = state.colors[state.mid];
    const left = state.colors.slice(0, state.mid);
    const right = state.colors.slice(state.mid + 1);
    const others = left.concat(right).filter((c) => chroma.valid(c));
    const midIsLight = chroma.valid(mid) && others.length
      && lightness(mid) >= others.reduce((sum, c) => sum + lightness(c), 0) / others.length;
    left.sort(midIsLight ? byLightness : (a, b) => byLightness(b, a));
    right.sort(midIsLight ? (a, b) => byLightness(b, a) : byLightness);
    state.colors = left.concat([mid], right);
  }

  // ---------- preset palettes ----------

  // ColorBrewer sequential schemes (9 classes) ship with chroma.js as chroma.brewer.
  const brewer = (names) => names.map((name) => ({ name, colors: chroma.brewer[name] }));
  const PRESET_GROUPS = [
    {
      title: 'Stevens',
      presets: [
        { name: 'Tropics', colors: ['#c3f4e9', '#b6e5eb', '#a9d6ec', '#9ac8ee', '#8bbaef', '#7aacf0', '#8898eb', '#9682e5', '#b85fd5', '#c244b4', '#be338e', '#b71f69', '#ad0045'] },
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
  // Diverging presets: 11-class ColorBrewer diverging schemes (midpoint in the center) and
  // Stevens ramps: Frostfire, whose lightness bottoms out at its seventh color, and Chlorophyll,
  // which peaks at its fourth.
  const DIVERGING_GROUPS = [
    {
      title: 'Stevens',
      presets: [
        { name: 'Chlorophyll', mid: 3, colors: ['#0c2777', '#25468d', '#638bab', '#a2c2ba', '#8ebd89', '#45893e', '#002f0e'] },
        FROSTFIRE,
      ],
    },
    {
      title: 'ColorBrewer: diverging',
      presets: ['BrBG', 'PiYG', 'PRGn', 'PuOr', 'RdBu', 'RdGy', 'RdYlBu', 'RdYlGn', 'Spectral']
        .map((name) => ({ name, colors: chroma.brewer[name], mid: Math.floor(chroma.brewer[name].length / 2) })),
    },
  ];
  const presetGroups = () => (isDiverging() ? DIVERGING_GROUPS : PRESET_GROUPS);
  const currentPresets = () => presetGroups().flatMap((g) => g.presets);

  /** The preset (for the active tab) whose colors and midpoint match the current ones, if any. */
  function activePreset() {
    const key = state.colors.map((c) => c.toLowerCase()).join(',');
    return currentPresets().find((p) => p.colors.join(',') === key && (!isDiverging() || p.mid === state.mid)) || null;
  }

  function markActivePreset(preset) {
    el.presetsPanel.querySelectorAll('.preset-card').forEach((card) =>
      card.setAttribute('aria-pressed', String(!!preset && card.dataset.name === preset.name)));
  }

  // ---------- red-green colorblind check ----------
  // Simulates protanopia and deuteranopia with the Machado et al. (2009) matrices behind the
  // Simulate buttons (read from their SVG filters, so there's one source), applied in linear RGB,
  // on 33 evenly spaced samples. Under both, a gradient must keep at least CVD_MIN_DE apart
  // (OKLab distance × 100):
  //   - any two samples at least a quarter of the ramp apart, and
  //   - for diverging gradients, each pair mirrored about the midpoint down to an eighth of the
  //     ramp apart. Mirrored colors share a lightness, so only hue tells the two sides apart,
  //     and that is where red-green palettes fail: Spectral's inner colors merge under
  //     protanopia and deuteranopia even though its ends stay distinct.
  // With the lightness correction applied, this passes every ColorBrewer sequential scheme and the
  // six diverging ones ColorBrewer rates colorblind-safe (lowest 5.5), and fails RdGy, RdYlGn and
  // Spectral (highest 2.5).
  const CVD_MIN_DE = 4.5;
  const CVD_SAMPLES = 33;
  const CVD_GAP = 8; // samples apart: a quarter of the ramp
  const CVD_MIRROR_GAP = 4; // samples apart: an eighth of the ramp
  let cvdMatrices = null;

  const readCvdMatrix = (id) => {
    const v = document.querySelector(`#${id} feColorMatrix`).getAttribute('values').trim().split(/\s+/).map(Number);
    return [0, 1, 2].map((r) => v.slice(r * 5, r * 5 + 3));
  };
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };

  function simulatedOklab(color, m) {
    const lin = chroma(color).rgb(false).map((c) => toLinear(c / 255));
    return chroma(m.map((r) => fromLinear(r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]) * 255)).oklab();
  }

  /** Whether the gradient `sample(t)` stays readable with protanopia and deuteranopia. */
  function isColorblindSafe(sample, diverging) {
    cvdMatrices = cvdMatrices || ['cvd-protanopia', 'cvd-deuteranopia'].map(readCvdMatrix);
    const ts = positions(CVD_SAMPLES);
    const last = CVD_SAMPLES - 1;
    return cvdMatrices.every((m) => {
      const lab = ts.map((t) => simulatedOklab(sample(t), m));
      const apart = (i, j) => {
        const [a, b] = [lab[i], lab[j]];
        return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= CVD_MIN_DE;
      };
      for (let i = 0; i < lab.length; i++) {
        for (let j = i + CVD_GAP; j < lab.length; j++) if (!apart(i, j)) return false;
      }
      if (diverging) {
        for (let i = 0; last - 2 * i >= CVD_MIRROR_GAP; i++) if (!apart(i, last - i)) return false;
      }
      return true;
    });
  }

  const CVD_TITLE = {
    true: 'Red-green colorblind-safe: colors stay distinguishable with simulated protanopia and deuteranopia.',
    false: 'Not red-green colorblind-safe: with simulated protanopia or deuteranopia, some colors far apart in the ramp look alike.',
  };
  const cvdIcon = (safe) =>
    `<svg class="cvd-icon ${safe ? 'cvd-ok' : 'cvd-bad'}" viewBox="0 0 22 14" aria-hidden="true">` +
    '<path d="M1.5 7C4 2.8 7.3 1 11 1s7 1.8 9.5 6c-2.5 4.2-5.8 6-9.5 6S4 11.2 1.5 7Z"/>' +
    (safe ? '<path d="M7.2 7.4l2.6 2.6 5-5.4"/>' : '<path d="M8.4 4.4l5.2 5.2M13.6 4.4l-5.2 5.2"/>') +
    '</svg>';

  function renderCvdBadge(safe) {
    el.cvdBadge.hidden = false;
    el.cvdBadge.className = 'cvd-badge ' + (safe ? 'is-safe' : 'is-unsafe');
    el.cvdBadge.title = CVD_TITLE[safe];
    el.cvdBadge.innerHTML = cvdIcon(safe) + (safe ? 'colorblind-safe' : 'not colorblind-safe');
  }

  // Presets are judged as they load: corrected, in OKLab. Each is checked once.
  const presetSafety = new Map();
  function presetIsSafe(p) {
    const key = (p.mid !== undefined ? 'd:' : 's:') + p.name;
    if (!presetSafety.has(key)) {
      const s = p.mid !== undefined ? buildDivergingSamplers(p.colors, p.mid, 'oklab') : buildSamplers(p.colors, 'oklab');
      presetSafety.set(key, isColorblindSafe(s.result, !!s.diverging));
    }
    return presetSafety.get(key);
  }

  function buildPresets() {
    el.presetsPanel.innerHTML = presetGroups().map((g) => `
      <h2>${g.title}</h2>
      <div class="preset-grid">
        ${g.presets.map((p) => `
          <button type="button" class="preset-card" data-name="${p.name}" aria-pressed="false">
            <span class="preset-preview" style="background: ${cssGradient(p.colors)}"></span>
            <span class="preset-meta">
              <span class="preset-name">${p.name}</span>
              <span class="cvd-mark" role="img" aria-label="${presetIsSafe(p) ? 'Colorblind-safe' : 'Not colorblind-safe'}" title="${CVD_TITLE[presetIsSafe(p)]}">${cvdIcon(presetIsSafe(p))}</span>
            </span>
          </button>`).join('')}
      </div>`).join('');
  }

  el.presetsPanel.addEventListener('click', (e) => {
    const card = e.target.closest('.preset-card');
    if (!card) return;
    const preset = currentPresets().find((p) => p.name === card.dataset.name);
    state.colors = preset.colors.slice();
    if (preset.mid !== undefined) state.mid = preset.mid;
    // A preset starts fresh: linear lightness, no curve or hand adjustments carried over.
    state.curve = 'linear';
    state.lightness = null;
    rampNameEdited = false;
    buildList();
    render();
  });

  // ---------- URL state ----------

  // The URL only changes when someone clicks Share. A shared (or opened) link is cleared on the
  // next edit, so reloading never brings back a palette the visitor has since changed.
  const stateHash = () => {
    const p = new URLSearchParams({
      t: state.type === 'diverging' ? 'd' : 's',
      c: state.colors.map((c) => c.replace('#', '')).join(','),
      m: state.mode, n: String(state.steps),
    });
    if (state.type === 'diverging') p.set('mid', String(state.mid));
    if (state.curve !== 'linear') p.set('k', state.curve);
    if (state.lightness) p.set('l', state.lightness.map((L) => +L.toFixed(1)).join(','));
    return '#' + p.toString();
  };

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
    const type = p.get('t') === 'd' ? 'diverging' : 'sequential';
    if (colors.length < (type === 'diverging' ? 3 : 2)) return null;
    const modes = Array.from(document.querySelectorAll('#mode option')).map((o) => o.value);
    const parsed = {
      type,
      colors,
      mid: Math.max(1, Math.min(colors.length - 2, parseInt(p.get('mid'), 10) || Math.floor(colors.length / 2))),
      mode: modes.includes(p.get('m')) ? p.get('m') : DEFAULTS[type].mode,
      steps: Math.min(32, Math.max(2, parseInt(p.get('n'), 10) || DEFAULTS[type].steps)),
      curve: ['up', 'down'].includes(p.get('k')) ? p.get('k') : 'linear',
      lightness: null,
    };
    const l = (p.get('l') || '').split(',').filter(Boolean).map(Number);
    if (l.length === parsed.steps && l.every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) {
      parsed.lightness = l;
      parsed.lightnessKey = gradientKey(parsed);
    }
    return parsed;
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
  el.reverse.addEventListener('click', () => {
    state.colors.reverse();
    state.mid = state.colors.length - 1 - state.mid;
    buildList(); render();
  });
  el.sortL.addEventListener('click', () => { sortByLightness(); buildList(); render(); });
  const applyPaste = () => {
    const list = parseList(el.paste.value);
    const needed = isDiverging() ? 3 : 2;
    if (list.length >= needed) {
      state.colors = list;
      state.mid = Math.floor(list.length / 2);
      el.paste.value = '';
      buildList(); render();
    } else {
      showWarning(`Paste at least ${needed === 3 ? 'three' : 'two'} hex colors, separated by spaces or commas.`);
    }
  };
  el.applyPaste.addEventListener('click', applyPaste);
  el.paste.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPaste(); });

  el.mode.addEventListener('change', () => { state.mode = el.mode.value; render(); });
  el.steps.addEventListener('input', () => {
    const steps = +el.steps.value;
    if (state.lightness) {
      // Keep the adjusted curve's shape by sampling it at the new step positions.
      const old = state.lightness;
      state.lightness = positions(steps).map((t) => profileAt(old, t));
      state.steps = steps;
      scheduleOutputs();
    } else {
      state.steps = steps;
      scheduleSteps();
    }
  });
  el.curveBtns.forEach((b) => b.addEventListener('click', () => setCurve(b.dataset.curve)));
  el.share.addEventListener('click', sharePalette);
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(exportText[b.dataset.copy], b)));
  el.rampName.addEventListener('input', () => { rampNameEdited = el.rampName.value.trim() !== ''; renderNamedExports(); });
  el.qgisDownload.addEventListener('click', () =>
    downloadText(exportText['out-qgis'], safeFilename(rampName()) + '.xml', 'application/xml'));
  el.proDownload.addEventListener('click', downloadStylx);
  [el.gdalMin, el.gdalMax, el.gdalNodata].forEach((input) => input.addEventListener('input', renderGdal));
  el.gdalDownload.addEventListener('click', () =>
    downloadText(exportText['out-gdal'] + '\n', safeFilename(rampName()) + '.txt', 'text/plain'));

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

  // ---------- tabs ----------

  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  function selectTab(type, focus) {
    if (state.type === type && gradient) return;
    state = tabStates[type];
    tabs.forEach((t) => {
      const on = t.dataset.type === type;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    el.tabPanel.setAttribute('aria-labelledby', 'tab-' + type);
    el.mode.value = state.mode;
    el.steps.value = state.steps;
    rampNameEdited = false;
    buildList();
    buildPresets();
    render();
  }
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.type)));
  el.tabPanel.parentElement.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.findIndex((t) => t.dataset.type === state.type);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next.dataset.type, true);
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

  // initial UI sync (a shared link can open on either tab)
  tabs.forEach((t) => {
    const on = t.dataset.type === state.type;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  el.tabPanel.setAttribute('aria-labelledby', 'tab-' + state.type);
  el.mode.value = state.mode;
  el.steps.value = state.steps;
  buildList();
  buildPresets();
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
})();
