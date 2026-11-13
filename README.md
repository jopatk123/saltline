# Saltline · 盐线

浏览器第一人称合作射击，挂在 B 站小玩具（`bilibili.com/toy/saltline`）上跑。
本仓库除游戏本体外，还包含一套**联机层**：静态页 + 独立域名的哑中继，不依赖任何游戏服务器框架。

## 现在的状态

| 部分 | 状态 |
| --- | --- |
| 单机游戏 | 已在 Toy 上线（Toy id `54387619662848`） |
| 联机层（里程碑 1） | 房间 + 玩家位置同步，已通过端到端测试；敌人与任务进度未同步 |
| 中继服务 | 代码完成，未部署 |

## 目录

```
index.html        入口（Toy 入口文件，必须 < 1 MiB）
game.js           游戏本体（Three.js r180 + 全部逻辑，已压缩，不要手改）
net.js            联机层：只通过 window.__G 读写游戏状态，不改 game.js
server/relay.mjs  哑中继：房间表 + 消息扇出，不跑任何游戏逻辑
tools/serve.mjs   本地静态服务
tools/pack-toy.mjs 打 Toy 运行包（手写 zip，无依赖）
tests/            relay 冒烟 / __G 契约 / 端到端联机
deploy/           nginx 与 systemd 样例
```

## 本地怎么跑

```bash
npm install

# 终端 1：中继
npm run relay            # ws://127.0.0.1:9090

# 终端 2：静态页
npm run dev              # http://127.0.0.1:8080
```

打开 `http://127.0.0.1:8080/`，游戏左下角有「联机」面板：填 4 位房间码（留空则新建），点「进入」。
也可以直接带参数进房：`http://127.0.0.1:8080/?room=ABCD`。

> 房间码字母表是 `A-Z` 去掉 `I` `O`，数字 `2-9`；输入框会自动过滤。

## 联机是怎么工作的

**权威在房主浏览器里**，中继只转发消息。这样 `game.js` 一行都不用改，也不需要把物理逻辑搬到服务端。

```
浏览器 A（房主）  ──wss──▶  relay  ◀──wss──  浏览器 B
   读 __G.player         房间表/扇出          写 __G.scene 里的替身
```

- 客户端 20 Hz 发 `{t:'s', p:[x,y,z,yaw,pitch,hp,alive]}`，中继打上 `from` 后扇出。
- 远端玩家 100 ms 插值缓冲，本地玩家零延迟直控。
- 事件（射击、任务进度）走 `{t:'e', k, d, seq}`，预留但里程碑 1 未接。
- 掉线会自动重连 3 次；房主离开时房主身份自动转移给房间内最小 id。

### 联机层依赖的契约

`net.js` 只用到游戏已经暴露的 `window.__G`：

| 对象 | 用途 |
| --- | --- |
| `__G.player` | `pos / yaw / pitch / health / alive` 读状态 |
| `__G.scene`、`__G.THREE` | 挂远端替身（Capsule + 朝向块） |
| `__G.game` | 判断是否就绪 |

这套契约是压缩包内部结构，`game.js` 一旦重新导出就可能变。所以 **`npm run test:contract` 是必须跑的**：
它用 headless Chrome 把游戏真正跑起来，逐项断言这些路径还在。

## 测试

```bash
npm test          # 三件套全跑
npm run test:relay     # 中继：进房、扇出、房主转移、空房回收
npm run test:contract  # 契约：__G.* 字段与 net.js 是否就位
node tests/coop.test.mjs  # 端到端：真浏览器 + Node 假队友，验证替身位置/朝向
```

端到端与契约测试都需要本机有 Chrome。headless 必须带 `--autoplay-policy=no-user-gesture-required`，
否则启动会卡在音频阶段，`__G.player` 一直是 `null`（脚本里已处理，可设 `CHROME_PATH` 覆盖浏览器路径）。

## 打包 / 发布

```bash
npm run pack:toy
```

产物 `dist-toy.zip` 根目录只有 `index.html`、`game.js`、`net.js` 三个文件；入口 34 KB，远低于 1 MiB。
`game.js` 与仓库中文件逐字节一致（zip 用 deflate，可自行 `unzip -p dist-toy.zip game.js | sha256sum` 核对）。

上传后先用**仅链接可见的预览**确认：面板能连上、两个人能在同一张图里互相看见，再发布。

## 部署中继

见 `deploy/`：

1. 把仓库放到 `/root/opt/saltline`，`npm ci --omit=dev`。
2. `cp deploy/saltline-relay.service /etc/systemd/system/ && systemctl enable --now saltline-relay`。
3. `cp deploy/nginx-saltline.jopatk.top.conf /etc/nginx/sites-available/`，软链到 `sites-enabled`，`nginx -t && systemctl reload nginx`。
4. DNS 加一条 `saltline.jopatk.top` → 服务器，`certbot --nginx -d saltline.jopatk.top`。
5. 验证：`curl https://saltline.jopatk.top/healthz` 返回 `{"ok":true,...}`。

客户端默认连 `wss://saltline.jopatk.top/ws`，只有页面在 `localhost/127.0.0.1` 时才连本机 9090。
临时换地址用 `?net=wss://别的地址/ws`。

## 已知限制

- 只同步玩家位置，敌人、中继站进度、撤离判定要等里程碑 2 / 3。
- 不做反作弊：房间码就是唯一门槛，任何知道码的人都能进。
- 中继是单进程单点，重启时所有房间断开，客户端会回退到大堂。
- Toy 的 iframe 路径带版本号，旧版本页面仍可能被打开；协议加了 `version` 字段但暂未做版本协商。

## 其他文档

- `项目现状.md` —— 2026-11-13 的静态包快照（Toy 拆分与上线记录）。
- `多人联机改造实施方案.md` —— 服务器权威路线的完整设计，与本仓库采用的房主权威路线不同，作参考保留。
