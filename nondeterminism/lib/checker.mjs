// Runs every scenario of a project against one implementation and prints what it saw.
// Usage: node --permission --allow-fs-read=<stand> lib/checker.mjs <impl.mjs> <scenarios.mjs>
// Prints JSON: { loadError, scenarios: [{ id, decision, indifferent, obs, expected, match, crash }] }

import { pathToFileURL } from 'node:url';

const [implPath, scenariosPath] = process.argv.slice(2);

// Stable JSON: sorted keys, undefined as null, so equal behavior always prints the same.
const canon = (v) => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k] === undefined ? null : x[k]]))
    : x);

const { factory, shapes = {}, setup, default: scenarios } = await import(pathToFileURL(scenariosPath).href);

let mod;
try {
  mod = await import(pathToFileURL(implPath).href);
} catch (e) {
  console.log(JSON.stringify({ loadError: String(e?.message ?? e) }));
  process.exit(0);
}
if (typeof mod[factory] !== 'function') {
  console.log(JSON.stringify({ loadError: `no exported ${factory}()` }));
  process.exit(0);
}

// Keep only the fields we observe; list items keep only the interface fields.
function observe(result, expected) {
  if (result === null || typeof result !== 'object') return { __result: String(result) };
  if (result.__throw || result.__missing) return result;
  const pick = (field, value) => {
    if (value === undefined) return null;
    if (shapes[field] && Array.isArray(value)) {
      return value.map((item) => Object.fromEntries(shapes[field].map((k) => [k, item?.[k] ?? null])));
    }
    return value;
  };
  return Object.fromEntries(Object.keys(expected).map((k) => [k, pick(k, result[k])]));
}

async function call(sys, method, args) {
  if (typeof sys[method] !== 'function') return { __missing: method };
  try {
    return await sys[method](structuredClone(args));
  } catch {
    return { __throw: true };
  }
}

const out = [];
for (const sc of scenarios) {
  const rec = { id: sc.id, decision: sc.decision, indifferent: !!sc.indifferent, obs: [], expected: [] };
  try {
    const sys = await mod[factory]();
    setup(sys, sc);
    for (const [method, args, expected] of sc.steps) {
      const result = await call(sys, method, args);
      if (expected) {
        rec.obs.push(observe(result, expected));
        rec.expected.push(expected);
      }
    }
  } catch (e) {
    rec.crash = String(e?.message ?? e);
  }
  rec.match = !rec.crash && canon(rec.obs) === canon(rec.expected);
  out.push(rec);
}

console.log(JSON.stringify({ loadError: null, scenarios: out }));
