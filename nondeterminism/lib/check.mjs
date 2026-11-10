// The check room: runs the scenarios against an implementation inside a locked container.
//
//   node lib/check.mjs --locks                        tries to break the locks; every try must fail
//   node lib/check.mjs --project library --impl ~/stand-data/runs/library/raw/claude-opus-5-5__medium/run-01/impl.mjs
//   node lib/check.mjs --project library --all        re-checks every old run against its saved observations.json
//
// Inside the room: /safe is the project's folder in the safe, /stand/lib and /stand/rooms are
// the stand's own code, /work/impl.mjs is the implementation. All read-only; no network; nothing else.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DATA, runsDir, safeDir, STAND } from './paths.mjs';
import { room } from './room.mjs';

const code = { '/stand/lib': join(STAND, 'lib'), '/stand/rooms': join(STAND, 'rooms') };

// Returns { result, ms }: result is the checker's JSON, or { checkerFailed } when it produced none.
export async function check(project, implPath) {
  const r = await room({
    name: 'check',
    mounts: { ...code, '/safe': safeDir(project), '/work/impl.mjs': resolve(implPath) },
    args: ['node', '/stand/lib/checker.mjs', '/work/impl.mjs', '/safe/scenarios.mjs'],
  });
  try {
    return { result: JSON.parse(r.stdout), ms: r.ms };
  } catch {
    return { result: { checkerFailed: true, code: r.code, signal: r.signal, stderr: r.stderr.slice(0, 2000) }, ms: r.ms };
  }
}

if (import.meta.main) {
  const opt = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const k = process.argv[i].replace(/^--/, '');
    const v = process.argv[i + 1];
    if (v && !v.startsWith('--')) { opt[k] = v; i += 1; } else opt[k] = true;
  }
  const project = opt.project ?? 'library';
  const verdict = (res) => res.checkerFailed ? `checker failed (${res.signal ?? res.code})`
    : res.loadError ? `load error: ${res.loadError}`
    : `${res.scenarios.filter((s) => s.match).length}/${res.scenarios.length} match the owner`;
  const sameAsSaved = async (implPath, result) => {
    try {
      const saved = JSON.parse(await readFile(join(dirname(implPath), 'observations.json'), 'utf8'));
      return JSON.stringify(saved) === JSON.stringify(result) ? 'same as saved' : 'DIFFERS from saved';
    } catch {
      return 'nothing saved';
    }
  };

  if (opt.locks) {
    const r = await room({ name: 'check', mounts: { ...code, '/safe': safeDir(project) }, args: ['node', '/stand/rooms/check/probe.mjs'] });
    process.stdout.write(r.stdout + r.stderr);
    process.exit(r.code ?? 1);
  }

  if (opt.impl) {
    const { result, ms } = await check(project, opt.impl);
    console.log(`${verdict(result)} · ${await sameAsSaved(opt.impl, result)} · ${ms} ms`);
    process.exit(0);
  }

  if (opt.all) {
    const impls = (await readdir(runsDir(project), { recursive: true }))
      .filter((p) => p.endsWith('impl.mjs')).sort().map((p) => join(runsDir(project), p));
    const tally = {};
    const queue = [...impls];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const implPath = queue.shift();
        const { result, ms } = await check(project, implPath);
        const cmp = await sameAsSaved(implPath, result);
        tally[cmp] = (tally[cmp] ?? 0) + 1;
        console.log(`${implPath.slice(DATA.length + 1).replace('/impl.mjs', '').padEnd(64)} ${verdict(result).padEnd(28)} ${cmp} · ${ms} ms`);
      }
    }));
    console.log(`\n${impls.length} implementations: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
}
