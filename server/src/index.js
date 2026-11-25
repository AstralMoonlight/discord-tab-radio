import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig } from './config.js';
import { TokenStore } from './tokens.js';
import { SessionManager } from './sessions.js';
import { startRelay } from './relay.js';
import { log } from './log.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('vincular')
    .setDescription('Genera tu token para la extension Tab Radio (invalida el anterior)'),
  new SlashCommandBuilder()
    .setName('desvincular')
    .setDescription('Borra tu token: la extension deja de poder transmitir con tu cuenta'),
  new SlashCommandBuilder()
    .setName('salir')
    .setDescription('Detiene la transmision en este servidor y saca al bot del canal'),
  new SlashCommandBuilder().setName('estado').setDescription('Muestra quien esta transmitiendo en este servidor'),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const tokens = new TokenStore(config.dataDir);
const sessions = new SessionManager(client, {
  maxBufferMs: config.maxBufferMs,
  prebufferMs: config.prebufferMs,
});

client.once(Events.ClientReady, async (c) => {
  log.info(`Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidor(es)`);
  try {
    await c.application.commands.set(commands);
    log.info('Comandos registrados: /vincular /desvincular /salir /estado');
  } catch (err) {
    log.error('No se pudieron registrar los comandos:', err.message);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => sessions.handleVoiceState(oldState, newState));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const ephemeral = { flags: MessageFlags.Ephemeral };

  try {
    switch (interaction.commandName) {
      case 'vincular': {
        const token = await tokens.issue(interaction.user.id);
        const url = config.publicUrl
          ? `**Servidor:** \`${config.publicUrl}\`\n`
          : '';
        await interaction.reply({
          ...ephemeral,
          content:
            `Pega esto en la extension Tab Radio:\n${url}**Token:** \`${token}\`\n\n` +
            'No lo compartas: con el, cualquiera puede transmitir a tu nombre. ' +
            'Si se filtra, usa /vincular de nuevo y el anterior deja de servir.',
        });
        break;
      }

      case 'desvincular': {
        const existed = await tokens.revoke(interaction.user.id);
        for (const s of [...sessions.byGuild.values()]) {
          if (s.userId === interaction.user.id) s.destroy('Token borrado con /desvincular');
        }
        await interaction.reply({
          ...ephemeral,
          content: existed ? 'Listo, tu token fue borrado.' : 'No tenias un token activo.',
        });
        break;
      }

      case 'salir': {
        if (!interaction.inGuild()) {
          await interaction.reply({ ...ephemeral, content: 'Este comando se usa dentro de un servidor.' });
          break;
        }
        const session = sessions.get(interaction.guildId);
        if (!session) {
          await interaction.reply({ ...ephemeral, content: 'No hay ninguna transmision en este servidor.' });
          break;
        }
        const canForce = interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers);
        if (session.userId !== interaction.user.id && !canForce) {
          await interaction.reply({
            ...ephemeral,
            content: 'Solo quien transmite o alguien con permiso de mover miembros puede detenerla.',
          });
          break;
        }
        session.destroy(`Detenido por ${interaction.user.displayName} con /salir`);
        await interaction.reply({ content: 'Transmision detenida.' });
        break;
      }

      case 'estado': {
        const session = interaction.inGuild() ? sessions.get(interaction.guildId) : null;
        if (!session) {
          await interaction.reply({ ...ephemeral, content: 'No hay ninguna transmision en este servidor.' });
          break;
        }
        const mins = Math.floor((Date.now() - session.startedAt) / 60000);
        await interaction.reply({
          ...ephemeral,
          content: `<@${session.userId}> esta transmitiendo en <#${session.channel.id}> hace ${mins} min.`,
          allowedMentions: { parse: [] },
        });
        break;
      }
    }
  } catch (err) {
    log.error(`Comando /${interaction.commandName}:`, err);
    const reply = { ...ephemeral, content: 'Algo fallo al ejecutar el comando.' };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

async function main() {
  log.info('Dependencias de voz:\n' + generateDependencyReport());
  await tokens.load();
  const relay = startRelay({ port: config.port, tokens, sessions });
  await client.login(config.discordToken);

  const shutdown = (signal) => {
    log.info(`Recibido ${signal}, cerrando...`);
    sessions.stopAll('El servidor se esta reiniciando');
    relay.wss.close();
    relay.server.close();
    client.destroy().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
