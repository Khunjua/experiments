// Runs inside the check room and tries to break its locks. Every try must fail.
// Exit code 1 when any lock is open.

import { readdirSync, writeFileSync } from 'node:fs';

const tries = {
  'write into the safe': () => writeFileSync('/safe/probe.txt', 'x'),
  'write into the stand code': () => writeFileSync('/stand/lib/probe.txt', 'x'),
  'write anywhere else': () => writeFileSync('/tmp/probe.txt', 'x'),
  'see the other runs': () => readdirSync('/stand/runs'),
  'reach the network': () => fetch('https://example.com', { signal: AbortSignal.timeout(5000) }),
};

console.log(`allowed  read the safe  (${readdirSync('/safe').length} entries)`);
let open = 0;
for (const [name, go] of Object.entries(tries)) {
  try {
    await go();
    console.log(`OPEN     ${name}`);
    open += 1;
  } catch (e) {
    console.log(`blocked  ${name}  (${e.cause?.code ?? e.code ?? e.name})`);
  }
}
process.exit(open ? 1 : 0);
