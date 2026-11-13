// 端到端验收（里程碑 1）：一个真实浏览器 + 一个 Node 假队友。
//
// 比开两个浏览器轻得多，但覆盖了完整链路：
//   浏览器 -> net.js -> relay -> 假队友      （自己发的状态能出去）
//   假队友 -> relay -> net.js -> __G.scene  （别人的状态能变成场景里的替身）

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const ROOT = process.cwd();
const HTTP_PORT = Number(process.env.COOP_HTTP_PORT || 8789);
const RELAY_PORT = Number(process.env.COOP_RELAY_PORT || 9192);
const CDP_PORT = Number(process.env.COOP_CDP_PORT || 9334);
const ROOM = 'ABCD';
const TARGET = { x: 12.5, y: 0, z: 7.25, yaw: 1.234 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
};

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of list) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome，可设置 CHROME_PATH');
}

function serve() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
    const p = path.join(ROOT, rel);
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      return res.writeHead(404).end('nf');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => s.listen(HTTP_PORT, '127.0.0.1', () => r(s)));
}

async function waitJson(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('超时: ' + url);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    }),
    close: () => ws.close(),
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error('CDP 超时 ' + method));
        }, 45000);
      });
    },
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
      return r.result?.value;
    },
  };
}

async function openBrowser(url) {
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'sl-coop-'))}`,
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=800,500',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const targets = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  const client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url });
  return { chrome, client };
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' -> ' + detail}`);
  if (!ok) failures += 1;
}

async function until(client, expression, label, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await client.eval(expression)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('等待超时: ' + label);
}

async function main() {
  const server = await serve();
  const relay = spawn(process.execPath, ['server/relay.mjs'], {
    env: { ...process.env, PORT: String(RELAY_PORT), ALLOW_ANY: '1' },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));

  const url = `http://127.0.0.1:${HTTP_PORT}/index.html?q=low&net=ws://127.0.0.1:${RELAY_PORT}&room=${ROOM}`;
  const { chrome, client } = await openBrowser(url);

  const peer = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}`);
    ws.received = 0;
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') ws.welcome = m;
      if (m.t === 's') ws.received += 1;
    });
  });

  try {
    await until(client, `!!(window.__G && window.__G.game && window.__G.player)`, '浏览器启动');
    await until(client, `window.__NET.status === 'online'`, '浏览器联机');
    check('浏览器连上中继并进入房间', true);

    peer.send(JSON.stringify({ t: 'join', room: ROOM, name: '假队友' }));
    await until(client, `window.__NET.peers.length === 2`, '浏览器看到 2 人');
    check('假队友加入后名单变成 2 人', true);

    const roomCode = await client.eval('window.__NET.room');
    check('房间码一致', roomCode === ROOM, `浏览器 ${roomCode}`);

    const sender = setInterval(() => {
      peer.send(JSON.stringify({ t: 's', p: [TARGET.x, TARGET.y, TARGET.z, TARGET.yaw, 0, 100, 1] }));
    }, 50);

    await new Promise((r) => setTimeout(r, 2500));
    check('假队友收到浏览器状态帧', peer.received > 15, 'received=' + peer.received);

    await until(client, `window.__NET.ghosts >= 1`, '浏览器创建替身');
    await until(
      client,
      `(() => { const g = window.__G.scene.children.filter((o) => o.name.startsWith('sl-ghost-'))[0];
        return !!g && Math.abs(g.position.x - ${TARGET.x}) < 0.6; })()`,
      '替身走到目标位置',
      20000,
    );

    const ghost = await client.eval(`
      (() => {
        const g = window.__G.scene.children.filter((o) => o.name.startsWith('sl-ghost-'))[0];
        if (!g) return null;
        return { x: +g.position.x.toFixed(2), y: +g.position.y.toFixed(2), z: +g.position.z.toFixed(2),
                 ry: +g.rotation.y.toFixed(3), visible: g.visible };
      })()`);
    check(
      '替身出现在假队友的位置',
      !!ghost && Math.abs(ghost.x - TARGET.x) < 0.6 && Math.abs(ghost.z - TARGET.z) < 0.6,
      JSON.stringify(ghost),
    );
    check('替身朝向同步', !!ghost && Math.abs(ghost.ry - TARGET.yaw) < 0.15, JSON.stringify(ghost));
    check('替身可见', !!ghost && ghost.visible === true, JSON.stringify(ghost));

    clearInterval(sender);
    peer.close();
    await until(client, `window.__NET.peers.length === 1`, '名单回到 1 人', 20000);
    await until(client, `window.__NET.ghosts === 0`, '替身被清理', 20000);
    check('假队友离开后替身被清理', true);
  } finally {
    chrome.kill();
    relay.kill();
    server.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n端到端有 ${failures} 项不通过` : '\n端到端全部通过');
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error('端到端异常:', e.message);
    process.exit(1);
  });
