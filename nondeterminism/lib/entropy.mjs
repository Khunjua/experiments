// Entropy of behavior per decision and per cell, from the saved runs. No model calls.
// Usage: node lib/entropy.mjs library
//
// The runs of a cell are grouped by what they did in a decision's scenarios (the same
// grouping lib/analyze.mjs uses for "distinct"). Entropy over the group sizes, divided by
// ln(runs): 0 means every run behaved the same, 1 means every run behaved differently.
// The layout lists the group sizes, largest first, with ✓ on the group that behaves the way
// the owner wants. The last row is the whole program: runs grouped by their behavior in
// every important scenario at once, the way functional entropy (Bouchard et al. 2026)
// groups whole answers. A run with no working code is a group of its own.

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultsDir, runsDir as runsRoot, safeDir } from './paths.mjs';

const project = process.argv[2] ?? 'library';
const runsDir = runsRoot(project);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const ls = async (p) => (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();

// Stable JSON, as in the checker: sorted keys, so equal behavior always prints the same.
const canon = (v) => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k] === undefined ? null : x[k]]))
    : x);

const truth = await readFile(join(safeDir(project), 'truth.md'), 'utf8');
const decisions = [...truth.matchAll(/^- (D\d+) .*? · (important|indifferent) · (stated|vague|no)/gm)]
  .map(([, id, kind, raw]) => ({ id, important: kind === 'important', raw }));
const important = decisions.filter((d) => d.important);

const specOrder = ['raw', 'truth'];
const specs = (await ls(runsDir)).sort((a, b) => (specOrder.indexOf(a) + 1 || 1.5) - (specOrder.indexOf(b) + 1 || 1.5));

const cells = [];
for (const spec of specs) {
  for (const cellName of await ls(join(runsDir, spec))) {
    const [model, effort] = cellName.split('__');
    const runs = [];
    for (const r of await ls(join(runsDir, spec, cellName))) {
      const dir = join(runsDir, spec, cellName, r);
      let meta;
      try {
        meta = await readJson(join(dir, 'meta.json'));
      } catch {
        continue;
      }
      if (!meta.ok) continue;
      const obs = meta.hasCode ? await readJson(join(dir, 'observations.json')) : {};
      runs.push({ scenarios: obs.scenarios ?? null });
    }
    if (runs.length) cells.push({ spec, model, effort, runs });
  }
}

// Groups the runs by behavior in the given scenarios; returns sizes, entropy and the layout.
function group(runs, pick) {
  const sizes = new Map();
  let ownerSig = null;
  for (const r of runs) {
    let sig = 'BROKEN';
    if (r.scenarios) {
      const mine = r.scenarios.filter(pick);
      sig = canon(mine.map((s) => (s.crash ? 'CRASH' : s.obs)));
      if (mine.every((s) => s.match)) ownerSig = sig;
    }
    sizes.set(sig, (sizes.get(sig) ?? 0) + 1);
  }
  const n = runs.length;
  const entropy = [...sizes.values()].reduce((h, c) => h - (c / n) * Math.log(c / n), 0);
  const norm = n > 1 ? entropy / Math.log(n) : 0;
  const matched = sizes.get(ownerSig) ?? 0;
  const layout = [...sizes.entries()].sort((a, b) => b[1] - a[1])
    .map(([sig, c]) => `${c}${sig === ownerSig ? '✓' : ''}`).join('+');
  return { n, groups: sizes.size, entropy, norm, matched, layout };
}

const short = (m) => m.replace('claude-', '').replace(/-\d.*$/, '');
for (const cell of cells) {
  cell.label = `${cell.spec} · ${short(cell.model)} · ${cell.effort}`;
  cell.byDecision = {};
  for (const d of decisions) cell.byDecision[d.id] = group(cell.runs, (s) => s.decision === d.id);
  const importantIds = new Set(important.map((d) => d.id));
  cell.whole = group(cell.runs, (s) => importantIds.has(s.decision));
  const imp = important.map((d) => cell.byDecision[d.id]);
  cell.mean = imp.reduce((s, x) => s + x.norm, 0) / imp.length;
  cell.sameRight = imp.filter((x) => x.groups === 1 && x.matched === x.n).length;
  cell.sameWrong = imp.filter((x) => x.groups === 1 && x.matched === 0).length;
  cell.varies = imp.filter((x) => x.groups > 1).length;
}

// Table 1: entropy per decision and cell. · = all runs the same and right, ✗ = all the same
// and wrong. A decision the owner does not care about gets · whenever all runs are the same.
const mark = (x, important = true) =>
  x.groups === 1 ? (x.matched === x.n || !important ? '·' : '✗') : x.norm.toFixed(2);
console.log(`\n${project}: entropy per decision, 0 = all ${cells[0]?.runs.length ?? ''} runs the same, 1 = all different\n`);
console.log('decision'.padEnd(16) + cells.map((c, i) => `c${i + 1}`.padStart(6)).join(''));
for (const d of decisions) {
  console.log(`${d.id} ${d.important ? '' : '(any) '}[${d.raw}]`.padEnd(16) + cells.map((c) => mark(c.byDecision[d.id], d.important).padStart(6)).join(''));
}
console.log('whole program'.padEnd(16) + cells.map((c) => mark(c.whole).padStart(6)).join(''));

// Table 2: layouts where any cell varies. Sizes largest first, ✓ on the owner's group.
console.log('\nlayouts (group sizes, ✓ = behaves as the owner wants)\n');
console.log('decision'.padEnd(16) + cells.map((c, i) => `c${i + 1}`.padStart(9)).join(' '));
for (const d of decisions) {
  if (!cells.some((c) => c.byDecision[d.id].groups > 1)) continue;
  console.log(`${d.id}`.padEnd(16) + cells.map((c) => c.byDecision[d.id].layout.padStart(9)).join(' '));
}
console.log('whole program'.padEnd(16) + cells.map((c) => c.whole.layout.padStart(9)).join(' '));

// Table 3: one line per cell.
console.log('\n' + 'cell'.padEnd(30), 'runs', 'mean H', 'same+right', 'same+wrong', 'varies', 'programs', 'whole H');
for (const c of cells) {
  console.log(c.label.padEnd(30), String(c.runs.length).padStart(4), c.mean.toFixed(2).padStart(6),
    String(c.sameRight).padStart(10), String(c.sameWrong).padStart(10), String(c.varies).padStart(6),
    String(c.whole.groups).padStart(8), c.whole.norm.toFixed(2).padStart(7));
}
console.log('\n' + cells.map((c, i) => `c${i + 1} = ${c.label}`).join('\n'));

// CSV for charts; "ALL" is the whole-program row.
await mkdir(resultsDir(), { recursive: true });
const head = 'spec,model,effort,decision,important,raw,runs,groups,entropy_nats,entropy_norm,matched,layout';
const row = (c, id, important, raw, x) =>
  [c.spec, c.model, c.effort, id, important, raw, x.n, x.groups, x.entropy.toFixed(4), x.norm.toFixed(4), x.matched, `"${x.layout}"`].join(',');
const lines = cells.flatMap((c) => [
  ...decisions.map((d) => row(c, d.id, d.important, d.raw, c.byDecision[d.id])),
  row(c, 'ALL', true, '', c.whole),
]);
await writeFile(join(resultsDir(), `${project}-entropy.csv`), [head, ...lines].join('\n') + '\n');
