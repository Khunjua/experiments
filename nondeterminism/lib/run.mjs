// Generates implementations with Claude Code in the coder room, then checks each one in the
// check room.
//
//   node lib/run.mjs --project library --spec raw --model claude-haiku-5-5 --effort medium --runs 5
//   node lib/run.mjs --project library --expand raw --model claude-opus-5-5 --effort medium
//
// Every call: no tools, our own system prompt, no MCP, no user settings, no saved session,
// an empty folder, and nothing reachable but the API through the gate (lib/coder.mjs). Runs
// that already finished are skipped, so a cell can be topped up later with a larger --runs;
// failed calls (rate limit, network) are tried again. meta.json says room: true, so runs made
// in the rooms can be told apart from the early ones made outside.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from './check.mjs';
import { cliVersion, code } from './coder.mjs';
import { ensureGate } from './gate.mjs';
import { projectDir, runsDir, specPath, STAND } from './paths.mjs';

const opt = { effort: 'medium', runs: '1', parallel: '3' };
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const pub = projectDir(opt.project); // the interface and the public specs
const read = (...p) => readFile(join(...p), 'utf8');
const exists = (p) => access(p).then(() => true, () => false);

await ensureGate(); // once, before the parallel calls, so they all find it already running
const cli = await cliVersion();
const interfaceText = await read(pub, 'interface.md');

// AI-detailed spec: one model expands the raw request into a full spec, once, frozen.
if (opt.expand) {
  const raw = await read(specPath(opt.project, opt.expand));
  const suffix = opt.tag ? `-${opt.tag}` : ''; // --tag 01: several expansions side by side
  const work = runsDir('_expand', `${opt.project}-${opt.model}${suffix}`);
  await mkdir(work, { recursive: true });
  const input = `# Interface\n\n${interfaceText}\n\n# Client request\n\n${raw}`;
  const { res, json } = await code({ model: opt.model, effort: opt.effort, system: await read(STAND, 'prompts', 'expand.md'), input });
  if (!json?.result) throw new Error(`expand failed: ${res.stderr.slice(0, 500)}`);
  const name = `ai-${opt.model.replace('claude-', '')}${suffix}`;
  await writeFile(join(pub, 'specs', `${name}.md`), json.result.trim() + '\n');
  await writeFile(join(work, 'response.json'), res.stdout);
  console.log(`wrote specs/${name}.md · $${json.total_cost_usd?.toFixed(3)}`);
  process.exit(0);
}

const system = await read(STAND, 'prompts', 'compile.md');
const spec = await read(specPath(opt.project, opt.spec));
const input = `# Interface\n\n${interfaceText}\n\n# Requirements\n\n${spec}`;
const cellDir = runsDir(opt.project, opt.spec, `${opt.model}__${opt.effort}`);

async function one(i) {
  const dir = join(cellDir, `run-${String(i).padStart(2, '0')}`);
  if (await exists(join(dir, 'meta.json'))) {
    const done = JSON.parse(await read(dir, 'meta.json'));
    if (done.ok) return;
  }
  await mkdir(dir, { recursive: true });
  const started = new Date().toISOString();

  const { res, json } = await code({ model: opt.model, effort: opt.effort, system, input });
  await writeFile(join(dir, 'response.json'), res.stdout || res.stderr);
  const text = json?.result ?? '';
  const impl = text.match(/```(?:js|javascript|mjs)?[^\n]*\n([\s\S]*?)```/)?.[1] ?? null;
  const assumptions = text.split(/^\s*ASSUMPTIONS:?\s*$/m)[1]?.trim() ?? '';
  await writeFile(join(dir, 'assumptions.txt'), assumptions + '\n');

  let obs = { skipped: 'no code in the reply' };
  if (impl) {
    await writeFile(join(dir, 'impl.mjs'), impl);
    obs = (await check(opt.project, join(dir, 'impl.mjs'))).result;
  }
  await writeFile(join(dir, 'observations.json'), JSON.stringify(obs, null, 1));

  const matched = obs.scenarios?.filter((s) => s.match).length ?? null;
  const total = obs.scenarios?.length ?? null;
  const meta = {
    project: opt.project, spec: opt.spec, model: opt.model, effort: opt.effort, run: i, cli, room: true,
    started, finished: new Date().toISOString(),
    ok: !!json && !json.is_error, exit: res.code, signal: res.signal,
    costUSD: json?.total_cost_usd ?? null, durationMs: json?.duration_ms ?? null, wallMs: res.ms, usage: json?.usage ?? null,
    hasCode: !!impl, loadError: obs.loadError ?? null, matched, total,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  const verdict = !impl ? 'no code'
    : obs.checkerFailed ? `checker failed (${obs.signal ?? obs.code})`
    : obs.loadError ? `load error: ${obs.loadError}`
    : `${matched}/${total} match the owner`;
  console.log(`${opt.spec} · ${opt.model} · ${opt.effort} · run ${i}: ${verdict} · $${meta.costUSD?.toFixed(3)} · ${Math.round((meta.durationMs ?? 0) / 1000)}s`);
}

const queue = Array.from({ length: Number(opt.runs) }, (_, k) => k + 1);
await Promise.all(Array.from({ length: Math.min(Number(opt.parallel), queue.length) }, async () => {
  while (queue.length) await one(queue.shift());
}));
