// Runs one command in a room: a container with a read-only root filesystem, the folders
// listed here mounted read-only, and nothing else. By default the room has no network at
// all; a room that needs the model joins the inner network, whose only exit is the gate.
// The command's stdout is the result. Images are pinned, so every machine runs the same code.

import { spawn } from 'node:child_process';

export const IMAGES = {
  node: 'node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec',
  coder: 'stand-coder:2.1.310', // built from rooms/coder/Dockerfile on top of the node image
};

export const INNER_NETWORK = 'stand-inner';

export function room({
  mounts = {}, args, seconds = 30, memory = '512m', pids = 64, name = 'room',
  image = IMAGES.node, network = 'none', env = {}, tmpfs = [], input = '',
}) {
  // Labeled like everything else the stand makes, so a stuck room is found and removed by label.
  const docker = [
    'run', '--rm', '-i', '--label', 'stand=1', '--label', `stand.room=${name}`,
    '--network', network, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', String(pids), '--memory', memory,
    '--user', 'node', '--workdir', '/work',
  ];
  for (const [inside, outside] of Object.entries(mounts)) {
    docker.push('--mount', `type=bind,src=${outside},dst=${inside},readonly`);
  }
  // Scratch space the command may write to; it vanishes with the container.
  for (const path of tmpfs) docker.push('--tmpfs', `${path}:rw,uid=1000,gid=1000,size=256m`);
  // Values travel in the environment, never on the command line: `-e NAME` alone makes
  // docker copy the value from this process's environment.
  for (const name of Object.keys(env)) docker.push('-e', name);
  // The clock runs inside the room, so a stuck command stops the container itself.
  docker.push(image, 'timeout', '-s', 'KILL', String(seconds), ...args);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('docker', docker, {
      env: { ...process.env, ...env }, timeout: (seconds + 30) * 1000, killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}
