# Phosphor

A small static site, built on [chroma.js](https://github.com/gka/chroma.js), for making multi-hue gradients whose perceptual lightness (CIE L*) changes at a steady rate from one end to the other.

## Use

Phosphor is part of joshuastevens.net: it lives in the Hugo site's `static/phosphor/` folder, which Hugo publishes unchanged at https://www.joshuastevens.net/phosphor/. Run `hugo server` and open http://localhost:1313/phosphor/ to work on it locally.

The site opens in dark mode; the button in the header switches themes and remembers the choice.

- **Colors:** type or pick hex colors, reorder them, or paste a list (`#fafa6e, #2a4858, …`).
- **Interpolation space:** Lab, LCh, OKLab, OKLCh, HSL, RGB, linear RGB, or Bezier (Lab).
- **Lightness correction:** always on, using chroma.js `correctLightness()`, which moves each sample along the scale so L* is linear between the first and last color. This needs lightness that only goes up or only goes down across your colors. If it doesn't, the page shows and exports the uncorrected gradient instead and labels it, suggesting **Sort by lightness**.
- **Preset palettes:** *Show preset palettes* reveals cards for the 18 ColorBrewer sequential schemes (9 classes, from `chroma.brewer`) and matplotlib's Viridis, Plasma, Magma and Inferno (11 evenly spaced stops from each 256-entry colormap). Clicking a card loads its colors, and the ArcGIS Pro ramp is named after it.
- **Output:** the corrected gradient; clickable swatches; an L* chart against the linear target, with the uncorrected curve for reference; hex, CSS and chroma.js exports.
- **ArcGIS Pro:** *Download .stylx* saves a style file containing one color ramp: a `CIMMultipartColorRamp` of 16 colors joined by 15 `CIMLinearContinuousColorRamp` segments, which Pro blends in CIELAB so L* stays linear. In Pro, open **Catalog → Styles**, right-click and choose **Add → Add Style**. The ramp then appears in the Symbology pane's color scheme list (turn on **Show names** and **Show all**). The file is built in the browser with [sql.js](https://github.com/sql-js/sql.js), and its layout matches a style saved by ArcGIS Pro 3.1.
- **Color vision simulation:** the header toggles preview the page as seen with protanopia, deuteranopia, tritanopia or achromatopsia. They use SVG color-matrix filters from Machado, Oliveira & Fernandes (2009) at full severity, applied in linear RGB; achromatopsia maps each color to its luminance. Click the active toggle again to turn it off.

All settings are stored in the URL hash, so a gradient can be bookmarked or shared.

## Files

- `index.html`: markup; loads chroma.js 2.4.2 from cdnjs (sql.js 1.14.2 is loaded on demand for the .stylx export)
- `style.css`: styles, including light and dark themes
- `app.js`: gradient math and UI
- `assets/`: header logo (`logo.png`), `favicon-32.png` and `apple-touch-icon.png`, all generated from `phosphor-logo-lrg.png` (cropped, shadow removed); `favicon.ico` sits at the root
- `assets/social-card.jpg`: 1200×630 social sharing card, referenced by the Open Graph and Twitter tags in `index.html`. Its generator, `make_social_card.py`, sits with the source logo in the site's unpublished `assets/phosphor/` folder.
