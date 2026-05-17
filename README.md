# FFXI Macro Editor

Browser-based editor for Final Fantasy XI macro backup files.

## Development

- `npm start` runs the local static server at `http://127.0.0.1:4173`.
- `npm test` runs the formatter and parser regression tests.

## Data Sources

The auto-translate rendering support vendors a generated phrase map in `src/lib/ffxiAutoTranslateData.js`.
That data is derived from `mapping.lua` in the public `ThornyFFXI/AutoTrans` repository:

- https://github.com/ThornyFFXI/AutoTrans
- https://github.com/ThornyFFXI/AutoTrans/blob/main/addons/autotrans/mapping.lua

This project currently uses that mapping for client-side rendering of imported auto-translate tokens and for re-encoding recognized phrases during export. Untouched imported lines still preserve their original raw bytes on export.
