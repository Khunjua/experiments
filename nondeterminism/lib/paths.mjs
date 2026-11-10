// The three roots of the stand. The code lives in STAND, this repository. The owner's hidden
// decisions, scenarios, reference and full spec live in SAFE, a private repository next to it.
// Everything the runs produce goes to DATA, outside any repository. SAFE and DATA can be moved
// with the environment variables STAND_SAFE and STAND_DATA, for example on a server.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAND = join(dirname(fileURLToPath(import.meta.url)), '..');
// Published layout: `safe/` and `data/` inside this folder win when they exist.
export const SAFE = process.env.STAND_SAFE ?? (existsSync(join(STAND, 'safe')) ? join(STAND, 'safe') : join(STAND, '..', 'stand-safe'));
export const DATA = process.env.STAND_DATA ?? (existsSync(join(STAND, 'data')) ? join(STAND, 'data') : join(homedir(), 'stand-data'));

export const projectDir = (project) => join(STAND, 'projects', project); // interface, public specs
export const safeDir = (project) => join(SAFE, 'projects', project); // truth, scenarios, reference, hidden specs
export const runsDir = (...parts) => join(DATA, 'runs', ...parts);
export const resultsDir = () => join(DATA, 'results');

// A spec is public (in the stand) or hidden (in the safe, like the owner's full decisions).
export function specPath(project, spec) {
  const pub = join(projectDir(project), 'specs', `${spec}.md`);
  return existsSync(pub) ? pub : join(safeDir(project), 'specs', `${spec}.md`);
}
