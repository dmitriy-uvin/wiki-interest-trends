# Bundled fonts

`NotoSans-Regular.ttf`, `NotoSans-Bold.ttf` — Noto Sans, from
https://github.com/googlefonts/noto-fonts (hinted/ttf/NotoSans).
Licensed under the SIL Open Font License 1.1.

The PDF's standard-14 fonts (Helvetica and friends) are WinAnsi-encoded and
cannot render Cyrillic at all, so a font has to be embedded for Ukrainian,
Russian, Serbian and Bulgarian article titles. Noto Sans covers Latin, Greek and
Cyrillic.

It does NOT cover CJK, Arabic, Hebrew, Devanagari or Thai. Rather than rendering
those titles as empty boxes, the PDF replaces them with
`— <lang> script not in PDF font`. The check is `canRender()` in
`scripts/lib/report.mjs`, which tests every character against the embedded face
via fontkit's `hasGlyphForCodePoint`.
