// The gate: the only way out of the inner network. A small HTTP CONNECT proxy that opens a
// tunnel to the hosts listed in ALLOW, on port 443 only, and logs every attempt, allowed or
// not. Plain HTTP requests are refused: nothing in the rooms needs them.

import { createServer } from 'node:http';
import { connect } from 'node:net';

const allow = new Set((process.env.ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const port = Number(process.env.PORT ?? 3128);
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const server = createServer((req, res) => {
  log(`deny  ${req.method} ${req.url}`);
  res.writeHead(403);
  res.end();
});

server.on('connect', (req, socket, head) => {
  const [host, portText] = req.url.split(':');
  const target = Number(portText ?? 443);
  if (!allow.has(host) || target !== 443) {
    log(`deny  ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = connect(target, host, () => {
    log(`allow ${req.url}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', (e) => {
    log(`fail  ${req.url} ${e.code ?? e.message}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(port, () => log(`gate on :${port}, allow ${[...allow].join(' ')}`));
