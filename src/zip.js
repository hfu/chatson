/**
 * zip.js – In-browser ZIP extraction using JSZip.
 *
 * Exports a single async function that accepts a File object,
 * extracts every entry, recursively expands nested ZIP attachments,
 * and logs location links as GeoJSON Point features.
 */

import JSZip from 'jszip';

const GOOGLE_MAPS_QUERY_RE = /https:\/\/maps\.google\.com\/\?q=([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)/;
const CHAT_LINE_BRACKET_RE = /^\[(?<timestamp>[^\]]+)\]\s*(?<user>[^:]+):\s*(?<message>.*)$/;
const TEXT_DECODER = new TextDecoder();
const DIRECTIONAL_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ATTACHMENT_MARKERS = ['<添付ファイル:', '<attached:', '<adjunto:', '<pièce jointe:', '<Anhang:'];
const ADMIN_MESSAGE_PATTERNS = [
  /end-to-end encrypted/i,
  /エンドツーエンド暗号化/,
  /詳しくはこちら/,
  /created (this )?group/i,
  /グループを作成しました/,
  /あなたが作成したグループです/,
  /joined using this group's invite link/i,
  /グループリンクから参加しました/,
  /changed (the )?(group )?(subject|description|icon)/i,
  /left|removed|added/i,
  /退出しました/,
  /追加しました/,
  /削除しました/,
  /通話/,
  /call/i,
];

function isZipEntry(name, bytes) {
  if (name.toLowerCase().endsWith('.zip')) {
    return true;
  }

  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function normalizeChatText(value) {
  return value
    .replace(DIRECTIONAL_MARKS_RE, '')
    .replaceAll('\u00a0', ' ')
    .trim();
}

function parseBracketStyleChatLine(normalizedLine) {
  const match = normalizedLine.match(CHAT_LINE_BRACKET_RE);
  if (!match?.groups) {
    return null;
  }

  return {
    timestamp: normalizeChatText(match.groups.timestamp),
    user: normalizeChatText(match.groups.user),
    message: normalizeChatText(match.groups.message),
    line: normalizedLine,
  };
}

function parseDashStyleChatLine(normalizedLine) {
  const separatorIndex = normalizedLine.indexOf(' - ');
  if (separatorIndex <= 0) {
    return null;
  }

  const timestamp = normalizeChatText(normalizedLine.slice(0, separatorIndex));
  const remainder = normalizeChatText(normalizedLine.slice(separatorIndex + 3));
  const colonIndex = remainder.indexOf(':');

  if (!timestamp || colonIndex <= 0) {
    return null;
  }

  const user = normalizeChatText(remainder.slice(0, colonIndex));
  const message = normalizeChatText(remainder.slice(colonIndex + 1));

  if (!user || !message) {
    return null;
  }

  return {
    timestamp,
    user,
    message,
    line: normalizedLine,
  };
}

function parseChatLine(rawLine) {
  const normalizedLine = normalizeChatText(rawLine);
  if (!normalizedLine) {
    return null;
  }

  const bracketLine = parseBracketStyleChatLine(normalizedLine);
  if (bracketLine) {
    return bracketLine;
  }

  return parseDashStyleChatLine(normalizedLine);
}

function isAdministrativeMessage(message) {
  return ADMIN_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isAttachmentMessage(message) {
  return ATTACHMENT_MARKERS.some((marker) => message.includes(marker));
}

function appendBufferedMessage(userBuffers, user, message) {
  const existingMessages = userBuffers.get(user) || [];
  existingMessages.push(message);
  userBuffers.set(user, existingMessages);
}

function appendContinuation(userBuffers, user, message) {
  if (!user) return;

  const existingMessages = userBuffers.get(user);
  if (!existingMessages || existingMessages.length === 0) {
    return;
  }

  existingMessages[existingMessages.length - 1] = `${existingMessages[existingMessages.length - 1]}\n${message}`;
}

function flushUserBuffer(userBuffers, user) {
  const messages = userBuffers.get(user) || [];
  userBuffers.delete(user);

  if (messages.length === 0) {
    return null;
  }

  return messages.join('\n');
}

function shouldBufferMessage(message) {
  if (!message) {
    return false;
  }

  if (message.match(GOOGLE_MAPS_QUERY_RE)) {
    return false;
  }

  if (isAttachmentMessage(message) || isAdministrativeMessage(message)) {
    return false;
  }

  return true;
}

function createPointFeature(match, chatLine, entryName, text) {
  const latitude = Number.parseFloat(match[1]);
  const longitude = Number.parseFloat(match[2]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    properties: {
      entry: entryName,
      user: chatLine.user,
      timestamp: chatLine.timestamp,
      mapsUrl: match[0],
      line: chatLine.line,
      text,
    },
  };
}

function collectGeoJsonFeatures(text, entryName) {
  const lines = text.split(/\r?\n/);
  const features = [];
  const userBuffers = new Map();
  let lastBufferedUser = null;

  for (const rawLine of lines) {
    const chatLine = parseChatLine(rawLine);

    if (!chatLine) {
      const continuation = normalizeChatText(rawLine);

      const fallbackMatch = continuation.match(GOOGLE_MAPS_QUERY_RE);
      if (fallbackMatch) {
        const feature = createPointFeature(
          fallbackMatch,
          {
            timestamp: undefined,
            user: undefined,
            message: continuation,
            line: continuation,
          },
          entryName,
          null,
        );

        if (feature) {
          console.log('GEOJSON:', feature);
          features.push(feature);
        }
      }

      if (continuation && lastBufferedUser) {
        appendContinuation(userBuffers, lastBufferedUser, continuation);
      }
      continue;
    }

    lastBufferedUser = null;

    if (!chatLine.user || !chatLine.message) {
      continue;
    }

    const match = chatLine.message.match(GOOGLE_MAPS_QUERY_RE);
    if (match) {
      const feature = createPointFeature(match, chatLine, entryName, flushUserBuffer(userBuffers, chatLine.user));
      if (!feature) continue;

      console.log('GEOJSON:', feature);
      features.push(feature);
      continue;
    }

    if (!shouldBufferMessage(chatLine.message)) {
      continue;
    }

    appendBufferedMessage(userBuffers, chatLine.user, chatLine.message);
    lastBufferedUser = chatLine.user;
  }

  return features;
}

async function extractZipSource(source, label, features) {
  let zip;

  try {
    zip = await JSZip.loadAsync(source);
  } catch (err) {
    console.error('Failed to load ZIP file:', label, err);
    throw err;
  }

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    const entryLabel = `${label} :: ${path}`;

    try {
      const bytes = await entry.async('uint8array');
      console.log('ENTRY:', path);

      if (isZipEntry(path, bytes)) {
        console.log('Processing ZIP file:', path);
        await extractZipSource(bytes, entryLabel, features);
        continue;
      }

      const content = TEXT_DECODER.decode(bytes);
      console.log(content);
      features.push(...collectGeoJsonFeatures(content, entryLabel));
    } catch (err) {
      console.error(`Failed to read entry "${path}":`, err);
      throw err;
    }
  }
}

/**
 * Extract all entries from a ZIP file and log their names and text content.
 *
 * @param {File} file - The .zip File object obtained from a drop event.
 * @returns {Promise<void>}
 */
export async function extractAndLog(file) {
  const features = [];
  await extractZipSource(file, file.name, features);

  return {
    type: 'FeatureCollection',
    features,
  };
}
