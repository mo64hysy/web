import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocket, WebSocketServer } from 'ws';
import prism from 'prism-media';
import {
  Client, GatewayIntentBits, Events, REST, Routes,
  PermissionFlagsBits, ChannelType
} from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  EndBehaviorType, joinVoiceChannel, NoSubscriberBehavior, StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:' + port).replace(/\/$/, '');
const dbPath = process.env.DATABASE_PATH || path.join(rootDir, 'data', 'bridge.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS guest_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
`);

const rooms = new Map();
const sessions = new Map();
const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(publicDir));
const joinLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let raw = '';
  const bytes = crypto.randomBytes(8);
  for (const byte of bytes) raw += codeAlphabet[byte % codeAlphabet.length];
  return raw.slice(0, 4) + '-' + raw.slice(4);
}
function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function safeName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}
function participantList(room) {
  const guild = room.guild;
  const discordNames = guild.voiceStates.cache
    .filter(state => state.channelId === room.channelId && state.member && !state.member.user.bot)
    .map(state => ({ name: state.member.displayName, source: 'discord' }));
  const guests = [...room.clients]
    .filter(ws => ws.readyState === WebSocket.OPEN)
    .map(ws => ({ name: ws.guestName, source: 'guest' }));
  return [...discordNames, ...guests];
}
function broadcastParticipants(room) {
  const message = JSON.stringify({ type: 'participants', participants: participantList(room) });
  for (const ws of room.clients) if (ws.readyState === WebSocket.OPEN) ws.send(message);
}
function broadcastAudio(room, pcm, except = null) {
  for (const ws of room.clients) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
  }
}
function closeRoom(room, reason = '管理者が接続を終了しました') {
  clearInterval(room.mixTimer);
  for (const ws of room.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'closed', reason }));
      ws.close(1000, 'room closed');
    }
  }
  room.clients.clear();
  try { room.encoder.end(); } catch {}
  try { room.player.stop(true); } catch {}
  try { room.connection.destroy(); } catch {}
  if (rooms.get(room.guildId) === room) rooms.delete(room.guildId);
}
async function ensureRoom(guild, channel) {
  const existing = rooms.get(guild.id);
  if (existing) {
    if (existing.channelId !== channel.id) {
      throw new Error('このサーバーでは既に別のVCに接続しています。先に /guest-close で終了してください。');
    }
    return existing;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    connection.destroy();
    throw new Error('VCに接続できませんでした。Botに「接続」「発言」権限があるか確認してください。');
  }

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 1, frameSize: 960 });
  const resource = createAudioResource(encoder, { inputType: StreamType.Opus });
  connection.subscribe(player);
  player.play(resource);
  player.on('error', error => console.error('[voice player]', error));

  const room = {
    guild, guildId: guild.id, channelId: channel.id, channelName: channel.name,
    connection, player, encoder, clients: new Set(), decoders: new Map(), mixTimer: null
  };
  rooms.set(guild.id, room);

  connection.receiver.speaking.on('start', userId => {
    if (room.decoders.has(userId)) return;
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 }
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
    room.decoders.set(userId, decoder);
    opusStream.pipe(decoder);
    decoder.on('data', pcm => broadcastAudio(room, pcm));
    const cleanup = () => {
      room.decoders.delete(userId);
      try { decoder.destroy(); } catch {}
    };
    opusStream.once('close', cleanup);
    opusStream.once('error', cleanup);
    decoder.once('error', cleanup);
  });

  room.mixTimer = setInterval(() => {
    if (rooms.get(guild.id) !== room) return;
    const mixed = Buffer.alloc(1920);
    const samples = new Int32Array(960);
    for (const ws of room.clients) {
      const frame = ws.audioQueue && ws.audioQueue.length ? ws.audioQueue.shift() : null;
      if (!frame || frame.length !== 1920) continue;
      for (let i = 0; i < 960; i++) samples[i] += frame.readInt16LE(i * 2);
    }
    for (let i = 0; i < 960; i++) {
      const sample = Math.max(-32768, Math.min(32767, samples[i]));
      mixed.writeInt16LE(sample, i * 2);
    }
    if (!encoder.write(mixed)) {
      // The encoder's internal stream handles backpressure; one frame is intentionally dropped.
    }
  }, 20);

  connection.on('error', error => console.error('[voice connection]', error));
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (rooms.get(guild.id) === room) closeRoom(room, 'Discord VCとの接続が終了しました');
  });
  return room;
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/api/join', joinLimiter, async (req, res) => {
  const name = safeName(req.body?.name);
  const code = normalizeCode(req.body?.code);
  if (name.length < 1) return res.status(400).json({ error: 'ニックネームを入力してください。' });
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return res.status(400).json({ error: '参加コードを確認してください。' });

  const row = db.prepare('SELECT * FROM guest_codes WHERE code_hash = ?').get(sha256(code));
  const now = Date.now();
  if (!row || row.revoked_at || row.expires_at <= now || row.uses >= row.max_uses) {
    return res.status(403).json({ error: 'コードが無効、期限切れ、または使用上限に達しています。' });
  }
  const room = rooms.get(row.guild_id);
  if (!room || room.channelId !== row.channel_id) {
    return res.status(503).json({ error: '対象のVCが現在開いていません。Discord側で管理者に確認してください。' });
  }
  if (room.clients.size >= row.max_uses) {
    return res.status(403).json({ error: '現在のゲスト参加人数が上限に達しています。' });
  }

  const updated = db.prepare(`
    UPDATE guest_codes SET uses = uses + 1
    WHERE code_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses
  `).run(sha256(code), now);
  if (!updated.changes) return res.status(403).json({ error: 'コードが使用済み、または無効になりました。' });

  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { guildId: row.guild_id, channelId: row.channel_id, name, expiresAt: now + 10 * 60_000 });
  res.json({ token, channelName: row.channel_name, guestName: name });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token');
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return socket.destroy();
  sessions.delete(token);
  const room = rooms.get(session.guildId);
  if (!room || room.channelId !== session.channelId) return socket.destroy();

  wss.handleUpgrade(request, socket, head, ws => {
    ws.guestName = session.name;
    ws.audioQueue = [];
    room.clients.add(ws);
    ws.send(JSON.stringify({ type: 'joined', channelName: room.channelName }));
    broadcastParticipants(room);
    ws.on('message', (data, isBinary) => {
      if (!isBinary || !Buffer.isBuffer(data) || data.length !== 1920) return;
      if (ws.audioQueue.length < 8) ws.audioQueue.push(data);
      broadcastAudio(room, data, ws);
    });
    ws.on('close', () => {
      room.clients.delete(ws);
      broadcastParticipants(room);
    });
    ws.on('error', error => console.error('[guest websocket]', error));
  });
});

const commandDefinitions = [
  {
    name: 'guest-create',
    description: '指定VC用のゲスト参加コードを発行します',
    options: [
      { type: 7, name: 'channel', description: '接続先のボイスチャンネル', required: true, channel_types: [2] },
      { type: 4, name: 'expires_minutes', description: '有効期限（分・10〜1440）', required: false, min_value: 10, max_value: 1440 },
      { type: 4, name: 'max_uses', description: '参加できる累計人数（1〜30）', required: false, min_value: 1, max_value: 30 }
    ]
  },
  {
    name: 'guest-revoke',
    description: 'ゲスト参加コードを無効化します',
    options: [{ type: 3, name: 'code', description: '無効化する参加コード', required: true }]
  },
  { name: 'guest-list', description: '発行済みのゲスト参加コードを確認します' },
  {
    name: 'guest-close',
    description: 'VCのゲスト受付を停止し、Botを退出させます',
    options: [{ type: 7, name: 'channel', description: '終了するボイスチャンネル', required: true, channel_types: [2] }]
  }
];

async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[bot] DISCORD_BOT_TOKEN is not set; web server will run without Discord commands.');
    return;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.once(Events.ClientReady, async readyClient => {
    console.log('[bot] Logged in as ' + readyClient.user.tag);
    const rest = new REST({ version: '10' }).setToken(token);
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(readyClient.user.id, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(readyClient.user.id);
    try {
      await rest.put(route, { body: commandDefinitions });
      console.log('[bot] Slash commands registered.');
    } catch (error) {
      console.error('[bot] Could not register slash commands:', error);
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const room = rooms.get(newState.guild.id);
    if (room && (oldState.channelId === room.channelId || newState.channelId === room.channelId)) {
      broadcastParticipants(room);
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'このコマンドにはサーバー管理権限が必要です。', ephemeral: true });
    }
    try {
      if (interaction.commandName === 'guest-create') {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.type !== ChannelType.GuildVoice) {
          return interaction.reply({ content: '通常のボイスチャンネルを指定してください。', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        await ensureRoom(interaction.guild, channel);
        const expiresMinutes = interaction.options.getInteger('expires_minutes') || 180;
        const maxUses = interaction.options.getInteger('max_uses') || 5;
        const code = makeCode();
        const now = Date.now();
        db.prepare(`
          INSERT INTO guest_codes (code_hash, guild_id, channel_id, channel_name, created_by, created_at, expires_at, max_uses)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sha256(normalizeCode(code)), interaction.guildId, channel.id, channel.name,
          interaction.user.id, now, now + expiresMinutes * 60_000, maxUses);
        return interaction.editReply(
          '参加コード: **' + code + '**\n接続先: **' + channel.name + '**\n有効期限: ' +
          expiresMinutes + '分\n参加上限: ' + maxUses + '人\n参加URL: ' + baseUrl +
          '\n\nこのコードは発行時にだけ表示されます。必要な相手に安全な方法で共有してください。'
        );
      }

      if (interaction.commandName === 'guest-revoke') {
        const code = normalizeCode(interaction.options.getString('code', true));
        const result = db.prepare('UPDATE guest_codes SET revoked_at = ? WHERE code_hash = ? AND guild_id = ? AND revoked_at IS NULL')
          .run(Date.now(), sha256(code), interaction.guildId);
        return interaction.reply({ content: result.changes ? '参加コードを無効化しました。' : '有効なコードが見つかりません。', ephemeral: true });
      }

      if (interaction.commandName === 'guest-list') {
        const rows = db.prepare(`
          SELECT channel_name, expires_at, max_uses, uses
          FROM guest_codes
          WHERE guild_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses
          ORDER BY created_at DESC LIMIT 20
        `).all(interaction.guildId, Date.now());
        const text = rows.length
          ? rows.map(row => '• ' + row.channel_name + ' — ' + row.uses + '/' + row.max_uses + '人 — <t:' + Math.floor(row.expires_at / 1000) + ':R>').join('\n')
          : '有効な参加コードはありません。';
        return interaction.reply({ content: text, ephemeral: true });
      }

      if (interaction.commandName === 'guest-close') {
        const channel = interaction.options.getChannel('channel', true);
        db.prepare('UPDATE guest_codes SET revoked_at = ? WHERE guild_id = ? AND channel_id = ? AND revoked_at IS NULL')
          .run(Date.now(), interaction.guildId, channel.id);
        const room = rooms.get(interaction.guildId);
        if (room && room.channelId === channel.id) closeRoom(room);
        return interaction.reply({ content: channel.name + ' のゲスト受付を終了しました。', ephemeral: true });
      }
    } catch (error) {
      console.error('[command]', error);
      const message = error?.message || '処理に失敗しました。';
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply('エラー: ' + message);
      }
      return interaction.reply({ content: 'エラー: ' + message, ephemeral: true });
    }
  });

  await client.login(token);
}

server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log('[web] Listening on port ' + port);
  startBot().catch(error => {
    console.error('[bot] Startup failed:', error);
    process.exitCode = 1;
  });
});
