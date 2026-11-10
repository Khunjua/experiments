// The two charts of the write-up, as standalone SVG files built from the saved runs.
//
//   node lib/charts.mjs library <out dir>
//
// chart-1-programs.svg   distinct programs out of N runs, per input text and model
// chart-2-readings.svg   the short request: how the runs read each decision, one strip per decision and model
//
// Decision names, their grouping by how the raw text covers them, and the footnote come from the
// safe (projects/<name>/labels.json), because the names spell out the owner's rules.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir, safeDir } from './paths.mjs';

const [project = 'library', outDir = '.'] = process.argv.slice(2);
const EFFORT = 'medium';
const MODELS = [['claude-haiku-5-5', 'Haiku', '#2a78d6'], ['claude-sonnet-5-5', 'Sonnet', '#eb6834'], ['claude-opus-5-5', 'Opus', '#1baf7a']];
const INPUTS = [['raw', 'Short request', '78 words, the owner’s own'], ['ai-opus-5-5', 'Expanded by a model', 'about 2,000 words, no human'], ['truth', 'Owner’s full decisions', '417 words']];
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' };
const GRAYS = ['#898781', '#b4b2a9'];
const FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const SIGN = 'Entalpa Lab · October 2026';

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((k2) => [k2, x[k2]])) : x);
const load = (dir) => readdirSync(dir).filter((r) => r.startsWith('run-')).sort().map((r) => JSON.parse(readFileSync(join(dir, r, 'observations.json'), 'utf8')).scenarios);
const byId = (a, b) => a.id.localeCompare(b.id);
const reading = (o, d) => canon(o.filter((s) => s.decision === d).sort(byId).map((s) => s.obs));
const owner = (o, d) => canon(o.filter((s) => s.decision === d).sort(byId).map((s) => s.expected));
const program = (o) => canon(o.filter((s) => !s.indifferent).sort(byId).map((s) => s.obs));
const cell = (spec, model) => load(runsDir(project, spec, `${model}__${EFFORT}`));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, s, { size = 14, fill = INK.secondary, anchor = 'start', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const svgOpen = (w, h, title, desc) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">\n<title id="t">${esc(title)}</title>\n<desc id="d">${esc(desc)}</desc>\n<rect width="${w}" height="${h}" fill="${INK.surface}"/>\n`;

mkdirSync(outDir, { recursive: true });

// Chart 1: distinct programs per input text and model.
{
  const W = 1200, H = 640, top = 150, bottom = 120, left = 90, right = 40, plotH = H - top - bottom;
  const data = INPUTS.map(([spec]) => MODELS.map(([m]) => { const runs = cell(spec, m); return [new Set(runs.map(program)).size, runs.length]; }));
  const N = data[0][0][1];
  const desc = INPUTS.map(([, name], i) => `${name}: ${data[i].map(([v], k) => `${MODELS[k][1]} ${v}`).join(', ')}`).join('; ') + ` different programs out of ${N} runs.`;
  let s = svgOpen(W, H, `Different programs out of ${N} runs, by input text and model`, desc);
  s += text(left, 52, `Different programs out of ${N} runs`, { size: 26, fill: INK.primary, weight: 500 });
  s += text(left, 82, 'Same prompt, same interface, same models. Only the input text changes.', { size: 16 });
  MODELS.forEach(([, name, color], i) => { const x = left + i * 110; s += `<rect x="${x}" y="${104}" width="12" height="12" rx="2" fill="${color}"/>` + text(x + 18, 115, name, { size: 14 }); });
  for (const v of [0, 10, 20, 30]) { const y = top + plotH - plotH * v / 30; s += `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="${v ? INK.grid : INK.axis}" stroke-width="1"/>` + text(left - 12, y + 5, String(v), { size: 13, fill: INK.muted, anchor: 'end' }); }
  const gw = (W - left - right) / INPUTS.length, bw = 48, gap = 16;
  INPUTS.forEach(([, name, sub], gi) => {
    const cx = left + gw * gi + gw / 2, x0 = cx - (3 * bw + 2 * gap) / 2;
    data[gi].forEach(([v], mi) => {
      const h = Math.max(3, plotH * v / 30), x = x0 + mi * (bw + gap), y = top + plotH - h, color = MODELS[mi][2];
      s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${color}"/><rect x="${x}" y="${top + plotH - Math.min(h, 4)}" width="${bw}" height="${Math.min(h, 4)}" fill="${color}"/>`;
      s += text(x + bw / 2, y - 8, String(v), { size: 16, fill: INK.primary, anchor: 'middle' });
    });
    s += text(cx, H - bottom + 34, name, { size: 16, fill: INK.primary, anchor: 'middle', weight: 500 }) + text(cx, H - bottom + 56, sub, { size: 14, fill: INK.muted, anchor: 'middle' });
  });
  s += text(W - right, H - 24, SIGN, { size: 13, fill: INK.muted, anchor: 'end' });
  writeFileSync(join(outDir, 'chart-1-programs.svg'), s + '</svg>\n');
}

// Chart 2: the short request, one strip per decision and model.
{
  const labels = JSON.parse(readFileSync(join(safeDir(project), 'labels.json'), 'utf8'));
  const cells = MODELS.map(([m]) => cell('raw', m));
  const N = cells[0].length;
  const rowH = 30, headH = 40, top = 150, W = 1240, labelW = 440, colW = 240, colGap = 20, unit = colW / N, gapPx = 2;
  const rows = labels.groups.reduce((a, [, ds]) => a + ds.length, 0) + labels.groups.length;
  const H = top + rows * rowH + 110;
  const desc = `Each strip is ${N} programs from the short request, grouped by how they read one decision; the owner's reading is blue, other readings gray. Decisions are grouped by how the request covers them.`;
  let s = svgOpen(W, H, `The short request: how ${N} programs read each decision`, desc);
  s += text(40, 52, `The short request: how ${N} programs read each decision`, { size: 26, fill: INK.primary, weight: 500 });
  s += text(40, 82, `Each strip is ${N} programs, grouped by what they do. Blue: the owner’s reading. Gray: other readings, one segment each.`, { size: 16 });
  s += `<rect x="40" y="104" width="12" height="12" rx="2" fill="${MODELS[0][2]}"/>` + text(58, 115, 'read as the owner wanted', { size: 14 });
  s += `<rect x="260" y="104" width="12" height="12" rx="2" fill="${GRAYS[0]}"/><rect x="274" y="104" width="12" height="12" rx="2" fill="${GRAYS[1]}"/>` + text(292, 115, 'other readings', { size: 14 });
  MODELS.forEach(([, name], i) => { s += text(labelW + i * (colW + colGap) + colW / 2, top - 6, name, { size: 15, fill: INK.primary, anchor: 'middle', weight: 500 }); });
  let y = top;
  for (const [group, ds] of labels.groups) {
    y += rowH; s += text(40, y + 5, group, { size: 15, fill: INK.primary, weight: 500 });
    for (const d of ds) {
      y += rowH; s += text(56, y + 5, `${d} · ${labels.names[d]}`, { size: 14 });
      cells.forEach((runs, mi) => {
        const c = new Map(); for (const o of runs) c.set(reading(o, d), (c.get(reading(o, d)) ?? 0) + 1);
        const own = owner(runs[0], d);
        const segs = [[c.get(own) ?? 0, MODELS[0][2]], ...[...c.entries()].filter(([k]) => k !== own).map(([, n]) => n).sort((a, b) => b - a).map((n, k) => [n, GRAYS[k % 2]])];
        let x = labelW + mi * (colW + colGap);
        for (const [n, color] of segs) { if (!n) continue; const w = n * unit; s += `<rect x="${x}" y="${y - 9}" width="${Math.max(w - gapPx, 2)}" height="18" rx="2" fill="${color}"/>`; x += w; }
      });
    }
  }
  s += text(40, H - 52, labels.footnote, { size: 13, fill: INK.muted });
  s += text(W - 40, H - 24, SIGN, { size: 13, fill: INK.muted, anchor: 'end' });
  writeFileSync(join(outDir, 'chart-2-readings.svg'), s + '</svg>\n');
}
console.log(`wrote chart-1-programs.svg and chart-2-readings.svg to ${outDir}`);
