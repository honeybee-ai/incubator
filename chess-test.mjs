import { WebSocket } from 'ws';

const WS_URL = 'wss://horus.ellyseum.dev:8080/ws?namespace=default&since=0';

const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
const messages = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  messages.push(msg);

  if (msg.type === 'ping') return;
  console.log('[WS]', msg.type, msg.type === 'event' ? msg.event?.type : '', JSON.stringify(msg).slice(0, 200));

  if (msg.type === 'dance_result') {
    const r = msg.result || {};
    if (r.error) {
      console.log('[FAIL] dance_result error:', r.error);
    } else {
      console.log('[OK] Move processed:', JSON.stringify(r).slice(0, 200));
      console.log('[OK] Board updated, waiting for AI response...');
    }
  }

  if (msg.type === 'event' && msg.event?.type === 'move' && msg.event?.data?.player === 'b') {
    console.log('[OK] AI moved:', msg.event.data.move);
    console.log('[DONE] Full E2E works! Human move → server → AI inference → AI move → event');
    setTimeout(() => process.exit(0), 1000);
  }
});

ws.on('open', () => {
  console.log('[WS] Connected');

  // Reset
  ws.send(JSON.stringify({ type: 'reset' }));

  // Start game
  setTimeout(() => {
    console.log('[WS] Publishing start event...');
    ws.send(JSON.stringify({ type: 'publish', event: 'start', data: { source: 'test' } }));
  }, 500);

  // Make a move after agents spawn
  setTimeout(() => {
    console.log('[WS] Sending e2e4...');
    ws.send(JSON.stringify({
      type: 'dance_call',
      tool: 'make_move',
      args: { move: 'e2e4' },
      agentId: 'human_white',
      role: 'player_white',
      callId: 'call_' + Date.now()
    }));
  }, 2000);
});

ws.on('error', (err) => console.error('[WS ERROR]', err.message));

// Timeout after 60s
setTimeout(() => {
  console.log('[TIMEOUT] No AI response after 60s');
  process.exit(1);
}, 60000);
