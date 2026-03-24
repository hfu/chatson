/**
 * main.js – Chatson map initialisation
 *
 * Layers (bottom → top):
 *   1. Protomaps dark basemap  (@protomaps/basemaps)
 *   2. Hillshade               (Mapterhorn / terrarium)
 *   3. [data overlays added later]
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LayerControl } from 'maplibre-gl-layer-control';
import 'maplibre-gl-layer-control/style.css';
import { Protocol } from 'pmtiles';
import { layers, DARK } from '@protomaps/basemaps';
import { initDragDrop } from './dragdrop.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BASEMAP_TILEJSON   = 'https://tunnel.optgeo.org/martin/protomaps-basemap';
const TERRAIN_TILEJSON   = 'https://tunnel.optgeo.org/martin/mapterhorn';
const BASEMAP_SOURCE     = 'protomaps';

// ── PMTiles protocol ─────────────────────────────────────────────────────────

const pmtilesProtocol = new Protocol();
maplibregl.addProtocol('pmtiles', (request) => {
  return pmtilesProtocol.tile(request).catch((err) => {
    console.error('PMTiles error:', err);
    throw err;
  });
});

// ── Build Protomaps dark basemap style ───────────────────────────────────────

/**
 * Returns a minimal MapLibre style object for the dark Protomaps basemap.
 * Glyphs and sprite are intentionally omitted; text uses system sans-serif.
 */
function buildBasemapStyle() {
  // Generate all basemap layer definitions for the given source name + theme.
  const baseLayers = layers(BASEMAP_SOURCE, DARK);

  // Override every text-font to system sans-serif so no external glyph
  // URL is required.
  const patchedLayers = baseLayers.map((layer) => {
    if (layer.layout && layer.layout['text-font']) {
      return {
        ...layer,
        layout: { ...layer.layout, 'text-font': ['sans-serif'] },
      };
    }
    return layer;
  });

  return {
    version: 8,
    // No `glyphs` or `sprite` – intentionally omitted per requirements.
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        url: BASEMAP_TILEJSON,
      },
      // Terrain sources (DEM + hillshade share the same TileJSON endpoint).
      'terrain-dem': {
        type: 'raster-dem',
        url: TERRAIN_TILEJSON,
        encoding: 'terrarium',
        tileSize: 512,
      },
      'terrain-hillshade': {
        type: 'raster-dem',
        url: TERRAIN_TILEJSON,
        encoding: 'terrarium',
        tileSize: 512,
      },
    },
    layers: patchedLayers,
    terrain: {
      source: 'terrain-dem',
      exaggeration: 1.0,
    },
  };
}

// ── DOM references ───────────────────────────────────────────────────────────

const loadingOverlay = document.getElementById('loading-overlay');
const statusBar      = document.getElementById('status-bar');

const DEFAULT_STATUS = 'Chatson';

// ── Initialise map ───────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: 'map',
  style: buildBasemapStyle(),
  hash: 'map',
  maxZoom: 22,
  // Default view – world overview; will be overridden by URL hash if present.
  center: [0, 20],
  zoom: 2,
});

// ── Loading overlay (dataloading / idle) ─────────────────────────────────────

map.on('dataloading', () => {
  loadingOverlay.classList.remove('hidden');
});

map.on('idle', () => {
  loadingOverlay.classList.add('hidden');
});

// ── Controls ─────────────────────────────────────────────────────────────────

// Navigation control (zoom + compass) – bottom-left
map.addControl(new maplibregl.NavigationControl(), 'bottom-left');

// Layer control – bottom-left, below NavigationControl
map.addControl(
  new LayerControl({
    showOpacitySlider: true,
    showLayerSymbol: true,
  }),
  'bottom-left',
);

// ── Hillshade layer (added after map style loads) ─────────────────────────────

map.on('load', () => {
  // Add hillshade layer above the basemap layers.
  // It will sit below any future data-overlay layers added via addLayer().
  map.addLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'terrain-hillshade',
    paint: {
      'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
      'hillshade-shadow-color':    'rgba(0,0,0,0.35)',
      'hillshade-accent-color':    'rgba(180,140,100,0.2)',
      'hillshade-illumination-direction': 315,
      'hillshade-exaggeration': 1.0,
    },
  });
});

// ── Status bar – hover to show feature info ───────────────────────────────────

// Show pointer cursor over interactive features and update status bar.
map.on('mousemove', (e) => {
  const features = map.queryRenderedFeatures(e.point);
  if (features.length > 0) {
    const f = features[0];
    const name =
      f.properties?.name ||
      f.properties?.label ||
      f.properties?.id ||
      f.layer?.id;
    statusBar.textContent = name ? String(name) : DEFAULT_STATUS;
  } else {
    statusBar.textContent = DEFAULT_STATUS;
  }
});

map.on('mouseleave', () => {
  statusBar.textContent = DEFAULT_STATUS;
});

export { map };

// ── Drag-and-drop ZIP extraction ─────────────────────────────────────────────

// Attach drag-and-drop handling to the map container once the DOM is ready.
initDragDrop(document.getElementById('map'));
