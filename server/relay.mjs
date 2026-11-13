// Saltline 联机中继（哑中继：只做房间表与消息扇出，不跑任何游戏逻辑）
//
// 设计前提：权威在"房主浏览器"里。服务器不知道谁是玩家、谁在哪儿，
// 它只保证同一房间内的消息按连接转发，掉线时把成员变化告诉大家。
//
// 环境变量：
//   PORT=9090            监听端口
//   MAX_ROOMS=16         同时存在的房间上限
//   MAX_PLAYERS=8        单房间人数上限
//   ALLOW_ANY=1          跳过 Origin 校验（仅本地调试用）
//   ORIGIN_HOSTS=...     额外的允许域名，逗号分隔（后缀匹配）

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 9090);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 16);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 8);
const MAX_PAYLOAD = 16 * 1024;
const RATE_LIMIT = 150; // 每秒消息数上限
const HEARTBEAT_MS = 30000;

const ORIGIN_SUFFIXES = [
  'bilibili.com',
  'bilibilitoy.com',
  'jopatk.top',
  ...(process.env.ORIGIN_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

/** @type {Map<string, {code:string, host:number|null, members:Map<number,{id:number,name:string,ws:any}>}>} */
const rooms = new Map();
let nextId = 1;
const startedAt = Date.now();

function isAllowedOrigin(origin) {
  if (process.env.ALLOW_ANY === '1') return true;
  if (!origin) return true; // 非浏览器客户端（脚本、探活）
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return ORIGIN_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

function newCode() {
  for (let attempt = 0; attempt < 64; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function normalizeCode(raw) {
  const up = String(raw || '').toUpperCase();
  let out = '';
  for (const ch of up) {
    if (!ALPHABET.includes(ch)) continue;
    out += ch;
    if (out.length === CODE_LEN) break;
  }
  return out.length === CODE_LEN ? out : '';
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = 0) {
  for (const m of room.members.values()) {
    if (m.id === exceptId) continue;
    send(m.ws, msg);
  }
}

function peersOf(room) {
  return [...room.members.values()]
    .sort((a, b) => a.id - b.id)
    .map((m) => ({ id: m.id, name: m.name, host: m.id === room.host }));
}

function pushPeers(room) {
  const peers = peersOf(room);
  broadcast(room, { t: 'peers', peers });
}

function leaveRoom(client) {
  const room = rooms.get(client.room);
  if (!room) return;
  room.members.delete(client.id);
  if (room.members.size === 0) {
    rooms.delete(room.code);
    log(`房间 ${room.code} 已空，回收（当前 ${rooms.size} 间）`);
    return;
  }
  if (room.host === client.id) {
    room.host = Math.min(...room.members.keys());
    broadcast(room, { t: 'host', id: room.host });
    log(`房间 ${room.code} 房主转移 -> #${room.host}`);
  }
  pushPeers(room);
}

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    let players = 0;
    for (const r of rooms.values()) players += r.members.size;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        players,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('saltline relay\n');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close(4003, 'origin not allowed');
    return;
  }

  const client = { id: 0, name: '', room: '', ws, bucket: RATE_LIMIT, alive: true };
  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    if (--client.bucket < 0) {
      ws.close(4029, 'too many messages');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (client.room) return;
      const wanted = normalizeCode(msg.room);
      let room = wanted ? rooms.get(wanted) : null;
      if (!room) {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { t: 'err', code: 'too-many-rooms' });
          return;
        }
        const code = wanted || newCode();
        if (!code) {
          send(ws, { t: 'err', code: 'too-many-rooms' });
          return;
        }
        room = { code, host: null, members: new Map() };
        rooms.set(code, room);
        log(`新建房间 ${code}（当前 ${rooms.size} 间）`);
      }
      if (room.members.size >= MAX_PLAYERS) {
        send(ws, { t: 'err', code: 'full' });
        return;
      }
      client.id = nextId++;
      client.name = String(msg.name || '').slice(0, 16) || `玩家${client.id}`;
      client.room = room.code;
      room.members.set(client.id, client);
      if (room.host === null) room.host = client.id;
      send(ws, {
        t: 'welcome',
        id: client.id,
        room: room.code,
        host: room.host === client.id,
        peers: peersOf(room),
      });
      pushPeers(room);
      log(`#${client.id} ${client.name} 进入 ${room.code}（${room.members.size} 人）`);
      return;
    }

    const room = rooms.get(client.room);
    if (!room) return;

    if (msg.t === 's') {
      // 状态帧：不排队、不重发，直接扇出
      broadcast(room, { t: 's', from: client.id, p: msg.p }, client.id);
      return;
    }
    if (msg.t === 'e') {
      // 事件：原样转发，由客户端按 seq 去重
      broadcast(room, { t: 'e', from: client.id, k: msg.k, d: msg.d, seq: msg.seq }, client.id);
      return;
    }
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: msg.ts });
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
    if (client.id) log(`#${client.id} 离开`);
  });
  ws.on('error', () => {});
});

// 心跳与令牌桶恢复
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    ws.ping();
  }
}, HEARTBEAT_MS);

setInterval(() => {
  for (const room of rooms.values()) {
    for (const m of room.members.values()) {
      if (m.bucket < RATE_LIMIT) m.bucket = Math.min(RATE_LIMIT, m.bucket + 30);
    }
  }
}, 1000);

httpServer.listen(PORT, () => {
  log(`relay 监听 :${PORT}（房间上限 ${MAX_ROOMS}，单房间 ${MAX_PLAYERS} 人）`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，关闭');
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
