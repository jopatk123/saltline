// 契约测试：在没有真实显卡的 headless Chrome 里把游戏跑起来，
// 断言 net.js 依赖的 window.__G 契约还在——game.js 一旦重新导出、内部改名，
// 这里会先报错，而不是等上线后玩家点「联机」才发现。
//
// 说明：headless 必须带 --autoplay-policy=no-user-gesture-required，
// 否则启动会卡在 audio 阶段，__G.player 永远是 null。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const ROOT = process.cwd();
const PORT = Number(process.env.TEST_HTTP_PORT || 8788);
const CDP_PORT = Number(process.env.TEST_CDP_PORT || 9333);
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT || 90000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到 Chrome，可设置 CHROME_PATH 环境变量');
}

function serve() {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function waitForJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('CDP 端口没有就绪: ' + url);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  return {
    ready,
    close: () => ws.close(),
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('CDP 超时: ' + method));
          }
        }, 15000);
      });
    },
  };
}

const CHECKS = [
  ['__G.player.pos.x', 'number'],
  ['__G.player.yaw', 'number'],
  ['__G.player.health', 'number'],
  ['__G.input.move', 'object'],
  ['__G.input.setGameplay', 'function'],
  ['__G.enemies.list', 'object'],
  ['__G.hud.setRelays', 'function'],
  ['__G.combat.playerShot', 'function'],
  ['__G.game.state', 'string'],
  ['__G.game.start', 'function'],
  ['__G.scene.add', 'function'],
  ['__G.THREE.CapsuleGeometry', 'function'],
];

const PROBE = `(() => {
  const G = window.__G || {};
  const pick = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), window);
  const out = {};
  for (const [p] of ${JSON.stringify(CHECKS)}) {
    let v, err = '';
    try { v = pick(p); } catch (e) { err = e.message; }
    out[p] = err ? 'throw:' + err : (v === null ? 'null' : typeof v);
  }
  out['boot'] = !!(G.game && G.player && G.player.pos);
  out['net'] = !!(window.__NET && typeof window.__NET.join === 'function');
  out['netPanel'] = !!document.querySelector('.sl-net');
  return JSON.stringify(out);
})()`;

async function main() {
  const server = await serve();
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-cdp-'))}`,
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有找到页面目标');

    const client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

    const t0 = Date.now();
    let probe = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
      const r = await client.send('Runtime.evaluate', {
        expression: PROBE,
        returnByValue: true,
      });
      probe = JSON.parse(r.result.value);
      if (probe.boot) break;
      await new Promise((res) => setTimeout(res, 500));
    }

    if (!probe || !probe.boot) {
      throw new Error(`游戏在 ${TIMEOUT_MS}ms 内未能启动（__G.game / __G.player 未就绪）`);
    }

    let failures = 0;
    for (const [p, want] of CHECKS) {
      const got = probe[p];
      const ok = got === want;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${p} 期望 ${want}，实际 ${got}`);
    }
    for (const key of ['net', 'netPanel']) {
      const ok = probe[key] === true;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key}`);
    }

    client.close();
    console.log(failures ? `\n契约有 ${failures} 项不满足` : '\n契约全部通过');
    return failures;
  } finally {
    chrome.kill();
    server.close();
  }
}

main()
  .then((f) => process.exit(f ? 1 : 0))
  .catch((e) => {
    console.error('契约测试异常:', e.message);
    process.exit(1);
  });
