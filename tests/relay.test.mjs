// 中继冒烟测试：两个客户端进同一房间，状态帧与事件都要被转发；
// 房主掉线后要自动转移房主，房间空了要回收。

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = Number(process.env.TEST_PORT || 9191);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function waitFor(fn, timeout = 5000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        reject(new Error('等待超时: ' + label));
      }
    }, 50);
  });
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function main() {
  console.log('启动中继…');
  child = spawn(process.execPath, ['server/relay.mjs'], {
    env: { ...process.env, PORT: String(PORT), ALLOW_ANY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[relay] ' + d));
  await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 400));

  const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
  check('健康检查可用', health.ok === true, JSON.stringify(health));

  const a = await connect();
  const b = await connect();

  a.send(JSON.stringify({ t: 'join', room: 'TEST', name: '甲' }));
  const wa = await waitForMsg(a, (m) => m.t === 'welcome');
  check('房主进入房间', wa.host === true && wa.room === 'TEST', JSON.stringify(wa));

  b.send(JSON.stringify({ t: 'join', room: 'TEST', name: '乙' }));
  const wb = await waitForMsg(b, (m) => m.t === 'welcome');
  check('第二人加入同一房间', wb.host === false, JSON.stringify(wb));
  check('房间码一致', wa.room === wb.room);

  const peersB = await waitForMsg(b, (m) => m.t === 'peers' && m.peers.length === 2);
  check('房间名单推送到位', peersB.peers.length === 2, JSON.stringify(peersB));

  b.inbox.length = 0;
  a.send(JSON.stringify({ t: 's', p: [1, 2, 3, 0.5, 0, 100, 1] }));
  const st = await waitForMsg(b, (m) => m.t === 's');
  check('状态帧被转发给队友', st.from === wa.id && st.p[0] === 1, JSON.stringify(st));

  a.inbox.length = 0;
  b.send(JSON.stringify({ t: 'e', k: 'shot', d: { n: 1 }, seq: 7 }));
  const ev = await waitForMsg(a, (m) => m.t === 'e');
  check('事件被转发给房主', ev.k === 'shot' && ev.seq === 7, JSON.stringify(ev));

  a.close();
  const promoted = await waitForMsg(b, (m) => m.t === 'host');
  check('房主掉线后转移房主', promoted.id === wb.id, JSON.stringify(promoted));

  const peersAfter = await waitForMsg(b, (m) => m.t === 'peers' && m.peers.length === 1);
  check('名单收缩到 1 人', peersAfter.peers.length === 1);

  b.close();
  await new Promise((r) => setTimeout(r, 300));
  const after = await fetch(`${BASE}/healthz`).then((r) => r.json());
  check('空房间被回收', after.rooms === 0 && after.players === 0, JSON.stringify(after));
}

function waitForMsg(ws, pred, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const i = ws.inbox.findIndex(pred);
      if (i >= 0) {
        const msg = ws.inbox[i];
        ws.inbox.splice(i, 1);
        clearInterval(iv);
        resolve(msg);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        reject(new Error('没等到期望的消息: ' + pred.toString()));
      }
    }, 30);
  });
}

main()
  .then(() => {
    console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
    child?.kill();
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error('测试异常:', e.message);
    child?.kill();
    process.exit(1);
  });
