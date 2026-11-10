// Scores every decision of a project in every cell (input × model × effort).
// Usage: node lib/analyze.mjs library
//
// Per decision and cell:
//   agree  — all runs behave the same in that decision's scenarios
//   match  — share of runs that behave the way the owner wants
// Buckets for important decisions: right every time / wrong every time / varies.
// A run that produced no working code counts as its own behavior and as not matching.
// Calls that failed for outside reasons (rate limit, network) are left out.

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultsDir, runsDir as runsRoot, safeDir } from './paths.mjs';

const project = process.argv[2];
const runsDir = runsRoot(project);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const ls = async (p) => (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();

const truth = await readFile(join(safeDir(project), 'truth.md'), 'utf8');
const decisions = [...truth.matchAll(/^- (D\d+) .*? · (important|indifferent) · (stated|vague|no)/gm)]
  .map(([, id, kind, raw]) => ({ id, important: kind === 'important', raw }));

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
      runs.push({ meta, scenarios: obs.scenarios ?? null });
    }
    if (runs.length) cells.push({ spec, model, effort, runs });
  }
}

const short = (m) => m.replace('claude-', '').replace(/-\d.*$/, '');
for (const cell of cells) {
  cell.label = `${cell.spec} · ${short(cell.model)} · ${cell.effort}`;
  cell.broken = cell.runs.filter((r) => !r.scenarios).length;
  cell.cost = cell.runs.reduce((s, r) => s + (r.meta.costUSD ?? 0), 0) / cell.runs.length;
  cell.seconds = cell.runs.reduce((s, r) => s + (r.meta.durationMs ?? 0), 0) / cell.runs.length / 1000;
  cell.byDecision = {};
  for (const d of decisions) {
    const sigs = cell.runs.map((r) => {
      if (!r.scenarios) return { sig: 'BROKEN', match: false };
      const mine = r.scenarios.filter((s) => s.decision === d.id);
      return { sig: JSON.stringify(mine.map((s) => s.crash ? 'CRASH' : s.obs)), match: mine.every((s) => s.match) };
    });
    const distinct = new Set(sigs.map((s) => s.sig)).size;
    const matched = sigs.filter((s) => s.match).length;
    const n = sigs.length;
    const bucket = distinct > 1 ? 'varies' : matched === n ? 'right' : 'wrong';
    cell.byDecision[d.id] = { distinct, matched, n, bucket };
  }
  const imp = decisions.filter((d) => d.important).map((d) => cell.byDecision[d.id]);
  cell.right = imp.filter((x) => x.bucket === 'right').length;
  cell.wrong = imp.filter((x) => x.bucket === 'wrong').length;
  cell.varies = imp.filter((x) => x.bucket === 'varies').length;
  cell.match = imp.reduce((s, x) => s + x.matched / x.n, 0) / imp.length;
}

// Table 1: one line per cell.
const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
console.log(`\n${project}: ${decisions.filter((d) => d.important).length} important decisions\n`);
console.log('cell'.padEnd(30), 'runs', 'right', 'wrong', 'varies', 'match', ' broken', '  $/run', '  s/run');
for (const c of cells) {
  console.log(c.label.padEnd(30), String(c.runs.length).padStart(4), String(c.right).padStart(5),
    String(c.wrong).padStart(5), String(c.varies).padStart(6), pct(c.match).padStart(6),
    String(c.broken).padStart(7), c.cost.toFixed(3).padStart(7), c.seconds.toFixed(0).padStart(7));
}

// Table 2: one line per decision. ✓ right every time, ✗ wrong every time, ~k/n varies (k matched).
console.log('\n' + 'decision'.padEnd(16) + cells.map((c, i) => `c${i + 1}`.padStart(6)).join(''));
for (const d of decisions) {
  const row = cells.map((c) => {
    const x = c.byDecision[d.id];
    return (x.bucket === 'right' ? '✓' : x.bucket === 'wrong' ? '✗' : `~${x.matched}/${x.n}`).padStart(6);
  });
  console.log(`${d.id} ${d.important ? '' : '(any) '}[${d.raw}]`.padEnd(16) + row.join(''));
}
console.log('\n' + cells.map((c, i) => `c${i + 1} = ${c.label}`).join('\n'));

// CSV for charts.
await mkdir(resultsDir(), { recursive: true });
const head = 'spec,model,effort,runs,right,wrong,varies,match,broken,cost_usd,seconds';
const lines = cells.map((c) => [c.spec, c.model, c.effort, c.runs.length, c.right, c.wrong, c.varies,
  c.match.toFixed(3), c.broken, c.cost.toFixed(4), c.seconds.toFixed(1)].join(','));
await writeFile(join(resultsDir(),`${project}-cells.csv`), [head, ...lines].join('\n') + '\n');
const dHead = 'spec,model,effort,decision,important,raw,distinct,matched,n,bucket';
const dLines = cells.flatMap((c) => decisions.map((d) => {
  const x = c.byDecision[d.id];
  return [c.spec, c.model, c.effort, d.id, d.important, d.raw, x.distinct, x.matched, x.n, x.bucket].join(',');
}));
await writeFile(join(resultsDir(),`${project}-decisions.csv`), [dHead, ...dLines].join('\n') + '\n');
