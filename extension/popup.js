const $ = (id) => document.getElementById(id);
const serverInput = $('server');
const tokenInput = $('token');
const listenInput = $('listen');
const toggle = $('toggle');
const statusEl = $('status');
const dot = $('dot');
const configBox = $('config');

const ACTIVE = new Set(['starting', 'connecting', 'live']);

async function loadConfig() {
  const cfg = await chrome.storage.local.get({ server: '', token: '', listen: false });
  serverInput.value = cfg.server;
  tokenInput.value = cfg.token;
  listenInput.checked = cfg.listen;
  if (!cfg.server || !cfg.token) configBox.open = true;
}

function saveConfig() {
  chrome.storage.local.set({
    server: serverInput.value.trim(),
    token: tokenInput.value.trim(),
    listen: listenInput.checked,
  });
}

function render(state) {
  const s = state?.state ?? 'idle';
  const active = ACTIVE.has(s);
  toggle.textContent = active ? 'Detener' : 'Transmitir esta pestana';
  toggle.classList.toggle('stop', active);
  toggle.disabled = s === 'stopping';
  dot.className = 'dot' + (s === 'live' ? ' live' : s === 'error' ? ' error' : '');
  statusEl.textContent = state?.text ?? '';
  statusEl.className = s === 'error' ? 'error' : '';
}

function normalizeServer(raw) {
  let url = raw.trim();
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) url = 'wss://' + url.replace(/^https?:\/\//i, '');
  const parsed = new URL(url);
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/stream';
  return parsed.toString();
}

async function start() {
  saveConfig();
  let server;
  try {
    server = normalizeServer(serverInput.value);
  } catch {
    server = null;
  }
  const token = tokenInput.value.trim();
  if (!server || !token) {
    configBox.open = true;
    render({ state: 'error', text: 'Falta el servidor o el token.' });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    render({ state: 'error', text: 'No se encontro la pestana actual.' });
    return;
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    render({ state: 'error', text: 'Chrome no permite capturar esta pestana: ' + err.message });
    return;
  }

  render({ state: 'starting', text: 'Iniciando captura...' });
  const res = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'start',
    streamId,
    tabId: tab.id,
    server,
    token,
    listen: listenInput.checked,
  });
  if (res?.error) render({ state: 'error', text: res.error });
}

async function stop() {
  render({ state: 'stopping', text: 'Deteniendo...' });
  await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
}

toggle.addEventListener('click', async () => {
  const { radio } = await chrome.storage.session.get('radio');
  if (ACTIVE.has(radio?.state)) await stop();
  else await start();
});

serverInput.addEventListener('change', saveConfig);
tokenInput.addEventListener('change', saveConfig);
listenInput.addEventListener('change', saveConfig);

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.radio) render(changes.radio.newValue);
});

await loadConfig();
const { radio } = await chrome.storage.session.get('radio');
render(radio);
