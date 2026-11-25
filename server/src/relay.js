import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from './log.js';

const PROTOCOL_VERSION = 1;

/**
 * Servidor WebSocket que recibe el audio de la extension.
 *
 * Protocolo:
 *  1. extension -> servidor (texto): {"type":"hello","token":"...","v":1}
 *  2. servidor -> extension (texto): {"type":"ready","guild":"...","channel":"..."} o {"type":"error","message":"..."}
 *  3. extension -> servidor (binario): un paquete Opus de 20 ms por mensaje
 *  4. cualquiera puede cerrar; el servidor manda {"type":"ended","message":"..."} si corta el.
 */
export function startRelay({ port, tokens, sessions }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transmisiones: sessions.count }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, path: '/stream', maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    let session = null;
    let saidHello = false;
    let closed = false;

    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    const fail = (code, message) => {
      send({ type: 'error', message });
      ws.close(code, message.slice(0, 120));
    };

    const helloTimer = setTimeout(() => fail(4000, 'No llego el saludo inicial'), 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        session?.pushPacket(data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        fail(4002, 'Mensaje invalido');
        return;
      }

      if (msg.type === 'hello' && !saidHello) {
        saidHello = true;
        clearTimeout(helloTimer);

        if (msg.v !== PROTOCOL_VERSION) {
          fail(4004, 'Version de la extension incompatible con el servidor, actualizala');
          return;
        }
        const userId = tokens.resolve(msg.token);
        if (!userId) {
          log.warn(`Token invalido desde ${ip}`);
          fail(4001, 'Token invalido. Usa /vincular en Discord para obtener uno nuevo');
          return;
        }

        try {
          const started = await sessions.start({
            userId,
            onEnd: (reason) => {
              send({ type: 'ended', message: reason });
              if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 120));
            },
          });
          if (closed) {
            started.destroy('La extension se desconecto mientras se conectaba');
            return;
          }
          session = started;
          send({ type: 'ready', guild: started.guild.name, channel: started.channel.name });
        } catch (err) {
          fail(4003, err.message);
        }
        return;
      }

      if (msg.type === 'stop') {
        session?.destroy('Detenido desde la extension');
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Detenido');
      }
    });

    ws.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      session?.destroy('La extension se desconecto');
    });
    ws.on('error', (err) => log.warn(`WebSocket ${ip}:`, err.message));
  });

  // Corta conexiones muertas (por ejemplo, si el PC se suspende)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);
  wss.on('close', () => clearInterval(heartbeat));

  server.listen(port, () => log.info(`Relay escuchando en el puerto ${server.address().port} (ruta /stream, salud en /health)`));
  return { server, wss };
}
