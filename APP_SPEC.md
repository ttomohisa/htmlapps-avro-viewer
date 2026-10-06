# Avro Viewer — App Specification

Version: v1.0.1

## Purpose

Open Apache Avro Object Container Files locally and inspect their schema, metadata, block layout, and records without uploading files.

## v1.0.1 scope

- Open one or more `.avro` Object Container Files.
- Register supported files as separate tabs before parsing, so one broken file does not stop the remaining files from opening.
- Keep status, errors, overview, schema, metadata, blocks, and data scoped to each file tab; switching tabs must never show stale state from another file.
- Allow additional `.avro` drag and drop while files are already open.
- Parse the Avro header and embedded `avro.schema`.
- Show record count, root fields, block count, codec, file size, header size, and custom metadata.
- Show schema as a hierarchical tree or raw JSON. Recursive named references terminate in a labeled reference leaf; repeated noncyclic references still expand in each location.
- Populate Raw JSON independently of tree rendering, and copy the original embedded schema text without changing its bytes or formatting.
- Compound schema nodes use native keyboard-accessible disclosures, initially expanded, with Japanese/English Expand all and Collapse all controls. Primitive and recursive-reference leaves do not expand.
- Expansion state is transient and independent per open file, survives file/Tree/Raw/language switches, and resets when the file is reopened. Late toggle events must not change another file or replace newer state.
- Tree controls are disabled in Raw view and when no compound schema is available. Copy schema is disabled without a parsed header.
- Show block record counts, stored byte sizes, and offsets.
- Preview records with 50 / 100 / 250 / 500 / 1,000 rows per page.
- Decode only blocks needed for the current page and cache a small number of recent blocks.
- Table / Record views, visible-column selection, current-page sorting, and Cell Inspector.
- Sort declared `bytes` / `fixed` logical decimals by exact numeric value without converting them to floating point, including named references, type wrappers, and a single decimal branch with nullable unions. Keep nulls last in both directions and preserve source order for equal values. Decimal display and CSV spelling remain unchanged.
- Ordinary strings and unions with multiple non-null branches retain their existing comparison; union branch identity is not retained in decoded values. Sorting remains limited to the current page.
- Copy or save the current page as CSV.
- Built-in support for `null`, `deflate`, and `snappy` codecs. Attempt `zstandard` when the browser exposes it through `DecompressionStream`.
- Decode primitive, record, enum, fixed, array, map, union, and named-reference schemas.
- Render common logical types including date, timestamps, time-millis, and decimal.
- Japanese / English UI, responsive mobile bottom navigation, and multiple-file tabs.

## Non-goals for v1.0.1

- Editing or rewriting Avro files.
- Raw Avro binary without an Object Container File header.
- RPC payload inspection.
- SQL/query engine.
- Whole-file CSV export.

## Privacy

Runtime network access is blocked by CSP (`connect-src 'none'`). Selected files are read with browser file APIs and stay on the device.

## Header consistency

- Use EN in Japanese UI and JA in English UI, with localized target-language accessible names and titles.
- Preserve 完全ローカル処理 / Fully local processing and localized Help labels/titles.
- Header versions use vMAJOR.MINOR.PATCH; existing responsive visibility is unchanged.
