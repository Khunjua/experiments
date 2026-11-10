// The coder room: one `claude -p` call inside a locked container that can reach nothing but
// the API through the gate. No tools, our own system prompt, no settings, no saved session,
// an empty folder: the same call lib/run.mjs makes, moved into the room.
//
//   node lib/coder.mjs --locks                                   tries to break the locks
//   node lib/coder.mjs --project library --spec raw --model claude-haiku-5-5 --effort medium
//                                      one call; prints the verdict and keeps the reply in runs/_test
//
// The key: a one-year subscription token from `claude setup-token`, saved by hand as
// ~/.config/stand/coder.token (outside the stand). It enters the room as an environment
// variable and can only ever reach the hosts the gate allows.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureGate, GATE, GATE_PORT, gateLog } from './gate.mjs';
import { DATA, projectDir, runsDir, specPath, STAND } from './paths.mjs';
import { IMAGES, INNER_NETWORK, room } from './room.mjs';

export const KEY_FILE = join(homedir(), '.config', 'stand', 'coder.token');

async function key() {
  try {
    return (await readFile(KEY_FILE, 'utf8')).replace(/\s+/g, '');
  } catch {
    throw new Error(`no key at ${KEY_FILE}: run \`claude setup-token\` and save the token there`);
  }
}

function coderRoom({ env = {}, ...rest }) {
  return room({
    name: 'coder', image: IMAGES.coder, network: INNER_NETWORK, tmpfs: ['/home/node', '/work', '/tmp'],
    memory: '1g', pids: 256,
    env: { HTTPS_PROXY: `http://${GATE}:${GATE_PORT}`, ...env },
    ...rest,
  });
}

// The Claude Code version inside the room, as `claude --version` prints it. Needs no network.
export const cliVersion = async () =>
  (await room({ name: 'coder', image: IMAGES.coder, args: ['claude', '--version'], tmpfs: ['/home/node', '/tmp'] })).stdout.trim();

// One call to the model. Returns { res, json }: res is the raw container result, json the
// parsed `--output-format json` reply, or null when there was none.
export async function code({ model, effort, system, input, seconds = 20 * 60 }) {
  await ensureGate();
  const res = await coderRoom({
    args: [
      'claude', '-p', '--model', model, '--effort', effort,
      '--tools', '', '--system-prompt', system,
      '--strict-mcp-config', '--setting-sources', 'local', '--no-session-persistence',
      '--output-format', 'json',
    ],
    env: { CLAUDE_CODE_OAUTH_TOKEN: await key() },
    input, seconds,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { res, json };
}

if (import.meta.main) {
  const opt = { project: 'library', effort: 'medium' };
  for (let i = 2; i < process.argv.length; i += 1) {
    const k = process.argv[i].replace(/^--/, '');
    const v = process.argv[i + 1];
    if (v && !v.startsWith('--')) { opt[k] = v; i += 1; } else opt[k] = true;
  }

  if (opt.locks) {
    await ensureGate();
    const r = await coderRoom({
      mounts: { '/probe.mjs': join(STAND, 'rooms', 'coder', 'probe.mjs') },
      args: ['node', '/probe.mjs'], seconds: 60,
    });
    process.stdout.write(r.stdout + r.stderr);
    console.log(`\ngate log:\n${(await gateLog()).trim().split('\n').slice(-8).join('\n')}`);
    process.exit(r.code ?? 1);
  }

  if (opt.spec && opt.model) {
    const system = await readFile(join(STAND, 'prompts', 'compile.md'), 'utf8');
    const input = `# Interface\n\n${await readFile(join(projectDir(opt.project), 'interface.md'), 'utf8')}\n\n# Requirements\n\n${await readFile(specPath(opt.project, opt.spec), 'utf8')}`;
    const { res, json } = await code({ model: opt.model, effort: opt.effort, system, input });
    const dir = runsDir('_test', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'response.json'), res.stdout || res.stderr);
    const hasCode = /```(?:js|javascript|mjs)?[^\n]*\n[\s\S]*?```/.test(json?.result ?? '');
    console.log(json && !json.is_error
      ? `ok · code block: ${hasCode ? 'yes' : 'no'} · $${json.total_cost_usd?.toFixed(3)} · ${Math.round((json.duration_ms ?? 0) / 1000)}s · saved to ${dir.slice(DATA.length + 1)}`
      : `failed (${res.signal ?? res.code}): ${(res.stderr || res.stdout).slice(0, 500)}`);
    console.log(`\ngate log:\n${(await gateLog()).trim().split('\n').slice(-8).join('\n')}`);
  }
}
