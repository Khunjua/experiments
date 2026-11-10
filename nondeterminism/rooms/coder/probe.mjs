// Runs inside the coder room and tries to break its locks. What the room is built for must
// work: Claude Code runs, scratch space takes writes, the API is reachable through the gate.
// Everything else must fail. Exit code 1 when a lock is open or a door is stuck.

import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const gate = new URL(process.env.HTTPS_PROXY);
const fail = (code) => Object.assign(new Error(code), { code });

// Asks the gate for a tunnel to host:port. Resolves on 200, rejects with the gate's answer.
const throughGate = (host, port = 443) => new Promise((resolve, reject) => {
  const s = connect(Number(gate.port), gate.hostname);
  s.setTimeout(10000, () => { s.destroy(); reject(fail('TIMEOUT')); });
  s.on('error', reject);
  s.once('data', (d) => {
    s.destroy();
    const status = String(d).split(' ')[1];
    status === '200' ? resolve(`gate said ${status}`) : reject(fail(`gate said ${status}`));
  });
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
});

// Tries to open a plain connection, with no gate in between.
const direct = (host, port) => new Promise((resolve, reject) => {
  const s = connect(port, host);
  s.setTimeout(5000, () => { s.destroy(); reject(fail('TIMEOUT')); });
  s.on('error', reject);
  s.on('connect', () => { s.destroy(); resolve('connected'); });
});

const doors = {
  'run claude': () => execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  'write in the scratch space': () => {
    writeFileSync('/work/probe.txt', 'x');
    writeFileSync(`${process.env.HOME}/probe.txt`, 'x');
    return '/work and home';
  },
  'reach api.anthropic.com through the gate': () => throughGate('api.anthropic.com'),
  'reach platform.claude.com through the gate': () => throughGate('platform.claude.com'),
};

const locks = {
  'see the safe': () => readdirSync('/safe'),
  'see the stand': () => readdirSync('/stand'),
  'write into the image': () => writeFileSync('/usr/local/probe.txt', 'x'),
  'reach example.com through the gate': () => throughGate('example.com'),
  'reach api.anthropic.com on another port': () => throughGate('api.anthropic.com', 80),
  'reach the network without the gate': () => direct('1.1.1.1', 443),
  'resolve a name without the gate': () => lookup('example.com'),
};

let broken = 0;
for (const [name, go] of Object.entries(doors)) {
  try {
    console.log(`works    ${name}  (${await go()})`);
  } catch (e) {
    console.log(`STUCK    ${name}  (${e.code ?? e.message})`);
    broken += 1;
  }
}
for (const [name, go] of Object.entries(locks)) {
  try {
    const got = await go();
    console.log(`OPEN     ${name}  (${typeof got === 'string' ? got : 'succeeded'})`);
    broken += 1;
  } catch (e) {
    console.log(`blocked  ${name}  (${e.cause?.code ?? e.code ?? e.name})`);
  }
}
process.exit(broken ? 1 : 0);
