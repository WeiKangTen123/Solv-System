# Fonts embedded in the case PDF

| File | What | Source |
|---|---|---|
| `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf` | Latin, Greek, Cyrillic, Vietnamese | [notofonts/notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSans/hinted/ttf), unchanged |
| `NotoSansSC-Regular.otf`, `NotoSansSC-Bold.otf` | Chinese (simplified and common traditional), Japanese kana | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC), cut down by `subset.py` |
| `coverage.json` | the characters each family draws, written by `coverage.py` | |

Both are under the SIL Open Font License 1.1 (`OFL-NotoSans.txt`, `OFL-NotoSansSC.txt`), which allows embedding them in documents and shipping them with the app.

The PDF used to print in Helvetica, a font every PDF reader has, so nothing was embedded. It covered Latin-1 only, and a merchant named in Chinese printed as "???". pdfmake embeds only the glyphs a document uses, so a report stays about the size it was.

To rebuild the Chinese fonts, download the full `NotoSansSC-Regular.otf` and `NotoSansSC-Bold.otf` (8 MB each) into another folder, then run `python subset.py <that folder>` and `python coverage.py` (both need `pip install fonttools`).
