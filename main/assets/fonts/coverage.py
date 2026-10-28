# Writes coverage.json: the code points each embedded font family can draw,
# as [from, to] ranges, read from the fonts themselves (both weights must
# have the glyph). main/reports/pdf-text.js sends each run of text to the font
# that has it and prints "?" for what neither has. Run it after subset.py.
import json, os
from fontTools.ttLib import TTFont

here = os.path.dirname(os.path.abspath(__file__))

def cmap(name):
    return set(TTFont(os.path.join(here, name)).getBestCmap().keys())

def ranges(points):
    out, start, prev = [], None, None
    for p in sorted(points):
        if start is None: start = prev = p; continue
        if p == prev + 1: prev = p; continue
        out.append([start, prev]); start = prev = p
    if start is not None: out.append([start, prev])
    return out

latin = cmap('NotoSans-Regular.ttf') & cmap('NotoSans-Bold.ttf')
cjk = cmap('NotoSansSC-Regular.otf') & cmap('NotoSansSC-Bold.otf')
data = {'NotoSans': ranges(p for p in latin if p >= 0x20), 'NotoSansSC': ranges(p for p in cjk if p >= 0x20)}
with open(os.path.join(here, 'coverage.json'), 'w') as f:
    json.dump(data, f, separators=(',', ':'))
print({k: sum(b - a + 1 for a, b in v) for k, v in data.items()})
