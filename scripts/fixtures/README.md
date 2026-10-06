# Avro decimal sorting regression fixture

`avro-known-205.avro` is the exact synthetic Avro Object Container File used to reproduce the decimal lexical-order defect in browser QA on 2026-10-06. It contains 205 invented records in three uncompressed blocks, with a `bytes` logical decimal (`precision: 9`, `scale: 2`). No personal data is included.

SHA-256: `908e02d8b8f8f56174929b19846d773418e88451d3b65360a59a9b9a9abdee72`

Record 1 has amount `-1.25`; records 2–205 have amount `record number × 1.25`. The first 100 records must therefore sort numerically from `-1.25`, `2.50`, `3.75` through `125.00`. The failing lexical sort placed `10.00`, `100.00`, etc. immediately after `-1.25`. The regression uses the real header/block/datum reader and checks all three pages in both directions. Smaller boundary files are encoded directly in `test-avro-values.cjs`.
