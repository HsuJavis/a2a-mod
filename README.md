<div align="center">

# a2a-mod

**Hand work to other AI agents from Claude Code. Keep going. Get the result back.**

[![CI](https://github.com/NovusEdge/a2a-mod/actions/workflows/ci.yml/badge.svg)](https://github.com/NovusEdge/a2a-mod/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/NovusEdge/a2a-mod?color=d4a03c)](https://github.com/NovusEdge/a2a-mod/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![A2A 1.0 | 0.3](https://img.shields.io/badge/A2A-1.0%20%7C%200.3-informational.svg)](https://a2a.khimani.dev/protocol)
[![Docs](https://img.shields.io/badge/docs-a2a.khimani.dev-1a1a1a.svg)](https://a2a.khimani.dev)

<img src="docs/assets/demo.gif" alt="Claude Code hands a slow build to a worker, keeps working, and gets the result when it lands" width="900">

</div>

> **This is HsuJavis's fork of [NovusEdge/a2a-mod](https://github.com/NovusEdge/a2a-mod)** by Aliasgar Khimani (MIT). It adds a [LAN mode](#lan-mode), on by default with no secret: Claude Code sessions on the same network find each other and exchange messages and files. Everything else is upstream's.

## Why

- **Claude never waits on a slow agent.** After a few seconds the task moves to the background and Claude carries on. When the agent finishes, Claude gets the result.
- **Works with any A2A agent.** ADK, AG2, LangGraph, @a2a-js/sdk, or anything else that speaks A2A 1.0 or 0.3.
- **Your tokens stay out of the chat.** Keys come from a setting, a command or a file. You never paste one into Claude.

## Install

In Claude Code 2.1.287 or later:

```
/plugin marketplace add HsuJavis/a2a-mod
/plugin install a2a-mod@a2a-mod
```

Upstream, without LAN mode: `/plugin marketplace add NovusEdge/a2a-mod`.

## Try it in a minute

You don't need a real agent. The repo ships a fake worker (needs Node 24 and pnpm).

1. Start it:
   ```sh
   git clone https://github.com/NovusEdge/a2a-mod && cd a2a-mod
   pnpm i && pnpm worker
   ```
2. In Claude Code, add it:
   ```
   /a2a add http://127.0.0.1:41241 fake
   ```
3. Ask Claude:
   ```
   send "slow 20 build" to the fake worker
   ```

The task takes 20 seconds. Claude gets a task id after about 7 and moves on. When the worker is done, the mod wakes Claude with the result.

## What you'll see

- **A status line** with the live task: `a2a-mod: ⠋ fake slow 20 build 0:12`. It stays visible next to `/diff`.
- **A band above your prompt** while a task runs, showing the hand-off from Claude to the worker.
- **A slim `⇄ a2a` pane** that opens with `/a2a`, as a tab next to `/diff`. It shows each worker, its tasks, and buttons to copy a result, reply to a question or cancel.
- **Boxed cards** in the transcript for each `send` and each result.

<table align="center">
  <tr>
    <td align="center"><img src="docs/assets/screens/running.png" alt="The status line and the hand-off band while a task runs" width="440"><br><sub>A task running</sub></td>
    <td align="center"><img src="docs/assets/screens/cards.png" alt="Boxed cards in the transcript for a send and its result" width="440"><br><sub>Cards in the transcript</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/screens/wake.png" alt="The message that wakes Claude with a finished task's result" width="440"><br><sub>The result lands</sub></td>
    <td align="center"><img src="docs/assets/screens/waiting.png" alt="The a2a pane with a task waiting for your reply" width="440"><br><sub>A worker asks a question</sub></td>
  </tr>
</table>

Pick `full`, `pane` or `minimal` in `/config` to show more or less. [The UI](https://a2a.khimani.dev/ui) has the details.

## Use your own agents

```
/a2a add https://worker.example.com research --token-cmd "pass show research"
```

The token is read from a command, a file or a setting, and never typed into Claude. [Worker tokens](https://a2a.khimani.dev/tokens) covers all three. You can also just ask Claude to add a worker; it shows a dialog, and nothing is added until you approve it.

## LAN mode

Every Claude Code session on the network that runs this mod in the same LAN mode shows up in the built-in `ListAgents` tool as `lan:<host>/<folder>`, next to the sessions on this machine and the A2A workers you registered (`a2a:<alias>`). Claude talks to them with the built-in `SendMessage` (`to: "lan:<name>"`, or `"a2a:<alias>"` for a worker) and sends files with `SendFile`; where the build has no `SendFile`, the mod adds a `send_file` tool.

LAN mode is **on by default, in open mode**: no secret, no setup. It has three modes, and `/a2a lan` says which one runs:

- **open** (the default: `lan` on, `lanSecret` empty). Sessions find each other with nothing to configure. There is no authentication: **anyone on your LAN can message your session and drop files in its inbox**, under any name they like. Claude is told each message comes from an unauthenticated host (with its IP), that the content is untrusted, and that it must not run commands, edit files or send files on its say-so without asking you. Use it on networks where you trust every host.
- **secret**: set the same `lanSecret` (8 or more characters) on every machine. Only sessions with that secret see and reach each other; open sessions and sessions with another secret are invisible. A secret of 1 to 7 characters is refused (LAN mode stays off and says why), never taken for open mode.
- **off**: set `lan` to false. The sidecar opens no socket and the mod behaves as upstream's.

```
# secret mode
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanSecret":"<8 or more characters>"}'
# off
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lan":false}'
# back to open mode
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lan":true,"lanSecret":""}'
```

Restart Claude Code after a change. `lanName` sets the name others use (default `<hostname>/<folder>`; letters, digits and `. _ / -` only, 64 at most). `LAN_A2A_SECRET` and `LAN_A2A_NAME` in the environment work too, when the options are empty.

- A message in shows as a toast, a row in the `/a2a` pane, and a prompt that starts a turn. It is framed as another agent's words, not yours, and its text cannot close that frame. Files land in `~/.claude/lan-a2a/inbox/` (`LAN_A2A_INBOX` moves it), with their sha256.
- `/a2a lan` shows the mode, this session's address and the sessions it sees; `/a2a list` and the `workers` tool list them too.
- How it works: the mod starts a small Node sidecar (`sidecar/lan-a2a.mjs`, no dependencies) per session. It serves an A2A 1.0/0.3 endpoint on the first free TCP port in 41400-41499, or on a random port when all of those are taken (the announce carries the real port, so discovery still works, but a firewall rule for the range will not cover it; `LAN_A2A_PORT` pins a port or range, with no fallback). It announces itself out of every IPv4 interface by UDP multicast on `239.255.41.99:41399` (TTL 1, this subnet only) and to each interface's subnet broadcast address on port 41399, hellos its static peers over TCP (`POST /lan/hello`), and sends files by URL. A file is served only under an unguessable id for an hour, and a session downloads a file only from the host that sent the message.

Security: plain HTTP on the LAN, nothing is encrypted, in either mode. In open mode anyone on the network can reach your session; in secret mode anyone with the secret can, and the secret crosses the wire in clear. Claude is told the text is untrusted, but it still reads it, so prefer secret mode, or turn LAN mode off, on networks you do not control. The agent card at `/.well-known/agent-card.json` is public; in secret mode everything else needs the secret. Allow UDP 41399 and TCP 41400-41499 in a host firewall, and note that guest Wi-Fi with client isolation blocks multicast.

### Ports

| Port | Protocol | What | Fixed? |
| --- | --- | --- | --- |
| 41399 | UDP | discovery (multicast + subnet broadcast) | always, every session |
| 41400 | TCP | messages and files of the first session on a host | yes, while it is free |
| 41401-41499 | TCP | the 2nd, 3rd, … session on the same host, in start order | the next free one |
| random | TCP | only when all of 41400-41499 are taken | no; `LAN_A2A_PORT` prevents it |

One session per machine means TCP 41400. Open the whole range once (UDP 41399, TCP 41400-41499) and more sessions need no new rule. `LAN_A2A_PORT=41400` or `LAN_A2A_PORT=41400-41410` pins the port or range; with it set there is no random fallback, and a session that finds no free port there starts without LAN mode.

A message that goes A → B but times out B → A means A reaches B's TCP port but B cannot reach A's: the firewall on A blocks incoming TCP. Seeing a peer in `ListAgents` only proves its UDP announce got through, not that its TCP port is open.

### When sessions do not see each other

`/a2a lan` says how each peer was found (`multicast`, `broadcast`, `hello` when it said hello to this session, `static` when this session reached it by address) and, when it sees none, what to check. Multicast and broadcast are UDP and are easily dropped: by a host firewall, by a VPN that takes the multicast route (Cloudflare WARP and the like), or by a router that does not pass multicast between wired and Wi-Fi. Plain TCP usually still works, so:

- **Add the other machine by address.** `/a2a lan add <host>[:port]` (no port: 41400-41409 are tried) stores it and survives restarts; `/a2a lan remove <host>` drops it. Or set the `lanPeers` option, space-separated, for every session: `claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanPeers":"192.168.0.131"}'`. Every few seconds this session says hello over TCP; the other side registers it from that one call, so adding on one machine is enough for both to see each other (as long as TCP reaches the side that added). A 0.5.x session has no hello; in open mode it is registered from its agent card, but it will not see this one until it is upgraded.
- **Linux (ufw).** Allow the ports from your subnet:
  ```
  sudo ufw allow from 192.168.0.0/24 to any port 41399 proto udp
  sudo ufw allow from 192.168.0.0/24 to any port 41400:41499 proto tcp
  ```
- **macOS.** System Settings → Network → Firewall: allow incoming connections for `node` (or turn off "Block all incoming connections" and stealth mode). Privacy & Security → Local Network: allow the terminal app that runs Claude Code, or multicast is silently dropped. A VPN such as Cloudflare WARP can route multicast into its tunnel: exclude your LAN (WARP: Preferences → Advanced → Split tunnels, or "Local network exclusion"), or rely on `/a2a lan add`.
- **Check by hand.** `curl http://<ip>:41400/.well-known/agent-card.json` from the other machine shows TCP gets through; if it does, `/a2a lan add <ip>` will work.

### LAN 模式（繁體中文）

同一個區網裡、裝了這個 mod 且使用相同 LAN 模式的每個 Claude Code session，都會出現在內建的 `ListAgents` 工具裡，名稱是 `lan:<主機>/<資料夾>`，和本機的 session、你登記的 A2A worker（`a2a:<alias>`）並列。Claude 用內建的 `SendMessage`（`to: "lan:<名稱>"`，worker 則是 `"a2a:<alias>"`）傳訊息，用 `SendFile` 傳檔案；這個版本的 Claude Code 沒有 `SendFile` 時，mod 會改提供 `send_file` 工具。

LAN 模式**預設開啟，且為公開（open）模式**：不需密鑰、不需設定。共有三種模式，`/a2a lan` 會顯示目前是哪一種：

- **open（預設：`lan` 開、`lanSecret` 留空）**：session 之間免設定即可互相發現。沒有任何驗證：**區網上任何人都能傳訊息給你的 session、把檔案放進 inbox**，名稱也可以隨便取。Claude 會被告知訊息來自未經驗證的主機（附 IP）、內容不可信，且不可因為訊息要求就執行指令、修改檔案或傳送檔案，必須先問你。只在你信任網路上每台主機時使用。
- **secret**：每台機器設定同一組 `lanSecret`（至少 8 個字元）。只有持相同密鑰的 session 彼此看得到、傳得到；open 模式或其他密鑰的 session 互相看不到。1 到 7 個字元的密鑰會被拒絕（LAN 模式維持關閉並說明原因），不會被當成 open 模式。
- **off**：把 `lan` 設為 false。sidecar 不開任何 socket，mod 的行為與上游相同。

```
# secret 模式
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanSecret":"<至少 8 個字元>"}'
# 關閉
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lan":false}'
# 回到 open 模式
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lan":true,"lanSecret":""}'
```

改完要重開 Claude Code。`lanName` 可自訂別人用來稱呼你的名稱（預設 `<主機名>/<資料夾>`；只允許字母、數字與 `. _ / -`，最多 64 字元）。選項留空時，也可用環境變數 `LAN_A2A_SECRET`、`LAN_A2A_NAME`。

- 收到訊息時會跳 toast、在 `/a2a` 面板多一列，並自動開始一個 turn；內容會標示為「另一個 agent 寫的、不是使用者」的不可信輸入，訊息內文無法關閉這個標示框。檔案存到 `~/.claude/lan-a2a/inbox/`（可用 `LAN_A2A_INBOX` 改），附 sha256。
- `/a2a lan` 顯示目前模式、本 session 的位址與看得到的其他 session；`/a2a list` 和 `workers` 工具也會列出。
- 運作方式（發現方式：每張網卡各送一次 UDP multicast 與子網廣播、對靜態 peer 走 TCP hello `POST /lan/hello`）：每個 session 會啟動一個小型 Node sidecar（`sidecar/lan-a2a.mjs`，零相依），在 41400-41499 中第一個空閒的 TCP port 提供 A2A 1.0/0.3 端點；這段全被占用時改用隨機 port（廣播會帶真正的 port，所以仍找得到，但針對該範圍的防火牆規則就涵蓋不到；`LAN_A2A_PORT` 可指定 port 或範圍，指定時不會退回隨機 port）。以 UDP multicast `239.255.41.99:41399`（TTL 1，只限本網段）互相發現，檔案以 URL 傳遞；檔案只以不可猜的 id 提供一小時，接收端也只從傳訊息的那台主機下載。

安全：區網內走明文 HTTP，兩種模式都沒有加密。open 模式下網路上任何人都能連到你的 session；secret 模式下拿到密鑰的人就能，而且密鑰以明文在網路上傳送。雖然會告訴 Claude 這是不可信內容，它仍會讀到，所以在不是你掌控的網路上，請改用 secret 模式或關閉 LAN 模式。`/.well-known/agent-card.json` 是公開的；secret 模式下其餘都需要密鑰。主機防火牆要放行 UDP 41399 與 TCP 41400-41499；有「用戶端隔離」的訪客 Wi-Fi 會擋掉 multicast。

#### Port 說明

| Port | 協定 | 用途 | 固定嗎 |
| --- | --- | --- | --- |
| 41399 | UDP | 互相發現（multicast + 子網廣播） | 永遠固定，每個 session 都一樣 |
| 41400 | TCP | 這台機器第一個 session 的訊息與檔案 | 沒被占用就固定是它 |
| 41401-41499 | TCP | 同一台機器的第 2、3…個 session，依啟動順序 | 取下一個空閒的 |
| 隨機 | TCP | 只有 41400-41499 全被占用時 | 不固定；設 `LAN_A2A_PORT` 可避免 |

每台只開一個 session 就是 TCP 41400。防火牆一次放行整段（UDP 41399、TCP 41400-41499），之後多開 session 也不用再加規則。設 `LAN_A2A_PORT=41400` 或 `LAN_A2A_PORT=41400-41410` 可以固定 port 或範圍；設了就不會退到隨機 port，範圍內都被占用時，該 session 的 LAN 模式不會啟動。

A → B 送得到、B → A 卻逾時：代表 A 連得到 B 的 TCP port，B 連不到 A 的，也就是 A 的防火牆擋了 TCP 連入。在 `ListAgents` 看得到對方，只證明它的 UDP 廣播到得了，不代表它的 TCP port 有開。

#### 看不到其他 session 時

`/a2a lan` 會列出每個 peer 是怎麼找到的（`multicast`、`broadcast`、`hello`：對方主動打招呼、`static`：本 session 依位址找到它），一個都沒有時會列出排查提示。multicast 與 broadcast 都是 UDP，很容易被擋：主機防火牆、把 multicast 路由進通道的 VPN（如 Cloudflare WARP）、或不在有線與 Wi-Fi 之間轉送 multicast 的路由器。一般 TCP 通常仍然通，所以：

- **直接用位址加入對方。** `/a2a lan add <主機>[:port]`（不給 port 會試 41400-41409）會存起來、重開後仍在；`/a2a lan remove <主機>` 移除。也可設定 `lanPeers` 選項（空白分隔），對所有 session 生效：`claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanPeers":"192.168.0.131"}'`。本 session 每隔幾秒用 TCP 打一次招呼，對方從這一次呼叫就會登記本 session，所以只要在一台機器上加，兩邊就互相看得到（前提是加的那一邊的 TCP 連得到對方）。0.5.x 的 session 沒有 hello；open 模式下會改用它的 agent card 登記，但它要升級後才看得到這一邊。
- **Linux（ufw）**：從你的網段放行這些 port：
  ```
  sudo ufw allow from 192.168.0.0/24 to any port 41399 proto udp
  sudo ufw allow from 192.168.0.0/24 to any port 41400:41499 proto tcp
  ```
- **macOS**：系統設定 → 網路 → 防火牆：允許 `node` 接受連入（或關閉「阻擋所有傳入連線」與隱形模式）。隱私權與安全性 → 區域網路：允許執行 Claude Code 的終端機 App，否則 multicast 會被默默丟掉。Cloudflare WARP 之類的 VPN 可能把 multicast 導進通道：把區網排除（WARP：偏好設定 → 進階 → Split tunnels，或「Local network exclusion」），或直接用 `/a2a lan add`。
- **手動確認**：在另一台機器上 `curl http://<ip>:41400/.well-known/agent-card.json`，有回應代表 TCP 通，`/a2a lan add <ip>` 就會成功。

## Learn more

[How it works](https://a2a.khimani.dev/how-it-works) · [Write a worker](https://a2a.khimani.dev/write-a-worker) · [Troubleshooting](https://a2a.khimani.dev/troubleshooting) · [Security](https://a2a.khimani.dev/security) · [Protocol support](https://a2a.khimani.dev/protocol)

## Contributing and license

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). MIT licensed: see [LICENSE](LICENSE). a2a-mod is by [Aliasgar Khimani](https://github.com/NovusEdge); LAN mode is by [HsuJavis](https://github.com/HsuJavis).
