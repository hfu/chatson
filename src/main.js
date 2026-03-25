/**
 * main.js - Chatson map initialisation
 *
 * Layers (bottom -> top):
 *   1. Protomaps dark basemap
 *   2. Hillshade
 *   3. Chatson extracted points
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LayerControl } from 'maplibre-gl-layer-control';
import 'maplibre-gl-layer-control/style.css';
import { Protocol } from 'pmtiles';
import { layers, DARK } from '@protomaps/basemaps';
import { truncate } from '@turf/truncate';
import { initDragDrop } from './dragdrop.js';
import { extractAndLog } from './zip.js';

// -- Constants ---------------------------------------------------------------

const BASEMAP_TILEJSON = 'https://tunnel.optgeo.org/martin/protomaps-basemap';
const TERRAIN_TILEJSON = 'https://tunnel.optgeo.org/martin/mapterhorn';
const OVERTURE_PLACES_TILEJSON = 'https://tunnel.optgeo.org/martin/places';
const BASEMAP_SOURCE = 'protomaps';

const CHAT_SOURCE_ID = 'chatson-points';
const CHAT_LAYER_ID = 'chatson-point-circles';
const OVERTURE_PLACES_SOURCE_ID = 'overture-places';
const OVERTURE_PLACES_LAYER_ID = 'overture-places-labels';
const OVERTURE_PLACES_MIN_ZOOM = 16;
const SHARE_QUERY_KEY = 'g';
const MAX_SHARE_URL_LENGTH = 8000;
const SHARE_COORD_DECIMALS = 5;

const DUPLICATE_RADIUS_M = 10;
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
const SENSITIVE_PROPERTY_KEYS = ['entry', 'line', 'mapsUrl', 'timestamp', 'user'];
const INTERNAL_PROPERTY_KEYS = ['sequence', 'chatsonId', 'layout', 'source', 'state'];

const DEFAULT_STATUS = 'Chatson';

// -- Global state ------------------------------------------------------------

const appState = {
  omitDuplicates: false,
  keepSensitiveFields: false,
  rawFeatureCollection: EMPTY_FEATURE_COLLECTION,
  renderedFeatureCollection: EMPTY_FEATURE_COLLECTION,
  lastFileName: null,
  nextFeatureId: 1,
};

// -- PMTiles protocol --------------------------------------------------------

const pmtilesProtocol = new Protocol();
maplibregl.addProtocol('pmtiles', (request) => {
  return pmtilesProtocol.tile(request).catch((err) => {
    console.error('PMTiles error:', err);
    throw err;
  });
});

// -- Style builders ----------------------------------------------------------

function buildBasemapStyle() {
  const baseLayers = layers(BASEMAP_SOURCE, DARK);

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
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        url: BASEMAP_TILEJSON,
      },
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

// -- DOM references ----------------------------------------------------------

const loadingOverlay = document.getElementById('loading-overlay');
const statusBar = document.getElementById('status-bar');

// -- Data helpers ------------------------------------------------------------

function isFeatureCollectionReady(collection) {
  return collection && Array.isArray(collection.features) && collection.features.length > 0;
}

function sanitizeFilename(name) {
  return (name || 'chatson-export')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'chatson-export';
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceBetweenCoordinates(a, b) {
  const [lngA, latA] = a;
  const [lngB, latB] = b;
  const earthRadius = 6371000;
  const deltaLat = toRadians(latB - latA);
  const deltaLng = toRadians(lngB - lngA);
  const latARad = toRadians(latA);
  const latBRad = toRadians(latB);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latARad) * Math.cos(latBRad) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
}

function dedupeFeatures(features, radiusMeters) {
  const kept = [];

  for (const feature of features) {
    const mapsUrl = feature.properties?.mapsUrl;
    const coordinates = feature.geometry?.coordinates;

    const isDuplicate = kept.some((candidate) => {
      const sameUrl = mapsUrl && mapsUrl === candidate.properties?.mapsUrl;
      const nearby = distanceBetweenCoordinates(coordinates, candidate.geometry.coordinates) <= radiusMeters;
      return sameUrl || nearby;
    });

    if (!isDuplicate) {
      kept.push(feature);
    }
  }

  return kept;
}

function normalizeFeatureProperties(properties = {}) {
  const next = { ...properties };

  for (const key of INTERNAL_PROPERTY_KEYS) {
    delete next[key];
  }

  if (!Object.prototype.hasOwnProperty.call(next, 'text') || next.text === undefined) {
    next.text = null;
  }

  return next;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function buildShareFeatureCollection() {
  const download = buildDownloadFeatureCollection();
  return truncate(download, {
    precision: SHARE_COORD_DECIMALS,
    coordinates: 2,
    mutate: false,
  });
}

async function streamToUint8Array(stream) {
  const response = new Response(stream);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }

  const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return streamToUint8Array(compressedStream);
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this browser.');
  }

  const decompressedStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return streamToUint8Array(decompressedStream);
}

function assignFeatureIds(featureCollection) {
  return {
    type: 'FeatureCollection',
    features: (featureCollection.features || []).map((feature) => ({
      ...feature,
      properties: {
        ...normalizeFeatureProperties(feature.properties),
        chatsonId: String(appState.nextFeatureId++),
      },
    })),
  };
}

function cloneFeatureForRender(feature, sequence) {
  const nextProps = normalizeFeatureProperties(feature.properties);

  if (!appState.keepSensitiveFields) {
    for (const key of SENSITIVE_PROPERTY_KEYS) {
      delete nextProps[key];
    }
  }

  return {
    ...feature,
    properties: {
      ...nextProps,
      chatsonId: feature.properties?.chatsonId,
      sequence,
    },
  };
}

function buildRenderedFeatureCollection() {
  const rawFeatures = appState.rawFeatureCollection.features || [];
  const visible = appState.omitDuplicates
    ? dedupeFeatures(rawFeatures, DUPLICATE_RADIUS_M)
    : rawFeatures;

  return {
    type: 'FeatureCollection',
    features: visible.map((feature, index) => cloneFeatureForRender(feature, index + 1)),
  };
}

function buildDownloadFeatureCollection() {
  return {
    type: 'FeatureCollection',
    features: (appState.renderedFeatureCollection.features || []).map((feature) => {
      const properties = { ...feature.properties };
      for (const key of INTERNAL_PROPERTY_KEYS) {
        delete properties[key];
      }
      return {
        ...feature,
        properties,
      };
    }),
  };
}

function buildPopupFeatureForDisplay(feature) {
  const properties = { ...normalizeFeatureProperties(feature.properties) };
  for (const key of INTERNAL_PROPERTY_KEYS) {
    delete properties[key];
  }

  return {
    type: feature.type,
    geometry: feature.geometry,
    properties,
  };
}

function updateRawFeatureText(chatsonId, nextText) {
  const target = (appState.rawFeatureCollection.features || []).find(
    (candidate) => candidate.properties?.chatsonId === chatsonId,
  );

  if (!target) {
    return false;
  }

  target.properties = {
    ...target.properties,
    text: nextText === '' ? null : nextText,
  };

  return true;
}

// -- Map and data rendering --------------------------------------------------

const chatPopup = new maplibregl.Popup({
  closeButton: true,
  closeOnClick: false,
  maxWidth: '360px',
});

function createPopupContent(feature) {
  const container = document.createElement('div');
  container.className = 'chatson-popup';

  const popupFeature = buildPopupFeatureForDisplay(feature);
  const editableValue = popupFeature.properties?.text ?? '';
  const serializable = {
    ...popupFeature,
    properties: {
      ...popupFeature.properties,
      text: '__CHATSON_EDITABLE_TEXT__',
    },
  };

  const template = JSON.stringify(serializable, null, 2);
  const [before, after] = template.split('__CHATSON_EDITABLE_TEXT__');

  const jsonBlock = document.createElement('pre');
  jsonBlock.className = 'chatson-popup__json';
  jsonBlock.append(document.createTextNode(before));

  const textEditor = document.createElement('span');
  textEditor.className = 'chatson-popup__editable-text';
  textEditor.contentEditable = 'true';
  textEditor.spellcheck = false;
  textEditor.textContent = editableValue;
  jsonBlock.append(textEditor);

  jsonBlock.append(document.createTextNode(after));

  const message = document.createElement('div');
  message.className = 'chatson-popup__message';

  textEditor.addEventListener('blur', () => {
    const chatsonId = feature.properties?.chatsonId;
    const updated = updateRawFeatureText(chatsonId, textEditor.textContent ?? '');

    if (!updated) {
      message.textContent = 'Point not found in source data.';
      return;
    }

    updateMapData({ fitToData: false, closePopup: false });
    void syncShareUrlInAddressBar();

    // Do NOT call setDOMContent here: rebuilding the popup DOM during blur
    // removes the close button node before its click event fires, preventing
    // the × button from working.
    message.textContent = 'Saved.';
  });

  container.append(jsonBlock, message);
  return container;
}

function ensureDataLayers() {
  if (map.getSource(CHAT_SOURCE_ID)) {
    return;
  }

  map.addSource(CHAT_SOURCE_ID, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });

  map.addLayer({
    id: CHAT_LAYER_ID,
    type: 'circle',
    source: CHAT_SOURCE_ID,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 10, 7, 16, 10],
      'circle-color': ['case', ['==', ['coalesce', ['get', 'text'], ''], ''], '#7db3d8', '#3e7592'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#f7fbff',
      'circle-opacity': 0.9,
    },
  });
}

function ensureOverturePlacesLayer() {
  if (map.getSource(OVERTURE_PLACES_SOURCE_ID)) {
    return;
  }

  map.addSource(OVERTURE_PLACES_SOURCE_ID, {
    type: 'vector',
    url: OVERTURE_PLACES_TILEJSON,
  });

  map.addLayer(
    {
      id: OVERTURE_PLACES_LAYER_ID,
      type: 'symbol',
      source: OVERTURE_PLACES_SOURCE_ID,
      'source-layer': 'place',
      minzoom: OVERTURE_PLACES_MIN_ZOOM,
      filter: ['any', ['has', '@name'], ['has', 'names']],
      layout: {
        'text-field': ['coalesce', ['get', '@name'], ['get', 'names']],
        'text-size': ['interpolate', ['linear'], ['zoom'], OVERTURE_PLACES_MIN_ZOOM, 11.5, 18, 14],
        'text-font': ['sans-serif'],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.6,
      },
      paint: {
        'text-color': 'rgba(188, 196, 204, 0.78)',
        'text-halo-color': 'rgba(20, 24, 30, 0.86)',
        'text-halo-width': 1,
      },
    },
    CHAT_LAYER_ID,
  );
}

async function parseSharedFeatureCollectionFromUrl() {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get(SHARE_QUERY_KEY);
  if (!encoded) {
    return null;
  }

  try {
    let json;

    if (encoded.startsWith('gz.')) {
      const compressedBytes = base64UrlDecodeBytes(encoded.slice(3));
      const bytes = await gunzipBytes(compressedBytes);
      json = new TextDecoder().decode(bytes);
    } else if (encoded.startsWith('u8.')) {
      const bytes = base64UrlDecodeBytes(encoded.slice(3));
      json = new TextDecoder().decode(bytes);
    } else {
      // Backward compatibility for older non-prefixed payloads.
      const bytes = base64UrlDecodeBytes(encoded);
      json = new TextDecoder().decode(bytes);
    }

    const parsed = JSON.parse(json);

    if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed?.features)) {
      return null;
    }

    return {
      type: 'FeatureCollection',
      features: parsed.features.map((feature) => ({
        ...feature,
        properties: normalizeFeatureProperties(feature.properties),
      })),
    };
  } catch (err) {
    console.error('Failed to decode shared URL payload:', err);
    return null;
  }
}

async function buildShareUrl() {
  if (!isFeatureCollectionReady(appState.renderedFeatureCollection)) {
    return null;
  }

  const rawPayload = JSON.stringify(buildDownloadFeatureCollection());
  const sharePayload = JSON.stringify(buildShareFeatureCollection());
  const rawBytes = new TextEncoder().encode(rawPayload);
  const quantizedBytes = new TextEncoder().encode(sharePayload);
  const gzippedBytes = await gzipBytes(quantizedBytes);

  let encoded;
  let mode;

  if (gzippedBytes && gzippedBytes.length < quantizedBytes.length) {
    encoded = `gz.${base64UrlEncodeBytes(gzippedBytes)}`;
    mode = 'gzip';
  } else {
    encoded = `u8.${base64UrlEncodeBytes(quantizedBytes)}`;
    mode = 'plain';
  }

  const gzipLength = gzippedBytes ? gzippedBytes.length : 0;
  const ratio = gzippedBytes
    ? ((gzippedBytes.length / rawBytes.length) * 100).toFixed(1)
    : 'n/a';
  console.info(
    `[share] raw=${rawBytes.length}B quantized=${quantizedBytes.length}B gzip=${gzipLength}B ratio=${ratio}% mode=${mode}`,
  );

  const url = new URL(window.location.href);
  url.searchParams.set(SHARE_QUERY_KEY, encoded);
  return url;
}

async function syncShareUrlInAddressBar() {
  const url = await buildShareUrl();
  if (!url) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete(SHARE_QUERY_KEY);
    window.history.replaceState(null, '', nextUrl);
    return;
  }

  if (url.toString().length > MAX_SHARE_URL_LENGTH) {
    return;
  }

  window.history.replaceState(null, '', url);
}

async function copyShareUrlToClipboard() {
  const url = await buildShareUrl();
  if (!url) {
    dataControl.setMessage('No GeoJSON available to share.', true);
    return;
  }

  const shareUrl = url.toString();

  if (shareUrl.length > MAX_SHARE_URL_LENGTH) {
    dataControl.setMessage('Share URL is too long. Reduce points or use file download.', true);
    return;
  }

  try {
    await navigator.clipboard.writeText(shareUrl);
    dataControl.setMessage('Share URL copied to clipboard.');
  } catch (err) {
    console.error('Failed to copy share URL:', err);
    dataControl.setMessage('Could not copy URL automatically. Copy it from the address bar.', true);
  }
}

function fitMapToRenderedData() {
  if (!isFeatureCollectionReady(appState.renderedFeatureCollection)) {
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  for (const feature of appState.renderedFeatureCollection.features) {
    bounds.extend(feature.geometry.coordinates);
  }

  map.fitBounds(bounds, {
    padding: 60,
    duration: 800,
    maxZoom: 15,
  });
}

function updateMapData({ fitToData = true, closePopup = true } = {}) {
  appState.renderedFeatureCollection = buildRenderedFeatureCollection();

  if (closePopup) {
    chatPopup.remove();
  }

  const source = map.getSource(CHAT_SOURCE_ID);
  if (source) {
    source.setData(appState.renderedFeatureCollection);
  }

  if (fitToData) {
    fitMapToRenderedData();
  }

  syncDataControl();
}

function downloadFeatureCollection() {
  if (!isFeatureCollectionReady(appState.renderedFeatureCollection)) {
    dataControl.setMessage('No GeoJSON available to download.', true);
    return;
  }

  const payload = JSON.stringify(buildDownloadFeatureCollection());
  const blob = new Blob([payload], { type: 'application/geo+json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = `${sanitizeFilename(appState.lastFileName)}.geojson`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  dataControl.setMessage(`Downloaded ${appState.renderedFeatureCollection.features.length} point(s) as GeoJSON.`);
}

// -- Data control ------------------------------------------------------------

function createDataControl({ onToggleDuplicates, onToggleSensitiveFields, onDownload, onShareUrl }) {
  return {
    map: null,
    container: null,
    summaryElement: null,
    messageElement: null,
    checkboxElement: null,
    sensitiveCheckboxElement: null,
    buttonElement: null,
    messageText: 'Drop a WhatsApp .zip to extract points.',
    isError: false,
    summaryText: 'No GeoJSON loaded.',
    omitDuplicates: false,
    keepSensitiveFields: false,

    onAdd(controlMap) {
      this.map = controlMap;

      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl chatson-data-control';

      const panel = document.createElement('div');
      panel.className = 'chatson-data-control__panel';

      const title = document.createElement('div');
      title.className = 'chatson-data-control__title';
      title.textContent = 'Chat Data';

      const dedupeLabel = document.createElement('label');
      dedupeLabel.className = 'chatson-data-control__toggle';
      const dedupeCheckbox = document.createElement('input');
      dedupeCheckbox.type = 'checkbox';
      dedupeCheckbox.addEventListener('change', (event) => {
        onToggleDuplicates(event.target.checked);
      });
      const dedupeText = document.createElement('span');
      dedupeText.textContent = 'omit duplicates';
      dedupeLabel.append(dedupeCheckbox, dedupeText);

      const sensitiveLabel = document.createElement('label');
      sensitiveLabel.className = 'chatson-data-control__toggle';
      const sensitiveCheckbox = document.createElement('input');
      sensitiveCheckbox.type = 'checkbox';
      sensitiveCheckbox.addEventListener('change', (event) => {
        onToggleSensitiveFields(event.target.checked);
      });
      const sensitiveText = document.createElement('span');
      sensitiveText.textContent = 'keep potentially sensitive fields';
      sensitiveLabel.append(sensitiveCheckbox, sensitiveText);

      const downloadButton = document.createElement('button');
      downloadButton.type = 'button';
      downloadButton.className = 'chatson-data-control__button';
      downloadButton.textContent = 'download GeoJSON';
      downloadButton.addEventListener('click', () => {
        onDownload();
      });

      const shareButton = document.createElement('button');
      shareButton.type = 'button';
      shareButton.className = 'chatson-data-control__button';
      shareButton.textContent = 'copy share URL';
      shareButton.addEventListener('click', () => {
        onShareUrl();
      });

      const summary = document.createElement('div');
      summary.className = 'chatson-data-control__summary';

      const message = document.createElement('div');
      message.className = 'chatson-data-control__message';

      panel.append(title, dedupeLabel, sensitiveLabel, downloadButton, shareButton, summary, message);
      container.appendChild(panel);

      this.container = container;
      this.summaryElement = summary;
      this.messageElement = message;
      this.checkboxElement = dedupeCheckbox;
      this.sensitiveCheckboxElement = sensitiveCheckbox;
      this.buttonElement = downloadButton;

      this.render();
      return container;
    },

    onRemove() {
      this.container?.remove();
      this.map = null;
    },

    setSummary(text) {
      this.summaryText = text;
      this.render();
    },

    setMessage(text, isError = false) {
      this.messageText = text;
      this.isError = isError;
      this.render();
    },

    setDownloadEnabled(enabled) {
      if (this.buttonElement) {
        this.buttonElement.disabled = !enabled;
      }
    },

    setOmitDuplicates(checked) {
      this.omitDuplicates = checked;
      if (this.checkboxElement) {
        this.checkboxElement.checked = checked;
      }
      this.render();
    },

    setSensitiveFields(checked) {
      this.keepSensitiveFields = checked;
      if (this.sensitiveCheckboxElement) {
        this.sensitiveCheckboxElement.checked = checked;
      }
      this.render();
    },

    render() {
      if (this.summaryElement) {
        this.summaryElement.textContent = this.summaryText;
      }

      if (this.messageElement) {
        this.messageElement.textContent = this.messageText;
        this.messageElement.dataset.state = this.isError ? 'error' : 'info';
      }
    },
  };
}

const dataControl = createDataControl({
  onToggleDuplicates(checked) {
    appState.omitDuplicates = checked;
    updateMapData({ fitToData: false });
  },
  onToggleSensitiveFields(checked) {
    appState.keepSensitiveFields = checked;
    updateMapData({ fitToData: false });
  },
  onDownload() {
    downloadFeatureCollection();
  },
  onShareUrl() {
    copyShareUrlToClipboard();
  },
});

function syncDataControl() {
  const rawCount = appState.rawFeatureCollection.features.length;
  const renderedCount = appState.renderedFeatureCollection.features.length;
  const duplicateCount = Math.max(0, rawCount - renderedCount);

  if (!rawCount) {
    dataControl.setSummary('No GeoJSON loaded.');
    dataControl.setDownloadEnabled(false);
    dataControl.setOmitDuplicates(appState.omitDuplicates);
    dataControl.setSensitiveFields(appState.keepSensitiveFields);
    return;
  }

  const summary = appState.omitDuplicates
    ? `${rawCount} extracted, ${renderedCount} shown, ${duplicateCount} omitted.`
    : `${renderedCount} point(s) loaded.`;

  dataControl.setSummary(summary);
  dataControl.setDownloadEnabled(renderedCount > 0);
  dataControl.setOmitDuplicates(appState.omitDuplicates);
  dataControl.setSensitiveFields(appState.keepSensitiveFields);
}

// -- Map initialisation ------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: buildBasemapStyle(),
  hash: 'map',
  maxZoom: 22,
  center: [0, 20],
  zoom: 2,
});

map.on('dataloading', () => {
  loadingOverlay.classList.remove('hidden');
});

map.on('idle', () => {
  loadingOverlay.classList.add('hidden');
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-left');
map.addControl(
  new LayerControl({
    showOpacitySlider: true,
    showLayerSymbol: true,
  }),
  'bottom-left',
);
map.addControl(dataControl, 'top-right');

map.on('load', async () => {
  map.addLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'terrain-hillshade',
    paint: {
      'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
      'hillshade-shadow-color': 'rgba(0,0,0,0.35)',
      'hillshade-accent-color': 'rgba(180,140,100,0.2)',
      'hillshade-illumination-direction': 315,
      'hillshade-exaggeration': 1.0,
    },
  });

  ensureDataLayers();
  ensureOverturePlacesLayer();

  const shared = await parseSharedFeatureCollectionFromUrl();
  if (shared && shared.features.length > 0) {
    appState.rawFeatureCollection = assignFeatureIds(shared);
    appState.lastFileName = 'shared-url';
    dataControl.setMessage(`Loaded ${shared.features.length} point(s) from shared URL.`);
    updateMapData({ fitToData: true });
    return;
  }

  updateMapData({ fitToData: false });
});

map.on('mousemove', (e) => {
  const chatFeatures = map.queryRenderedFeatures(e.point, { layers: [CHAT_LAYER_ID] });
  map.getCanvas().style.cursor = chatFeatures.length > 0 ? 'pointer' : '';

  if (chatFeatures.length > 0) {
    const f = chatFeatures[0];
    statusBar.textContent = String(f.properties?.line || f.properties?.text || DEFAULT_STATUS);
    return;
  }

  const features = map.queryRenderedFeatures(e.point);
  if (features.length > 0) {
    const f = features[0];
    const name = f.properties?.name || f.properties?.label || f.properties?.id || f.layer?.id;
    statusBar.textContent = name ? String(name) : DEFAULT_STATUS;
  } else {
    statusBar.textContent = DEFAULT_STATUS;
  }
});

map.on('mouseleave', () => {
  map.getCanvas().style.cursor = '';
  statusBar.textContent = DEFAULT_STATUS;
});

map.on('click', (e) => {
  const chatFeatures = map.queryRenderedFeatures(e.point, { layers: [CHAT_LAYER_ID] });
  if (chatFeatures.length === 0) {
    chatPopup.remove();
    return;
  }

  const feature = chatFeatures[0];
  chatPopup
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(createPopupContent(feature))
    .addTo(map);
});

export { map };

// -- Drag and drop -----------------------------------------------------------

initDragDrop(document.getElementById('map'), async (file) => {
  dataControl.setMessage(`Processing ${file.name}...`);

  const featureCollection = assignFeatureIds(await extractAndLog(file));
  appState.lastFileName = file.name;
  appState.rawFeatureCollection = featureCollection;

  updateMapData({ fitToData: true });

  if (featureCollection.features.length === 0) {
    dataControl.setMessage(`No Google Maps location URLs found in ${file.name}.`, true);
    return;
  }

  dataControl.setMessage(`Loaded ${featureCollection.features.length} point(s) from ${file.name}.`);
});
