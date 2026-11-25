import { Readable } from 'node:stream';
import { PermissionFlagsBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} from '@discordjs/voice';
import { log } from './log.js';

const FRAME_MS = 20; // la extension manda paquetes Opus de 20 ms, lo mismo que espera Discord
const MAX_PACKET_BYTES = 4000;

/**
 * Cola de paquetes Opus que lee el AudioPlayer (saca uno cada 20 ms).
 * Si la red entrega rafagas o el reloj del navegador va un poco mas rapido,
 * la cola crece; cuando pasa el maximo se descarta lo mas viejo para que
 * la latencia no se vaya acumulando.
 */
export class OpusFeed extends Readable {
  constructor({ maxFrames, targetFrames }) {
    super({ objectMode: true, highWaterMark: 4096 });
    this.maxFrames = maxFrames;
    this.targetFrames = targetFrames;
    this.dropped = 0;
  }

  _read() {}

  feed(packet) {
    if (this.readableEnded || this.destroyed) return;
    this.push(packet);
    if (this.readableLength > this.maxFrames) {
      while (this.readableLength > this.targetFrames) {
        this.read();
        this.dropped++;
      }
    }
  }

  finish() {
    if (!this.readableEnded && !this.destroyed) this.push(null);
  }
}

/** Busca en que canal de voz esta el usuario, en cualquier servidor donde este el bot. */
function findUserVoiceChannel(client, userId) {
  for (const guild of client.guilds.cache.values()) {
    const state = guild.voiceStates.cache.get(userId);
    if (state?.channel) return state.channel;
  }
  return null;
}

class Session {
  constructor({ channel, userId, options, onEnd }) {
    this.guild = channel.guild;
    this.channel = channel;
    this.userId = userId;
    this.options = options;
    this.onEnd = onEnd;
    this.prebuffer = [];
    this.feed = null;
    this.ended = false;
    this.startedAt = Date.now();
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Puede ser un cambio de canal o una reconexion normal; si no vuelve en 5 s, se termina.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy('El bot fue desconectado del canal de voz');
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy('Conexion de voz cerrada'));
    this.connection.on('error', (err) => log.error('Conexion de voz:', err.message));

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.destroy('No se pudo conectar al canal de voz');
      throw new Error('No se pudo conectar al canal de voz (tiempo agotado)');
    }

    this.player = createAudioPlayer({
      behaviors: {
        // Seguir sonando aunque nadie escuche y no cortar por huecos de red
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: Number.POSITIVE_INFINITY,
      },
    });
    this.player.on('error', (err) => log.error('Reproductor:', err.message));
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.ended) this.destroy('La reproduccion se detuvo');
    });
    this.connection.subscribe(this.player);
  }

  pushPacket(packet) {
    if (this.ended || !this.player) return;
    if (packet.length === 0 || packet.length > MAX_PACKET_BYTES) return;

    if (!this.feed) {
      this.prebuffer.push(packet);
      if (this.prebuffer.length * FRAME_MS >= this.options.prebufferMs) {
        const maxFrames = Math.max(5, Math.round(this.options.maxBufferMs / FRAME_MS));
        this.feed = new OpusFeed({ maxFrames, targetFrames: Math.max(3, Math.round(maxFrames / 2)) });
        for (const p of this.prebuffer) this.feed.feed(p);
        this.prebuffer = [];
        this.player.play(createAudioResource(this.feed, { inputType: StreamType.Opus }));
      }
      return;
    }
    this.feed.feed(packet);
  }

  moveTo(channel) {
    if (this.ended || channel.id === this.channel.id) return;
    this.channel = channel;
    this.connection.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
  }

  destroy(reason) {
    if (this.ended) return;
    this.ended = true;
    this.feed?.finish();
    try {
      this.player?.stop(true);
    } catch {}
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    const dropped = this.feed?.dropped ?? 0;
    const mins = ((Date.now() - this.startedAt) / 60000).toFixed(1);
    log.info(`Fin de transmision en "${this.guild.name}" (${mins} min, ${dropped} paquetes descartados): ${reason}`);
    this.onEnd?.(reason);
  }
}

export class SessionManager {
  constructor(client, options) {
    this.client = client;
    this.options = options;
    this.byGuild = new Map();
  }

  get count() {
    return this.byGuild.size;
  }

  get(guildId) {
    return this.byGuild.get(guildId) ?? null;
  }

  /** Empieza una transmision en el canal de voz donde este el usuario. */
  async start({ userId, onEnd }) {
    const channel = findUserVoiceChannel(this.client, userId);
    if (!channel) throw new Error('Entra a un canal de voz en Discord y vuelve a intentar');

    // Un usuario solo puede estar en un canal a la vez: si ya transmitia en otro lado, se reemplaza
    for (const session of this.byGuild.values()) {
      if (session.userId === userId) session.destroy('Reemplazada por una transmision nueva');
    }

    const busy = this.byGuild.get(channel.guild.id);
    if (busy) {
      const member = await channel.guild.members.fetch(busy.userId).catch(() => null);
      throw new Error(`Ya hay una transmision en este servidor (de ${member?.displayName ?? 'otro usuario'})`);
    }

    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error(`El bot no tiene permiso para entrar o hablar en "${channel.name}"`);
    }
    if (!channel.joinable) throw new Error(`El canal "${channel.name}" esta lleno o no se puede entrar`);

    const session = new Session({
      channel,
      userId,
      options: this.options,
      onEnd: (reason) => {
        if (this.byGuild.get(channel.guild.id) === session) this.byGuild.delete(channel.guild.id);
        onEnd?.(reason);
      },
    });
    this.byGuild.set(channel.guild.id, session);

    try {
      await session.start();
    } catch (err) {
      session.destroy(err.message);
      throw err;
    }
    log.info(`Transmitiendo en "${channel.guild.name}" / "${channel.name}" (usuario ${userId})`);
    return session;
  }

  /** Mantiene la sesion al dia cuando el usuario o el bot cambian de canal. */
  handleVoiceState(oldState, newState) {
    const session = this.byGuild.get(newState.guild.id);
    if (!session || session.ended) return;

    // El que transmite se cambio de canal: el bot lo sigue
    if (newState.id === session.userId && newState.channel && newState.channelId !== session.channel.id) {
      session.moveTo(newState.channel);
      return;
    }
    // Alguien movio al bot a otro canal a mano
    if (newState.id === this.client.user.id && newState.channel && newState.channelId !== session.channel.id) {
      session.channel = newState.channel;
    }
  }

  stopAll(reason) {
    for (const session of [...this.byGuild.values()]) session.destroy(reason);
  }
}
