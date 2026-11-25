# 读字体 name 表和可变字体的命名实例，给试验列出 local() 候选名字
import json, sys
from fontTools.ttLib import TTFont
out = {}
for key, path in zip(sys.argv[2::2], sys.argv[3::2]):
    f = TTFont(path)
    n = f['name']
    def g(i):
        r = n.getName(i, 3, 1, 0x409)
        return r.toUnicode() if r else None
    d = {k: g(i) for k, i in [('family', 1), ('sub', 2), ('full', 4), ('ps', 6), ('typo', 16), ('typoSub', 17), ('psPrefix', 25)]}
    d['weightClass'] = f['OS/2'].usWeightClass
    d['axes'] = [[a.axisTag, a.minValue, a.defaultValue, a.maxValue] for a in f['fvar'].axes] if 'fvar' in f else []
    inst = []
    if 'fvar' in f:
        for i in f['fvar'].instances:
            sub = n.getDebugName(i.subfamilyNameID)
            ps = n.getDebugName(i.postscriptNameID) if i.postscriptNameID not in (0xFFFF, None) else None
            inst.append({'sub': sub, 'ps': ps, 'wght': i.coordinates.get('wght')})
    d['instances'] = inst
    out[key] = d
json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
