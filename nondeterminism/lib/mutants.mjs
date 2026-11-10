// Test of the tests: breaks one rule of the reference at a time and checks
// that the scenarios of that rule notice. Usage: node lib/mutants.mjs library

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeDir, STAND } from './paths.mjs';

const project = safeDir(process.argv[2]); // the reference and the scenarios live in the safe
const source = readFileSync(join(project, 'reference.mjs'), 'utf8');

const mutants = {
  library: [
    ['no grace days', 'late <= 2 ? 0 :', 'late <= 0 ? 0 :'],
    ['no fine cap', 'Math.min(25 * late, 500)', '25 * late'],
    ['renew counts from today', 'addDays(b.loan.dueDate, 21); // D9', 'addDays(date, 21); // D9'],
    ['unlimited renewals', 'if (b.loan.renewals >= 2) return no();', ''],
    ['hold on a free book', 'if (!b.loan && !b.ready) return no();', ''],
    ['no pickup window', 'if (b.queue.length) b.ready =', 'if (false) b.ready ='],
    ['no loan limit', 'if (loansOf(memberId) >= 5) return no();', ''],
  ],
}[process.argv[2]];

const dir = mkdtempSync(join(tmpdir(), 'mutants-'));
for (const [name, from, to] of mutants) {
  if (!source.includes(from)) throw new Error(`mutant "${name}": pattern not found`);
  const file = join(dir, `${name.replaceAll(' ', '-')}.mjs`);
  writeFileSync(file, source.replace(from, to));
  const out = execFileSync(process.execPath, [join(STAND, 'lib', 'checker.mjs'), file, join(project, 'scenarios.mjs')]);
  const failed = JSON.parse(out).scenarios.filter((s) => !s.match).map((s) => s.id);
  console.log(`${name.padEnd(24)} caught by: ${failed.join(', ') || 'NOTHING'}`);
}
