/**
 * zip.js – In-browser ZIP extraction using JSZip.
 *
 * Exports a single async function that accepts a File object,
 * extracts every entry, and logs its name + text content to the console.
 */

import JSZip from 'jszip';

/**
 * Extract all entries from a ZIP file and log their names and text content.
 *
 * @param {File} file - The .zip File object obtained from a drop event.
 * @returns {Promise<void>}
 */
export async function extractAndLog(file) {
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    console.error('Failed to load ZIP file:', err);
    throw err;
  }

  for (const [path, entry] of Object.entries(zip.files)) {
    // Skip directory entries – they have no content.
    if (entry.dir) continue;

    try {
      const content = await entry.async('string');
      console.log('ENTRY:', path);
      console.log(content);
    } catch (err) {
      console.error(`Failed to read entry "${path}":`, err);
      throw err;
    }
  }
}
