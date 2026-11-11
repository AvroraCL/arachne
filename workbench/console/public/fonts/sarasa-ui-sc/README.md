# Sarasa UI SC

Pinned upstream release: **1.0.43**. Regular (400) and SemiBold (600) are shipped locally as full-character WOFF2 fonts. The UI family uses Inter for Latin text and Source Han Sans for CJK text.

The official package has no 500/Medium face. UI emphasis uses the real 600 face; synthetic font weights are disabled. Original glyphs, hinting and names are retained. Source archive and shipped file checksums are recorded in `source.json`.

Conversion: open the upstream TTF with fontTools 4.57.0, set `font.flavor = 'woff2'`, then save with Brotli 1.2.1 installed. No character subsetting is applied, so user-supplied project and layer names retain the full upstream SC coverage.

Copyright notices and SIL OFL 1.1 are included in `OFL.txt`. Keep them with redistributed fonts. These files style the application UI; artwork text generation continues to use the project text pipeline and its original fonts.
