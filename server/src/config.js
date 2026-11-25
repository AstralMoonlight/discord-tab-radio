function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} debe ser un numero (valor actual: "${raw}")`);
  return value;
}

export function loadConfig() {
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error('Falta DISCORD_TOKEN. Copia .env.example a .env y pon el token de tu bot.');
  }

  return {
    discordToken,
    port: num('PORT', 8790),
    dataDir: process.env.DATA_DIR || './data',
    // URL que se le muestra al usuario en /vincular, para pegarla en la extension
    publicUrl: process.env.PUBLIC_URL || '',
    // Latencia maxima tolerada en el servidor antes de descartar audio viejo
    maxBufferMs: num('MAX_BUFFER_MS', 400),
    // Audio que se junta antes de empezar a sonar (absorbe el jitter de la red)
    prebufferMs: num('PREBUFFER_MS', 100),
  };
}
