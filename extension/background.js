// Service worker: coordina el popup con el documento offscreen, que es el
// unico lugar donde se puede tener el audio de la pestana y el WebSocket abiertos.

const OFFSCREEN_URL = 'offscreen.html';
let pendingStart = null;

async function setState(state, text = '') {
  await chrome.storage.session.set({ radio: { state, text, at: Date.now() } });
  const badge = { live: 'ON', connecting: '...', starting: '...', error: '!' }[state] ?? '';
  const color = { live: '#23a55a', error: '#da373c' }[state] ?? '#5865f2';
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capturar el audio de la pestana y enviarlo al bot de Discord',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function handleStart(msg) {
  const { radio } = await chrome.storage.session.get('radio');
  if (['starting', 'connecting', 'live'].includes(radio?.state)) {
    return { error: 'Ya hay una transmision activa. Detenla primero.' };
  }
  await setState('starting', 'Iniciando captura...');
  const payload = {
    target: 'offscreen',
    type: 'start',
    streamId: msg.streamId,
    server: msg.server,
    token: msg.token,
    listen: msg.listen,
  };
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage(payload);
  } else {
    // El offscreen pide la orden apenas carga (ver 'offscreen-ready'),
    // asi no se pierde el mensaje si su script aun no esta escuchando.
    pendingStart = payload;
    await ensureOffscreen();
  }
  return { ok: true };
}

async function handleStop() {
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  } else {
    await setState('idle', '');
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;

  if (msg.type === 'start') {
    handleStart(msg).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'stop') {
    handleStop().then(sendResponse);
    return true;
  }
  if (msg.type === 'offscreen-ready') {
    sendResponse(pendingStart);
    pendingStart = null;
    return false;
  }
  if (msg.type === 'status') {
    // El offscreen informa como va la transmision
    (async () => {
      await setState(msg.state, msg.text);
      if (msg.state === 'idle' || msg.state === 'error') await closeOffscreen();
    })();
    return false;
  }
  return false;
});

// Si el service worker se reinicio y el offscreen ya no existe, limpiar estado viejo
(async () => {
  const { radio } = await chrome.storage.session.get('radio');
  if (['starting', 'connecting', 'live'].includes(radio?.state) && !(await hasOffscreen())) {
    await setState('idle', '');
  }
})();
