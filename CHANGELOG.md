# Changelog

## v1.0.0 - 2026-09-04

- First stable release.
- Finalize the shared Data Viewer-series UI and per-file tab state handling.
- Verify multi-file loading, invalid-file isolation, paging, Cell Inspector, CSV export, Japanese/English UI, and mobile layout.
- Finalize the Browser Kitty `#16624F` labeled-file + magnifier SVG icon and favicon.
- Refresh release documentation and Japanese/English screenshots.

## v0.1.4
- redesign the Viewer icon as a labeled file with a magnifying glass
- use Browser Kitty primary color `#16624F` for the app icon and favicon
- keep the header icon and `assets/favicon.svg` visually consistent

## v0.1.3
- update the app icon and favicon to make the file type easier to recognize
- add a viewer-style magnifier motif while keeping the Browser Kitty look

## 0.1.2

- Allow files to be dropped anywhere in the app after a file is already open.
- Align long filename and close-button accessibility with the other Data Viewer apps.
- Align Japanese labels, counts, compression wording, and footer privacy wording across the Viewer series.

## 0.1.1

- Scoped read and inspection errors to each file tab
- Cleared stale schema and data when switching to a broken file
- Registered multi-file selections before inspection so one failure does not block the rest

## 0.1.0

- Initial Avro Object Container File viewer.
- Added schema tree/raw views, metadata, block layout, paginated preview, Cell Inspector, and CSV export.
- Added local null/deflate/snappy codec support.
