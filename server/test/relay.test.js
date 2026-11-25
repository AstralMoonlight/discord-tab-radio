import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
} from '@discordjs/voice';
import { startRelay } from '../src/relay.js';
import { TokenStore } from '../src/tokens.js';
import { OpusFeed } from '../src/sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('TokenStore: emite, resuelve, invalida el anterior y persiste solo hashes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabradio-'));
  const store = new TokenStore(dir);
  await store.load();
  const t1 = await store.issue('111');
  assert.equal(store.resolve(t1), '111');
  const t2 = await store.issue('111');
  assert.equal(store.resolve(t1), null, 'el token viejo ya no sirve');
  assert.equal(store.resolve(t2), '111');

  const raw = await fs.readFile(path.join(dir, 'tokens.json'), 'utf8');
  assert.ok(!raw.includes(t2), 'el token no se guarda en claro');

  const reloaded = new TokenStore(dir);
  await reloaded.load();
  assert.equal(reloaded.resolve(t2), '111');
  assert.equal(await reloaded.revoke('111'), true);
  assert.equal(reloaded.resolve(t2), null);
});

test('OpusFeed: limita la latencia descartando lo mas viejo', () => {
  const feed = new OpusFeed({ maxFrames: 20, targetFrames: 10 });
  for (let i = 0; i < 100; i++) feed.feed(Buffer.from([i]));
  assert.ok(feed.readableLength <= 20, `quedaron ${feed.readableLength}`);
  // lo que queda es lo mas nuevo
  let last;
  let p;
  while ((p = feed.read())) last = p;
  assert.equal(last[0], 99);
  assert.ok(feed.dropped > 0);
});

test('AudioPlayer consume la cola a 20 ms y no se detiene con huecos de red', async () => {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY },
  });
  const feed = new OpusFeed({ maxFrames: 20, targetFrames: 10 });
  for (let i = 0; i < 5; i++) feed.feed(Buffer.from([0xf8, 0xff, 0xfe]));
  const resource = createAudioResource(feed, { inputType: StreamType.Opus });
  player.play(resource);
  await sleep(60);
  assert.equal(player.state.status, AudioPlayerStatus.Playing);

  // Hueco de 300 ms sin paquetes: debe seguir en Playing (rellena con silencio)
  await sleep(300);
  assert.equal(player.state.status, AudioPlayerStatus.Playing);

  // Llegan mas paquetes y se siguen consumiendo
  for (let i = 0; i < 10; i++) feed.feed(Buffer.from([0xf8, 0xff, 0xfe]));
  await sleep(300);
  assert.equal(feed.readableLength, 0);
  assert.ok(resource.playbackDuration >= 15 * 20 - 20, `duracion ${resource.playbackDuration}`);

  feed.finish();
  await sleep(250);
  assert.equal(player.state.status, AudioPlayerStatus.Idle);
});

test('Relay: saludo, token invalido, paquetes binarios y cierre', async () => {
  const received = [];
  let destroyedWith = null;
  const tokens = { resolve: (t) => (t === 'token-valido-1234567890' ? 'user1' : null) };
  const sessions = {
    count: 0,
    async start({ userId }) {
      assert.equal(userId, 'user1');
      return {
        guild: { name: 'Mi server' },
        channel: { name: 'General' },
        pushPacket: (p) => received.push(p),
        destroy: (reason) => (destroyedWith = reason),
      };
    },
  };
  const { server, wss } = startRelay({ port: 0, tokens, sessions });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/stream`;

  // Token malo
  const bad = new WebSocket(url);
  await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'hello', token: 'malo-malo-malo-malo', v: 1 }));
  const [badMsg] = await once(bad, 'message');
  assert.equal(JSON.parse(badMsg.toString()).type, 'error');
  const [code] = await once(bad, 'close');
  assert.equal(code, 4001);

  // Token bueno
  const ws = new WebSocket(url);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', token: 'token-valido-1234567890', v: 1 }));
  const [readyMsg] = await once(ws, 'message');
  assert.deepEqual(JSON.parse(readyMsg.toString()), { type: 'ready', guild: 'Mi server', channel: 'General' });

  for (let i = 0; i < 25; i++) ws.send(new Uint8Array([i, 1, 2, 3]));
  await sleep(100);
  assert.equal(received.length, 25);
  assert.equal(received[24][0], 24);

  ws.close();
  await sleep(100);
  assert.equal(destroyedWith, 'La extension se desconecto');

  // Salud
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(res.status, 200);

  wss.close();
  server.close();
});

test('Relay: un motivo de cierre largo y no ASCII no tumba el proceso', async () => {
  const name = 'あ'.repeat(32);
  const busyMsg = `Ya hay una transmision en este servidor (de ${name})`;
  const endMsg = `Detenido por ${'😀'.repeat(32)} con /salir`;
  let onEnd;
  const tokens = { resolve: () => 'user1' };
  const sessions = {
    count: 0,
    async start(opts) {
      if (!onEnd) {
        onEnd = opts.onEnd;
        return { guild: { name: 'g' }, channel: { name: 'c' }, pushPacket() {}, destroy() {} };
      }
      throw new Error(busyMsg);
    },
  };
  const { server, wss } = startRelay({ port: 0, tokens, sessions });
  await once(server, 'listening');
  const hello = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/stream`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'x', v: 1 }));
    const [msg] = await once(ws, 'message');
    return { ws, msg: JSON.parse(msg.toString()) };
  };
  const checkClose = async (ws, code, full) => {
    const [gotCode, reason] = await once(ws, 'close', { signal: AbortSignal.timeout(2000) });
    assert.equal(gotCode, code);
    assert.ok(reason.length > 100 && reason.length <= 123, `motivo de ${reason.length} bytes`);
    assert.ok(full.startsWith(reason.toString()), 'no corta un caracter por la mitad');
  };

  try {
    const live = await hello();
    assert.equal(live.msg.type, 'ready');

    // Cierre por error: el mensaje llega completo, solo se recorta el motivo del cierre
    const busy = await hello();
    assert.equal(busy.msg.message, busyMsg);
    await checkClose(busy.ws, 4003, busyMsg);

    // Cierre normal (por ejemplo /salir)
    const closed = checkClose(live.ws, 1000, endMsg);
    onEnd(endMsg);
    await closed;
  } finally {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
});

test('Relay: un mensaje de texto invalido cierra la conexion sin tumbar el proceso', async () => {
  const { server, wss } = startRelay({ port: 0, tokens: { resolve: () => null }, sessions: { count: 0 } });
  await once(server, 'listening');
  try {
    for (const bad of ['null', '42', '"hola"', '[]', '{}', '{"type":null}', '', '{no es json']) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/stream`);
      await once(ws, 'open');
      ws.send(bad);
      const [code] = await once(ws, 'close', { signal: AbortSignal.timeout(2000) });
      assert.equal(code, 4002, `mensaje: ${bad}`);
    }
  } finally {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
});
