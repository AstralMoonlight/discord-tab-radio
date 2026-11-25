# Tab Radio para Discord

Transmite el audio de una pestana del navegador (YouTube Music, Spotify Web, lo que sea) a un canal de voz de Discord. En el canal aparece un bot como un usuario mas, asi que cada persona lo puede mutear o bajarle el volumen con clic derecho.

La musica la pone cada uno desde su propia cuenta (con su Premium, sin anuncios). El bot no descarga nada de YouTube: solo retransmite lo que suena en la pestana.

```
Pestana  ->  Extension (captura + Opus 20 ms)  ->  wss://tu-servidor/stream  ->  Bot  ->  Canal de voz
```

- `server/`: bot de Discord + relay WebSocket (Node 22, discord.js, @discordjs/voice con cifrado DAVE).
- `extension/`: extension para Chrome, Edge, Brave y otros navegadores Chromium (Manifest V3, Chrome 116 o superior).

---

## 1. Crear el bot en Discord

1. Entra a <https://discord.com/developers/applications> y crea una aplicacion (el nombre es el que vera la gente en el canal, por ejemplo "Radio").
2. En **Bot**: aprieta *Reset Token* y guarda el token. No necesitas activar ningun *Privileged Gateway Intent*.
3. En **OAuth2 > URL Generator**: marca `bot` y `applications.commands`, y en permisos `View Channels`, `Connect` y `Speak`. Abre la URL generada e invita el bot a tu servidor.

   O usa directamente (cambia `TU_CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=TU_CLIENT_ID&scope=bot+applications.commands&permissions=3146752`

## 2. Levantar el servidor

### Con GitHub Actions (runner self-hosted)

El workflow `.github/workflows/deploy.yml` se ejecuta en cada push a `main` que toque `server/`.

En el repo, en *Settings > Secrets and variables > Actions*:
- Secret `TAB_RADIO_DISCORD_TOKEN`: el token del bot.
- Variable `TAB_RADIO_PUBLIC_URL`: por ejemplo `wss://radio.tudominio.cl/stream`.

Los tokens de los usuarios quedan en el volumen `tab-radio-data`, asi que sobreviven a los redeploys.

### A mano

```bash
cd server
cp .env.example .env   # y completa DISCORD_TOKEN y PUBLIC_URL
docker compose up -d --build
docker logs -f tab-radio
```

Al arrancar, el log muestra un reporte de dependencias de voz; debe decir `davey` con una version y `aes-256-gcm: yes`.

## 3. Exponerlo con wss (HTTPS)

La extension se conecta por WebSocket al puerto 8790, ruta `/stream`. Para usarlo desde fuera de tu red ponlo detras de HTTPS; ademas el token viaja en esa conexion, asi que no conviene `ws://` sin cifrar por internet.

**Caddy** (maneja WebSocket solo):
```
radio.tudominio.cl {
    reverse_proxy 127.0.0.1:8790
}
```

**Nginx**:
```nginx
location /stream {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
}
```

**Cloudflare Tunnel** tambien sirve (soporta WebSocket): apunta el hostname a `http://localhost:8790`.

Para probar en la red local puedes usar `ws://IP-DEL-SERVIDOR:8790/stream` directamente.

## 4. Instalar la extension

1. Abre `chrome://extensions` (o `edge://extensions`, `brave://extensions`).
2. Activa **Modo de desarrollador**.
3. **Cargar descomprimida** y elige la carpeta `extension/`.
4. Fija el icono en la barra.

Para pasarsela a tus amigos: les mandas la carpeta `extension/` (o el zip) y hacen lo mismo.

## 5. Uso

1. En Discord, escribe `/vincular`. El bot te responde (solo a ti) con el servidor y tu token.
2. Abre la extension > *Configuracion* y pega ambos datos. Se guardan.
3. Entra a un canal de voz.
4. Ve a la pestana de YouTube Music, abre la extension y aprieta **Transmitir esta pestana**.
5. El bot entra a tu canal y empieza a sonar. Si te cambias de canal, te sigue.

Mientras transmites, Chrome silencia la pestana en tu PC. Lo normal es escucharla por el bot en Discord, asi la controlas igual que todos. Si prefieres oirla directo, marca *Escucharla tambien en este PC* antes de empezar.

### Comandos

| Comando | Que hace |
|---|---|
| `/vincular` | Te da un token nuevo (el anterior deja de servir) |
| `/desvincular` | Borra tu token y corta tu transmision |
| `/salir` | Detiene la transmision del servidor (quien transmite o alguien con permiso de mover miembros) |
| `/estado` | Muestra quien esta transmitiendo |

## Limitaciones

- Un bot puede estar en un solo canal de voz por servidor, asi que hay **una transmision a la vez por servidor de Discord**. Si alguien mas intenta transmitir, recibe un aviso. Para tener mas en paralelo hay que crear otro bot y levantar otra instancia.
- Hay unos 200 a 500 ms de retraso entre la pestana y Discord. No importa para musica, pero no sirve para sincronizar con video.
- No captura paginas internas del navegador (`chrome://...`) ni la Chrome Web Store.
- Solo navegadores Chromium. Firefox no tiene la API de captura de pestanas que usa la extension.

## Problemas comunes

- **"Token invalido"**: usa `/vincular` de nuevo y pega el token nuevo.
- **"Entra a un canal de voz"**: el bot busca el canal donde estas tu. Tienes que estar en uno y el bot tiene que estar invitado a ese servidor.
- **"No se pudo conectar con el servidor"**: revisa la URL (`wss://` y la ruta `/stream`) y que el proxy reenvie WebSocket. Prueba `https://radio.tudominio.cl/health`.
- **El bot entra pero no suena**: revisa el log del contenedor. Si el reporte de dependencias no muestra `davey`, reinstala con `npm ci` (Discord exige el cifrado DAVE en los canales de voz).
- **Se corta a ratos**: la subida de tu internet o la del servidor no alcanza. Cada transmision usa unos 100 kbps.

## Como funciona por dentro

- La extension pide permiso para la pestana con `chrome.tabCapture` y abre un documento *offscreen* que mantiene la captura aunque cierres el popup.
- Un `AudioWorklet` corta el audio en bloques de 20 ms a 48 kHz estereo y `WebCodecs` los codifica a Opus a 96 kbps, exactamente el formato que usa Discord.
- Cada paquete se manda como un mensaje binario por WebSocket. El servidor no decodifica ni recodifica nada: mete los paquetes directo al reproductor de voz.
- En el servidor hay un buffer pequeno: si la red entrega rafagas, descarta audio viejo para que el retraso no crezca; si hay un hueco, manda silencio en vez de cortar.
- Los tokens se guardan solo como hash SHA-256 en `data/tokens.json`.
