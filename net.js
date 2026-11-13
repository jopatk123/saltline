// Saltline 联机层（里程碑 1：房间 + 玩家位置同步）
//
// 不修改 game.js，只通过它已经暴露的启动上下文 window.__G 取状态、写表现：
//   __G.player  第一人称玩家状态（pos / yaw / pitch / health / alive ...）
//   __G.scene   Three.js 场景，用来挂远端玩家的替身模型
//   __G.game    state / start / pause ...
//   __G.THREE   Three.js 命名空间
//
// 权威模型：房主浏览器跑现有游戏逻辑，其他客户端只显示房主广播来的状态。
// 这一版只同步玩家位置，敌人与任务进度留到里程碑 2 / 3。

(() => {
  'use strict';
  if (window.__NET) return;

  const VERSION = 1;
  const TICK_MS = 50; // 20 Hz
  const INTERP_MS = 100; // 远端插值延迟
  const PALETTE = [0xffd166, 0x8ecae6, 0xef8354, 0xa1c181, 0xb392e0, 0x6bc5c9];

  const qs = new URLSearchParams(location.search);
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const endpointParam = qs.get('net');
  const ENDPOINT =
    endpointParam && endpointParam !== '1'
      ? endpointParam
      : isLocalHost
        ? 'ws://127.0.0.1:9090'
        : 'wss://saltline.jopatk.top/ws';

  const net = {
    version: VERSION,
    endpoint: ENDPOINT,
    status: 'idle',
    id: 0,
    room: '',
    host: false,
    peers: [],
    sent: 0,
    recv: 0,
    ghosts: 0,
    lastError: '',
    sendEvent: null,
    join,
    leave,
  };
  window.__NET = net;

  let ws = null;
  let tickTimer = 0;
  let retries = 0;
  let wantOnline = false;
  const ghosts = new Map(); // id -> {group, capsule, visor, samples: []}
  const peerNames = new Map();

  // ---------- UI ----------

  const style = document.createElement('style');
  style.textContent = `
.sl-net{position:fixed;left:16px;bottom:16px;z-index:2147483000;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:#e8e4d9;background:rgba(18,20,22,.86);border:1px solid rgba(232,228,217,.18);border-radius:10px;
  padding:8px 10px;min-width:190px;backdrop-filter:blur(6px);user-select:none}
.sl-net.collapsed .sl-net-body{display:none}
.sl-net-head{display:flex;align-items:center;gap:6px;cursor:pointer}
.sl-net-dot{width:7px;height:7px;border-radius:50%;background:#8a8a8a;flex:0 0 auto}
.sl-net.online .sl-net-dot{background:#7dc47d}
.sl-net.connecting .sl-net-dot{background:#d9b45a}
.sl-net-title{font-weight:600;letter-spacing:.02em}
.sl-net-body{margin-top:7px;display:flex;flex-direction:column;gap:6px}
.sl-net-row{display:flex;gap:5px}
.sl-net input{width:78px;background:rgba(255,255,255,.07);border:1px solid rgba(232,228,217,.22);
  border-radius:6px;color:inherit;padding:3px 6px;font:inherit;letter-spacing:.08em;text-transform:uppercase}
.sl-net input:focus{outline:none;border-color:rgba(232,228,217,.5)}
.sl-net button{background:rgba(232,228,217,.1);border:1px solid rgba(232,228,217,.22);border-radius:6px;
  color:inherit;padding:3px 9px;font:inherit;cursor:pointer}
.sl-net button:hover{background:rgba(232,228,217,.18)}
.sl-net-meta{color:#a9a49a;font-size:11px}
.sl-net-peers{color:#cfcabd;font-size:11px;word-break:break-all}
`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'sl-net collapsed';
  root.innerHTML = `
<div class="sl-net-head"><span class="sl-net-dot"></span><span class="sl-net-title">联机</span>
  <span class="sl-net-meta" style="margin-left:auto">▾</span></div>
<div class="sl-net-body">
  <div class="sl-net-row"><input class="sl-net-code" maxlength="4" placeholder="房间码 4 位" />
    <button class="sl-net-join">进入</button><button class="sl-net-leave">离开</button></div>
  <div class="sl-net-status sl-net-meta">未联机</div>
  <div class="sl-net-peers"></div>
</div>`;
  document.body.appendChild(root);

  const $code = root.querySelector('.sl-net-code');
  const $status = root.querySelector('.sl-net-status');
  const $peers = root.querySelector('.sl-net-peers');
  const $join = root.querySelector('.sl-net-join');
  const $leave = root.querySelector('.sl-net-leave');

  for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup', 'wheel']) {
    root.addEventListener(ev, (e) => e.stopPropagation(), true);
  }
  root.querySelector('.sl-net-head').addEventListener('click', () => {
    root.classList.toggle('collapsed');
  });
  $code.addEventListener('input', () => {
    $code.value = $code.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 4);
  });
  $join.addEventListener('click', () => join($code.value));
  $leave.addEventListener('click', () => leave(true));
  $code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join($code.value);
  });

  function paint() {
    root.classList.toggle('online', net.status === 'online');
    root.classList.toggle('connecting', net.status === 'connecting');
    if (net.status === 'online') {
      $status.textContent = `已连接 · ${net.room}${net.host ? ' · 房主' : ''} · ${net.peers.length} 人`;
      $peers.textContent = net.peers.map((p) => p.name + (p.host ? '(主)' : '')).join('、');
    } else if (net.status === 'connecting') {
      $status.textContent = '连接中…';
      $peers.textContent = '';
    } else if (net.status === 'error') {
      $status.textContent = net.lastError || '连接失败';
      $peers.textContent = '';
    } else {
      $status.textContent = '未联机';
      $peers.textContent = '';
    }
  }
  paint();

  // ---------- 连接 ----------

  function join(code) {
    if (net.status === 'online' || net.status === 'connecting') return;
    wantOnline = true;
    retries = 0;
    open(String(code || '').toUpperCase());
  }

  function open(code) {
    net.status = 'connecting';
    net.lastError = '';
    paint();
    let sock;
    try {
      sock = new WebSocket(ENDPOINT);
    } catch (e) {
      fail('地址无效：' + ENDPOINT);
      return;
    }
    ws = sock;
    const joinCode = code;

    sock.onopen = () => {
      sock.send(JSON.stringify({ t: 'join', room: joinCode }));
    };
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(msg);
    };
    sock.onclose = () => {
      const wasOnline = net.status === 'online';
      stopTicker();
      clearGhosts();
      net.status = wantOnline ? 'error' : 'idle';
      net.host = false;
      net.peers = [];
      paint();
      if (wantOnline && wasOnline && retries < 3) {
        retries += 1;
        net.lastError = `连接断开，第 ${retries} 次重连…`;
        paint();
        setTimeout(() => wantOnline && open(net.room), 1500 * retries);
      } else if (wantOnline) {
        net.lastError = '与中继的连接已断开';
        wantOnline = false;
        paint();
      }
    };
    sock.onerror = () => {};
  }

  function fail(text) {
    net.status = 'error';
    net.lastError = text;
    wantOnline = false;
    paint();
  }

  function leave(manual) {
    wantOnline = false;
    retries = 0;
    stopTicker();
    clearGhosts();
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    net.status = 'idle';
    net.host = false;
    net.room = '';
    net.peers = [];
    paint();
    if (manual) $code.value = '';
  }

  function handle(msg) {
    if (msg.t === 'welcome') {
      net.status = 'online';
      net.id = msg.id;
      net.room = msg.room;
      net.host = !!msg.host;
      net.peers = msg.peers || [];
      $code.value = net.room;
      startTicker();
      paint();
    } else if (msg.t === 'peers') {
      net.peers = msg.peers || [];
      syncGhosts();
      paint();
    } else if (msg.t === 'host') {
      net.host = msg.id === net.id;
      paint();
    } else if (msg.t === 's') {
      net.recv += 1;
      onPeerState(msg.from, msg.p);
    } else if (msg.t === 'e') {
      net.recv += 1;
      if (net.onEvent) net.onEvent(msg);
    } else if (msg.t === 'err') {
      const map = { full: '房间已满', 'too-many-rooms': '服务器房间已满', 'bad-code': '房间码不合法' };
      fail(map[msg.code] || '进入失败：' + msg.code);
      wantOnline = false;
      try {
        ws && ws.close();
      } catch {}
    }
  }

  // ---------- 发送 ----------

  function startTicker() {
    stopTicker();
    tickTimer = setInterval(sendState, TICK_MS);
  }
  function stopTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = 0;
  }

  const r3 = (v) => Math.round(v * 1000) / 1000;

  function sendState() {
    if (!ws || ws.readyState !== 1) return;
    const G = window.__G;
    const p = G && G.player;
    if (!p || !p.pos) return;
    const msg = {
      t: 's',
      p: [
        r3(p.pos.x),
        r3(p.pos.y),
        r3(p.pos.z),
        r3(p.yaw || 0),
        r3(p.pitch || 0),
        Math.round(p.health == null ? 100 : p.health),
        p.alive === false ? 0 : 1,
      ],
    };
    ws.send(JSON.stringify(msg));
    net.sent += 1;
  }

  net.sendEvent = (kind, data) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ t: 'e', k: kind, d: data, seq: Date.now() }));
    return true;
  };

  // ---------- 远端玩家替身 ----------

  function three() {
    const G = window.__G;
    return G && G.THREE && G.scene ? G : null;
  }

  function makeGhost(id) {
    const G = three();
    if (!G) return null;
    const THREE = G.THREE;
    const color = PALETTE[id % PALETTE.length];
    const group = new THREE.Group();
    group.name = 'sl-ghost-' + id;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.95, 6, 12), mat);
    body.position.y = 0.95;
    body.castShadow = true;
    group.add(body);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.12, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.4, metalness: 0.6 }),
    );
    visor.position.set(0, 1.42, -0.24);
    group.add(visor);
    G.scene.add(group);
    return { group, samples: [] };
  }

  function onPeerState(from, p) {
    if (!Array.isArray(p) || p.length < 4) return;
    let g = ghosts.get(from);
    if (!g) {
      g = makeGhost(from);
      if (!g) return;
      ghosts.set(from, g);
      net.ghosts = ghosts.size;
    }
    const now = performance.now();
    g.samples.push({ t: now, x: p[0], y: p[1], z: p[2], yaw: p[3], alive: p[6] !== 0 });
    while (g.samples.length > 12) g.samples.shift();
    // 第一个样本立刻落位，别让替身先在原点闪一帧
    if (g.samples.length === 1) {
      g.group.position.set(p[0], p[1], p[2]);
      g.group.rotation.y = p[3];
      g.group.visible = p[6] !== 0;
    }
  }

  function stepGhosts() {
    if (!ghosts.size) return;
    const renderAt = performance.now() - INTERP_MS;
    for (const [id, g] of ghosts) {
      const s = g.samples;
      if (!s.length) continue;
      let a = s[0];
      let b = s[0];
      for (let i = 0; i < s.length; i++) {
        if (s[i].t <= renderAt) {
          a = s[i];
          b = s[i + 1] || s[i];
        }
      }
      const span = b.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (renderAt - a.t) / span)) : 0;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;
      let dyaw = b.yaw - a.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      g.group.position.set(x, y, z);
      g.group.rotation.y = a.yaw + dyaw * k;
      g.group.visible = b.alive !== false;
      g.group.userData.peer = id;
    }
  }

  function clearGhosts() {
    const G = three();
    for (const [, g] of ghosts) {
      if (G) {
        G.scene.remove(g.group);
        g.group.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }
    }
    ghosts.clear();
    net.ghosts = 0;
  }

  function syncGhosts() {
    const live = new Set(net.peers.map((p) => p.id));
    const G = three();
    for (const [id, g] of ghosts) {
      if (!live.has(id)) {
        if (G) G.scene.remove(g.group);
        ghosts.delete(id);
      }
    }
    net.ghosts = ghosts.size;
    for (const p of net.peers) peerNames.set(p.id, p.name);
  }

  (function loop() {
    try {
      if (net.status === 'online') stepGhosts();
    } catch {}
    requestAnimationFrame(loop);
  })();

  // 自动联机（?room=ABCD 或 ?net=1）
  const autoRoom = (qs.get('room') || '').toUpperCase();
  if (autoRoom) setTimeout(() => join(autoRoom), 600);
  else if (qs.get('net') === '1' && isLocalHost) setTimeout(() => join(''), 600);
})();
