// The tables behind the write-up, recomputed from the saved runs. No model calls.
//
//   node lib/tables.mjs library cells        match, varying decisions and distinct programs per cell
//   node lib/tables.mjs library rules        every important decision x the raw cells: readings and the
//                                            owner's share, next to how the raw text covers the decision
//   node lib/tables.mjs library menu         contested decisions in raw: readings, owner's share and rank
//   node lib/tables.mjs library ai           the ai spec against the owner, and against the raw readings
//   node lib/tables.mjs library expansions   the ai-*-NN expansions against each other and the owner
//   node lib/tables.mjs library halves       runs made outside the rooms against runs made inside, per cell
//   node lib/tables.mjs library where raw claude-haiku-5-5 run-08     one run next to the rest of its cell
//
// A "reading" of a decision is what a program does on that decision's scenarios; runs with the
// same observations share a reading. A "program" is the reading of every important decision at once.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir, safeDir } from './paths.mjs';

const [project = 'library', table = 'cells', ...rest] = process.argv.slice(2);
const EFFORT = 'medium';
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const short = (m) => m.replace('claude-', '').replace('-5-5', '');

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((k2) => [k2, x[k2]])) : x);
const cellDir = (spec, model) => runsDir(project, spec, `${model}__${EFFORT}`);
const load = (dir) => readdirSync(dir).filter((r) => r.startsWith('run-')).sort().map((r) => ({
  r, o: JSON.parse(readFileSync(join(dir, r, 'observations.json'), 'utf8')).scenarios,
  meta: JSON.parse(readFileSync(join(dir, r, 'meta.json'), 'utf8')),
}));
const byId = (a, b) => a.id.localeCompare(b.id);
const reading = (run, d) => canon(run.o.filter((s) => s.decision === d).sort(byId).map((s) => s.obs));
const owner = (run, d) => canon(run.o.filter((s) => s.decision === d).sort(byId).map((s) => s.expected));
const program = (run) => canon(run.o.filter((s) => !s.indifferent).sort(byId).map((s) => s.obs));
const decisions = (runs) => [...new Set(runs[0].o.map((s) => s.decision))].filter((d) => !runs[0].o.find((s) => s.decision === d).indifferent);
const counts = (runs, d) => { const c = new Map(); for (const x of runs) c.set(reading(x, d), (c.get(reading(x, d)) ?? 0) + 1); return c; };
const matchPct = (runs) => { let hit = 0, tot = 0; for (const x of runs) for (const s of x.o) if (!s.indifferent) { tot += 1; hit += s.match ? 1 : 0; } return `${(hit / tot * 100).toFixed(0)}%`; };
const varying = (runs) => decisions(runs).filter((d) => counts(runs, d).size > 1);
const programs = (runs) => new Set(runs.map(program)).size;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

// How the raw text covers each decision, from the safe's truth.md: "- D2 ... · important · no (common sense)"
function coverage() {
  const out = {};
  for (const line of readFileSync(join(safeDir(project), 'truth.md'), 'utf8').split('\n')) {
    const m = line.match(/^- (D\d+) .* · (?:important|indifferent) · (stated|vague|no)(.*)$/);
    if (m) out[m[1]] = m[2] + (m[3].includes('common sense') ? '*' : '');
  }
  return out;
}

const specs = () => readdirSync(runsDir(project)).filter((s) => !s.startsWith('_') && existsSync(cellDir(s, MODELS[0])));

if (table === 'cells') {
  console.log(`${pad('spec', 16)} ${pad('model', 8)} runs  match  varying  programs`);
  for (const spec of specs()) for (const m of MODELS) {
    if (!existsSync(cellDir(spec, m))) continue;
    const runs = load(cellDir(spec, m));
    console.log(`${pad(spec, 16)} ${pad(short(m), 8)} ${rpad(runs.length, 4)}  ${rpad(matchPct(runs), 5)}  ${rpad(varying(runs).length, 2)}/${decisions(runs).length}    ${rpad(programs(runs), 2)}/${runs.length}`);
  }
}

if (table === 'rules') {
  const cov = coverage();
  const cells = Object.fromEntries(MODELS.map((m) => [m, load(cellDir('raw', m))]));
  console.log(`${pad('decision', 9)} ${pad('in raw', 8)} ${MODELS.map((m) => pad(short(m), 12)).join('')} (readings · owner share)`);
  const tally = {};
  for (const d of decisions(cells[MODELS[0]])) {
    const cols = MODELS.map((m) => {
      const c = counts(cells[m], d), share = c.get(owner(cells[m][0], d)) ?? 0;
      const t = (tally[cov[d]] ??= { cells: 0, vary: 0, owner: 0 });
      t.cells += 1; t.vary += c.size > 1 ? 1 : 0; t.owner += share;
      return pad(`${c.size} · ${rpad(share, 2)}/${cells[m].length}`, 12);
    });
    console.log(`${pad(d, 9)} ${pad(cov[d], 8)} ${cols.join('')}`);
  }
  console.log('\nby coverage: decision-cells · varying · owner share on average   (* = common sense)');
  for (const [k, t] of Object.entries(tally)) console.log(`${pad(k, 8)} ${rpad(t.cells, 2)} · ${rpad(t.vary, 2)} · ${(t.owner / t.cells / cells[MODELS[0]].length * 100).toFixed(0)}%`);
}

if (table === 'menu') {
  const cells = Object.fromEntries(MODELS.map((m) => [m, load(cellDir('raw', m))]));
  console.log(`${pad('decision', 9)} ${MODELS.map((m) => pad(short(m), 22)).join('')} (readings · owner share (rank) · top share)`);
  let cellsVarying = 0, ownerMajority = 0, ownerAbsent = 0;
  for (const d of decisions(cells[MODELS[0]])) {
    const cols = []; let any = false;
    for (const m of MODELS) {
      const c = counts(cells[m], d), sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
      const rank = sorted.findIndex(([s]) => s === owner(cells[m][0], d)) + 1, share = c.get(owner(cells[m][0], d)) ?? 0;
      if (c.size > 1) { any = true; cellsVarying += 1; if (rank === 1 && sorted[0][1] > (sorted[1]?.[1] ?? 0)) ownerMajority += 1; if (!rank) ownerAbsent += 1; }
      cols.push(pad(`${c.size} · ${rpad(share, 2)} (${rank ? '#' + rank : '—'}) · ${rpad(sorted[0][1], 2)}`, 22));
    }
    if (any) console.log(`${pad(d, 9)} ${cols.join('')}`);
  }
  console.log(`\nvarying decision-cells: ${cellsVarying}; owner's reading is the strict majority in ${ownerMajority}; owner's reading never appears in ${ownerAbsent}`);
}

if (table === 'ai') {
  const spec = rest[0] ?? specs().find((s) => s.startsWith('ai-')) ;
  const ai = load(cellDir(spec, MODELS[0]))[0];
  const raw = Object.fromEntries(MODELS.map((m) => [m, load(cellDir('raw', m))]));
  console.log(`${spec}: the reading of its program, and how many raw runs read the decision the same way`);
  console.log(`${pad('decision', 9)} owner?  ${MODELS.map((m) => rpad(short(m), 7)).join('')}   rank among ${short(MODELS[2])} readings`);
  for (const d of decisions([ai])) {
    const a = reading(ai, d);
    const same = MODELS.map((m) => rpad(raw[m].filter((x) => reading(x, d) === a).length, 7));
    const sorted = [...counts(raw[MODELS[2]], d).entries()].sort((x, y) => y[1] - x[1]);
    const rank = sorted.findIndex(([s]) => s === a) + 1;
    console.log(`${pad(d, 9)} ${pad(a === owner(ai, d) ? 'yes' : 'NO', 7)} ${same.join('')}   ${rank ? '#' + rank : 'never'}`);
  }
}

if (table === 'expansions') {
  const tags = specs().filter((s) => /^ai-.*-\d\d$/.test(s));
  const ex = Object.fromEntries(tags.map((t) => [t, load(cellDir(t, MODELS[0]))]));
  const ds = decisions(ex[tags[0]]);
  const major = (runs, d) => { const s = [...counts(runs, d).entries()].sort((a, b) => b[1] - a[1]); return { reading: s[0][0], groups: s.length }; };
  console.log(`${tags.length} expansions, ${Object.values(ex).reduce((a, r) => a + r.length, 0)} compiles by ${short(MODELS[0])}\n`);
  console.log(`${pad('decision', 9)} readings across expansions  expansions right  compiles disagree inside N expansions`);
  const perExp = Object.fromEntries(tags.map((t) => [t, { right: 0, inside: 0 }]));
  for (const d of ds) {
    const readings = new Set(); let right = 0, inside = 0;
    for (const t of tags) { const m = major(ex[t], d); readings.add(m.reading); if (m.groups > 1) { inside += 1; perExp[t].inside += 1; } if (m.reading === owner(ex[t][0], d)) { right += 1; perExp[t].right += 1; } }
    console.log(`${pad(d, 9)} ${rpad(readings.size, 8)}                    ${rpad(right, 3)}/${tags.length}            ${inside || ''}`);
  }
  console.log('\nper expansion: decisions right · decisions where its own compiles disagreed');
  for (const t of tags) console.log(`${t}: ${perExp[t].right}/${ds.length} · ${perExp[t].inside}`);
  console.log(`\nexpansions right on every decision: ${tags.filter((t) => perExp[t].right === ds.length).length}`);
  console.log(`distinct programs across the expansions (majority behavior of each): ${new Set(tags.map((t) => canon(ds.map((d) => major(ex[t], d).reading)))).size}`);
}

if (table === 'halves') {
  console.log(`${pad('cell', 22)} match out/in   varying out/in   readings only in / only out   programs out/in/all`);
  for (const spec of specs()) for (const m of MODELS) {
    if (!existsSync(cellDir(spec, m))) continue;
    const runs = load(cellDir(spec, m)), out = runs.filter((x) => !x.meta.room), inn = runs.filter((x) => x.meta.room);
    if (!out.length || !inn.length) continue;
    let onlyIn = 0, onlyOut = 0;
    for (const d of decisions(runs)) {
      const so = new Set(out.map((x) => reading(x, d))), si = new Set(inn.map((x) => reading(x, d)));
      onlyIn += [...si].filter((s) => !so.has(s)).length; onlyOut += [...so].filter((s) => !si.has(s)).length;
    }
    console.log(`${pad(`${spec}/${short(m)}`, 22)} ${rpad(matchPct(out), 4)} ${rpad(matchPct(inn), 4)}       ${rpad(varying(out).length, 2)} ${rpad(varying(inn).length, 2)}             ${rpad(onlyIn, 2)} / ${rpad(onlyOut, 2)}                 ${programs(out)}/${programs(inn)}/${programs(runs)}`);
  }
}

if (table === 'where') {
  const [spec, model, probe] = rest;
  const runs = load(cellDir(spec, model)), me = runs.find((x) => x.r === probe), others = runs.filter((x) => x.r !== probe);
  console.log(`${pad('decision', 9)} probe   owner?  same as`);
  for (const d of decisions(runs)) {
    const twins = others.filter((x) => reading(x, d) === reading(me, d)).map((x) => x.r.slice(-2));
    const indifferent = me.o.find((s) => s.decision === d)?.indifferent;
    console.log(`${pad(d, 9)} ${pad(twins.length ? 'seen' : 'NEW', 7)} ${pad(indifferent ? '—' : (me.o.filter((s) => s.decision === d).every((s) => s.match) ? 'yes' : 'no'), 7)} ${twins.join(' ') || '(nobody)'}`);
  }
  const twins = others.filter((x) => program(x) === program(me)).map((x) => x.r.slice(-2));
  console.log(`\nwhole program: ${twins.length ? 'same as ' + twins.join(' ') : 'new, like no other run in the cell'}`);
}
