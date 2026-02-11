import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

const CERT_DIR = process.env.HOME + '/.local/share/certbot/live/ellyseum.dev';
const BACKEND = 'http://localhost:3101';
const PORT = 3100;

const opts = {
  key: readFileSync(`${CERT_DIR}/privkey.pem`),
  cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
};

// HTTPS → HTTP proxy
const server = createServer(opts, (req, res) => {
  const proxyReq = httpRequest(`${BACKEND}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, host: `localhost:3101` },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end(`Proxy error: ${e.message}`);
  });
  req.pipe(proxyReq);
});

// WSS → WS proxy
server.on('upgrade', (req, socket, head) => {
  const target = `ws://localhost:3101${req.url}`;
  const ws = new WebSocket(target);

  ws.on('open', () => {
    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // Backend → Client
      ws.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
      });
      // Client → Backend
      clientWs.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
      ws.on('close', () => clientWs.close());
      clientWs.on('close', () => ws.close());
    });
  });

  ws.on('error', () => socket.destroy());
});

server.listen(PORT, () => {
  console.log(`HTTPS proxy on https://localhost:${PORT} → ${BACKEND}`);
});
