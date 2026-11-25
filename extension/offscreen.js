// Documento offscreen: captura el audio de la pestana, lo codifica a Opus
// (paquetes de 20 ms, 48 kHz, estereo, igual que Discord) y lo manda al servidor.
// Aqui solo existe chrome.runtime, asi que el estado se informa al service worker.

const SAMPLE_RATE = 48000;
const FRAMES = 960; // 20 ms
const PROTOCOL_VERSION = 1;
const MAX_WS_BACKLOG = 256 * 1024; // si la red no da abasto, se descarta audio en vez de acumular retraso

const OPUS_CONFIG = {
  codec: 'opus',
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 2,
  bitrate: 96000,
  opus: {
    frameDuration: 20000,
    application: 'audio',
    signal: 'music',
    complexity: 10,
    useinbandfec: true,
    usedtx: false,
  },
};

let current = null;

function report(state, text = '') {
  chrome.runtime.sendMessage({ target: 'background', type: 'status', state, text });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') start(msg);
  if (msg.type === 'stop') stop('Transmision detenida', 'idle', true);
});

async function start({ streamId, server, token, listen }) {
  if (current) stop('', 'idle', true, true); // reinicio: sin avisar, o el service worker cerraria este documento
  const c = { stopped: false, sending: false, dropped: 0, lastError: null, endReason: null };
  current = c;

  try {
    // 1. Audio de la pestana (hay que usar el streamId rapido, caduca en segundos)
    c.media = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    c.media.getAudioTracks()[0].addEventListener('ended', () => {
      stop('La pestana se cerro o dejo de compartirse', 'idle');
    });

    const support = await AudioEncoder.isConfigSupported(OPUS_CONFIG);
    if (!support.supported) throw new Error('Este navegador no puede codificar Opus con WebCodecs');

    // 2. Grafo de audio a 48 kHz (el AudioContext remuestrea si la pestana viene a otra frecuencia)
    c.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (c.ctx.state === 'suspended') await c.ctx.resume().catch(() => {});
    await c.ctx.audioWorklet.addModule('capture-worklet.js');
    const source = c.ctx.createMediaStreamSource(c.media);
    const capture = new AudioWorkletNode(c.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    // El worklet tiene que estar conectado a la salida para que Chrome lo procese; va con volumen 0
    const sink = c.ctx.createGain();
    sink.gain.value = 0;
    source.connect(capture).connect(sink).connect(c.ctx.destination);
    // Al capturar, Chrome silencia la pestana; si se pide, se reproduce tambien aqui
    if (listen) source.connect(c.ctx.destination);

    // 3. Codificador Opus
    c.encoder = new AudioEncoder({
      output: (chunk) => {
        if (!c.sending || c.ws.readyState !== WebSocket.OPEN) return;
        if (c.ws.bufferedAmount > MAX_WS_BACKLOG) {
          c.dropped++;
          return;
        }
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        c.ws.send(packet);
      },
      error: (err) => stop('Error del codificador: ' + err.message, 'error'),
    });
    c.encoder.configure(OPUS_CONFIG);

    let timestamp = 0;
    capture.port.onmessage = ({ data }) => {
      if (c.stopped || c.encoder.state !== 'configured') return;
      const planar = new Float32Array(FRAMES * 2);
      planar.set(data.left, 0);
      planar.set(data.right, FRAMES);
      const audio = new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAMES,
        numberOfChannels: 2,
        timestamp,
        data: planar,
      });
      timestamp += 20000;
      c.encoder.encode(audio);
      audio.close();
    };

    // 4. Conexion con el servidor
    report('connecting', 'Conectando con el servidor...');
    c.ws = new WebSocket(server);
    c.ws.binaryType = 'arraybuffer';
    c.ws.onopen = () => c.ws.send(JSON.stringify({ type: 'hello', token, v: PROTOCOL_VERSION }));
    c.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        c.sending = true;
        report('live', `En vivo en ${msg.channel} (${msg.guild})`);
      } else if (msg.type === 'error') {
        c.lastError = msg.message;
      } else if (msg.type === 'ended') {
        c.endReason = msg.message;
      }
    };
    c.ws.onclose = (ev) => {
      if (c.stopped) return;
      if (c.lastError) return stop(c.lastError, 'error');
      if (c.endReason) return stop(c.endReason, 'idle');
      if (c.sending) return stop(ev.reason || 'Se perdio la conexion con el servidor', 'error');
      stop('No se pudo conectar con el servidor. Revisa la direccion.', 'error');
    };
  } catch (err) {
    stop('No se pudo iniciar: ' + err.message, 'error');
  }
}

function stop(text, state = 'idle', userRequested = false, silent = false) {
  const c = current;
  if (!c || c.stopped) {
    if (!silent) report(state, text);
    return;
  }
  c.stopped = true;
  current = null;

  if (c.ws) {
    if (userRequested && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'stop' }));
    if (c.ws.readyState <= WebSocket.OPEN) c.ws.close(1000, 'Fin');
  }
  try {
    if (c.encoder && c.encoder.state !== 'closed') c.encoder.close();
  } catch {}
  c.ctx?.close().catch(() => {});
  c.media?.getTracks().forEach((t) => t.stop());

  if (!silent) report(state, text);
}

// Pedir la orden de inicio que dejo pendiente el service worker
const initial = await chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-ready' });
if (initial) start(initial);
