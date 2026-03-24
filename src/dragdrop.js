/**
 * dragdrop.js – Drag-and-drop target for WhatsApp .zip chat exports.
 *
 * Attaches drag-and-drop event listeners to the map container element.
 * Shows a visual overlay while a file is being dragged over the map,
 * then delegates to extractAndLog() on successful drop.
 */

import { extractAndLog } from './zip.js';

/**
 * Initialise drag-and-drop handling on the given container element.
 *
 * @param {HTMLElement} container - The element to use as the drop target
 *   (typically the #map div).
 */
export function initDragDrop(container) {
  // Create the visual drop-zone overlay (hidden by default).
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.textContent = 'Drop WhatsApp .zip here';
  container.appendChild(overlay);

  // Prevent the browser's default file-open behaviour for all drag events.
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    overlay.classList.add('active');
  });

  container.addEventListener('dragleave', (e) => {
    // Only hide the overlay when the cursor truly leaves the container,
    // not when it passes over a child element.
    if (!container.contains(e.relatedTarget)) {
      overlay.classList.remove('active');
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    overlay.classList.remove('active');

    const file = e.dataTransfer.files[0];

    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      console.warn('Ignored dropped file (not a .zip):', file.name);
      return;
    }

    console.log('Processing ZIP file:', file.name);
    await extractAndLog(file);
  });
}
