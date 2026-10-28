# Cuts Noto Sans SC down to the characters receipts actually use, and writes
# NotoSansSC-Regular.otf and NotoSansSC-Bold.otf next to this file:
#   GB2312 (6,763 everyday simplified hanzi and its symbols),
#   Big5 level 1 (5,401 frequent traditional hanzi),
#   CJK punctuation, Japanese kana, full-width forms, and Basic Latin and
#   Latin-1, so a mixed string ("Ya Kun 亚坤") can print in one font.
# The whole font is 8 MB a weight; this is about 2.3 MB.
#
#   python subset.py <folder with the full NotoSansSC-Regular.otf and -Bold.otf>
#   python coverage.py
#
# The full fonts: https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC
import sys, os
from fontTools import subset

here = os.path.dirname(os.path.abspath(__file__))
src_dir = sys.argv[1] if len(sys.argv) > 1 else here
chars = set()

for b1 in range(0xA1, 0xF8):            # GB2312 rows
    for b2 in range(0xA1, 0xFF):
        try: chars.update(bytes([b1, b2]).decode('gb2312'))
        except UnicodeDecodeError: pass
for b1 in range(0xA4, 0xC7):            # Big5 level 1: A440..C67E
    for b2 in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        if (b1, b2) > (0xC6, 0x7E): break
        try: chars.update(bytes([b1, b2]).decode('big5'))
        except UnicodeDecodeError: pass
ranges = [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x20A0, 0x20BF),
          (0x3000, 0x303F), (0x3040, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF)]
for a, b in ranges: chars.update(chr(c) for c in range(a, b + 1))

hanzi = sum(1 for c in chars if 0x4E00 <= ord(c) <= 0x9FFF)
print(f'{len(chars)} characters, {hanzi} hanzi')
unicodes = sorted(ord(c) for c in chars)

for weight in ('Regular', 'Bold'):
    src = os.path.join(src_dir, f'NotoSansSC-{weight}.otf')
    out = os.path.join(here, f'NotoSansSC-{weight}.otf')
    if os.path.abspath(src) == os.path.abspath(out): sys.exit('Give the folder holding the full fonts, not this one.')
    opts = subset.Options()
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.hinting = False
    font = subset.load_font(src, opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    subset.save_font(font, out, opts)
    print(weight, os.path.getsize(out) // 1024, 'KB')
