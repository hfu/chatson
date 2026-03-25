# chatson
A fully client-side, static web application that parses a WhatsApp Chat Export `.zip` file and displays extracted geographic features as GeoJSON.

Chatson is a local-first prototype inspired by ChatMap by the Humanitarian OpenStreetMap Team, created with generative AI to explore a lighter-weight workflow for a similar use case.

## Implementation Notes
- The app runs fully in-browser and keeps processing local to the user environment.
- ZIP extraction is recursive, so nested `.zip` attachments are expanded automatically.
- Chat parsing supports multiple WhatsApp export formats (iOS bracket format and Android dash format) and falls back to direct map-link extraction when needed.
- Duplicate omission is optional and currently uses one practical strategy: exact URL match or nearby coordinate match within a fixed radius.
- A privacy-first switch controls whether potentially sensitive properties are included in rendered and exported GeoJSON.
- `text` is always present as either an actual string or `null`.
- Point popup shows GeoJSON standard structure (`type`, `geometry`, `properties`) and supports inline `text` editing inside JSON quotes; updates are saved on blur.
- Overture Places can be displayed as a separate, high-zoom overlay layer.
- A compact share URL can be generated from current rendered GeoJSON and restored on page load.
- Share payload coordinates are reduced to 5 decimal places with `@turf/truncate` before gzip compression.

## Sensitive Data Policy
- Default behavior is privacy-first: the following properties are omitted by default from rendered/exported GeoJSON: `entry`, `line`, `mapsUrl`, `timestamp`, `user`.
- Users can explicitly opt in via the `keep potentially sensitive fields` checkbox.
- Internal/derived properties are excluded from exported GeoJSON (`sequence`, `chatsonId`, `layout`, `source`, `state`).
- Exported GeoJSON is emitted in compact JSON form.

## Lessons Learned
- Stable feature identity is essential for in-place editing. Matching by coordinates or timestamps is fragile; explicit IDs are more reliable.
- Large ad-hoc text replacement scripts can introduce subtle breakage. Structured refactoring in clear function boundaries is safer and easier to review.
- Privacy handling should be centralized so popup display, map rendering, and download output remain consistent.
- For future POI integration (for example Overture Places at high zoom), phased rollout is safer: first stabilize core editing flows, then add POI as a zoom-gated overlay with conservative defaults.

## Change Log
- Added recursive ZIP extraction for nested WhatsApp attachments.
- Added GeoJSON extraction from `https://maps.google.com/?q={lat},{lng}` links.
- Added map rendering, duplicate omission controls, and GeoJSON download.
- Added popup JSON view and editable `text` with save-to-export behavior.
- Added robust iOS/Android chat line parsing and fallback extraction to prevent missed location points.
- Added privacy toggle for potentially sensitive fields with default-off behavior.
- Added high-zoom Overture Places overlay as a separate label layer.
- Added share URL copy/restore flow for compact GeoJSON payloads.
- Refactored `src/main.js` into clearer data/state/rendering sections to improve maintainability.
