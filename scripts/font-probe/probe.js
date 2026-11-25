(async function probe(spec) {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const measure = (family, weight) => {
    const s = document.createElement('span');
    s.style.cssText = `font-family:${family}, monospace;font-weight:${weight};font-size:40px;font-synthesis:none;white-space:nowrap;position:absolute`;
    s.textContent = spec.text;
    box.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w * 100) / 100;
  };
  const res = { base: { w400: measure('monospace', 400), w700: measure('monospace', 700) }, faces: [], families: [] };
  let i = 0;
  for (const f of spec.faces) {
    const fam = `p${i++}_${Math.random().toString(36).slice(2, 8)}`;
    const r = { font: f.font, src: f.src };
    try {
      const ff = new FontFace(fam, f.src, { weight: '100 900' });
      await ff.load();
      document.fonts.add(ff);
      r.load = 'ok';
      r.w400 = measure(`"${fam}"`, 400);
      r.w700 = measure(`"${fam}"`, 700);
    } catch (e) { r.load = String((e && e.name) || e); }
    res.faces.push(r);
  }
  for (const fam of spec.families) res.families.push({ fam, w400: measure(`"${fam}"`, 400), w700: measure(`"${fam}"`, 700) });
  box.remove();
  return res;
})
