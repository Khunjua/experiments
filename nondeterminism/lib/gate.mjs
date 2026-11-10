// Starts and stops the gate through compose.yaml: rooms/gate/gate.mjs in its own locked
// container on both networks. The inner network has no way out but the gate; a room that
// needs the model joins it with HTTPS_PROXY pointing here, so the hosts compose.yaml allows
// are all it can ever reach. The gate's log shows every attempt.
//
//   node lib/gate.mjs start | stop | down | log

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STAND } from './paths.mjs';

const run = promisify(execFile);

export const GATE = 'stand-gate';
export const GATE_PORT = 3128;

const docker = async (...args) => (await run('docker', args)).stdout.trim();
const compose = (...args) => docker('compose', '-f', join(STAND, 'compose.yaml'), ...args);

// Brings up the networks and the gate; does nothing when the gate is already running.
export async function ensureGate() {
  if (await docker('ps', '-q', '--filter', `name=^${GATE}$`)) return;
  await compose('up', '-d', 'gate');
}

export const stopGate = () => compose('stop', 'gate'); // the networks stay
export const downGate = () => compose('down'); // the gate and the networks go; images stay
export const gateLog = () => run('docker', ['logs', GATE]).then((r) => r.stdout + r.stderr, () => '');

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'start') await ensureGate();
  else if (cmd === 'stop') await stopGate();
  else if (cmd === 'down') await downGate();
  else if (cmd === 'log') process.stdout.write(await gateLog());
  else console.log('usage: node lib/gate.mjs start | stop | down | log');
}
