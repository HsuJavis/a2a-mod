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

> **This is HsuJavis's fork of [NovusEdge/a2a-mod](https://github.com/NovusEdge/a2a-mod)** by Aliasgar Khimani (MIT). It puts your registered workers into Claude Code's own agent tools: [`ListAgents`, `SendMessage`, `SendFile` and `/list-agents`](#workers-in-claude-codes-agent-tools) show and reach them as `a2a:<alias>`; since 0.9.0 [every session serves an A2A endpoint](#claude-code-sessions-over-a2a), so Claude Code sessions and A2A workers hand each other tasks in every direction; and [`/a2a scan`](#find-workers-and-sessions-on-your-network) finds both on a private network. Everything else is upstream's.

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

Upstream, without the agent-tool integration: `/plugin marketplace add NovusEdge/a2a-mod`.

### The settings the installer asks for

All of them can stay empty or at their default. Change them later with `/plugin` (pick a2a-mod, then configure) or `claude plugin configure a2a-mod@a2a-mod`, and restart Claude Code.

| Setting | What it is | What to put | Default |
| --- | --- | --- | --- |
| **A2A layout** (`layout`) | How much a2a UI shows: `full` cards above the prompt, the band and the workers pane; `pane` the pane only; `minimal` the status line only | Leave it, or `minimal` for a quiet screen | `full` |
| **A2A animations** (`animations`) | Spinners and shimmer in that UI; off draws still frames | Leave it | on |
| **Worker tokens** (`tokens`) | Bearer tokens for remote A2A workers (and token-mode sessions) you add with `/a2a add`, as `alias=token` pairs separated by spaces (`w1=abc w2=def`) | Empty, unless one you added needs a token | empty |
| **A2A endpoint** (`server`) | Whether this session serves an A2A endpoint, so other sessions and A2A agents can send it tasks ([below](#claude-code-sessions-over-a2a)) | Leave it on; off opens no socket at all | on |
| **A2A endpoint token** (`serverToken`) | Empty: open, anyone who can reach the port can message this session. Set: senders need it as a Bearer token | Set one on any network you do not fully trust | empty |
| **A2A endpoint name** (`serverName`) | The name on this session's Agent Card, which others see in a scan and as the default alias | Leave it | `<hostname>/<folder>` |

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

## Claude Code sessions over A2A

Every Claude Code session with the mod serves its own A2A endpoint (the `server` setting, on by default). So all four directions work:

| From | To | How |
| --- | --- | --- |
| Claude session | A2A worker | `/a2a add <url>`, then `SendMessage` to `a2a:<alias>` (as before) |
| Claude session | Claude session | `/a2a add http://<ip>:<port>` of the other session, then `SendMessage` to `a2a:<alias>` |
| A2A worker or any A2A client | Claude session | A2A `SendMessage` / `message/send` to the session's endpoint, then `GetTask` until it completes |
| Claude session | the task that asked it | Claude answers with `SendMessage` (or `SendFile`) to `a2a-task:<id>` |

**Where a session is.** `/a2a` prints this session's endpoint, for example `http://192.168.1.5:41400`, whether it is open or token mode, and how many inbound tasks are open. `ListAgents` and `/list-agents` show the same line at the top of their a2a sections. Another session adds it with `/a2a add http://192.168.1.5:41400`, or finds it with [`/a2a scan`](#find-workers-and-sessions-on-your-network): sessions are marked **Claude Code session** there, apart from A2A workers. Registered sessions are listed under `Claude Code sessions` in `ListAgents`, workers under `A2A workers`.

**What the receiving session does.** A message makes an A2A task (state `submitted`, then `working` once the session has it). The mod hands the text to Claude as a prompt framed as untrusted input from another agent, never as your words, with its sender's address and the files it carried (saved under `~/.claude/a2a-mod/inbox/`). Claude may answer the asking task without asking you: `SendMessage` to `a2a-task:<id>` completes it with the answer as an artifact, `SendFile` to the same address adds files, and `a2a-task:<id>:ask` asks the sender a question instead (`input-required`; its answer arrives as a follow-up on the same task). Running commands, editing or creating files, reading or sending local files, or contacting anyone else because a message asks still needs your confirmation. The asking side's tracker polls the task until it completes, however long Claude takes, and wakes its Claude with the answer. `CancelTask` cancels it; an unanswered task fails after an hour, and ended tasks are dropped an hour later.

**Files.** Inbound file parts may be inline bytes (`raw` / `bytes`) or URLs; a URL is downloaded only from the sender's own address, with no redirects, at most 64 MiB a file and 20 files a message. A reply's files are served by the replying session at an unguessable URL (`/files/<random>`, valid while the task is kept), which the asking side sees in the result. Claude Code sessions sending to each other send files inline (4 MiB a file, 10 MiB a send).

**Ports.** The endpoint listens on all interfaces on the first free port in 41400-41499, so the first ten sessions on a host are what a default scan finds. `A2A_PORT` in Claude Code's environment pins a port or range (`A2A_PORT=41450` or `41450-41460`); there is no random fallback, and when no port is free the session has no endpoint and `/a2a` says why. The port can change when a session restarts, so a registered session may need `/a2a add` again.

**Firewall.** Inbound TCP on the port must be allowed on the receiving machine, for example on Ubuntu `sudo ufw allow from 192.168.1.0/24 to any port 41400:41499 proto tcp`; macOS asks once to let `node` accept incoming connections. Corporate networks, guest Wi-Fi and VPNs often block traffic between machines; then only sessions on the same machine (`127.0.0.1`) reach each other.

**Security.** With no `serverToken` the endpoint is **open**: anyone who can reach the port can send this session a message, and Claude reads it. The frame tells Claude it is untrusted and must not act on it beyond answering, but treat an open endpoint like an open chat window: set `serverToken` on any network you do not fully trust. With a token, a request without `Authorization: Bearer <token>` gets 401 (compared in constant time); the Agent Card stays public and declares the bearer scheme, and another session registers this one with the token from its `tokens` setting (`/a2a add http://<ip>:<port> <alias>` plus `<alias>=<token>` in `tokens`). The sidecar's own MCP tools are for the mod alone; Claude is refused if it calls them.

**The sidecar.** A mod cannot listen on a socket, so a small zero-dependency Node.js process (`sidecar/a2a-server.mjs`, declared in `plugin.json`) holds the endpoint and runs scans. It needs Node.js 22 or later on PATH. With it missing, the session has no endpoint and `/a2a scan` says it needs the sidecar; everything else still works.

### Claude Code session 之間走 A2A（繁體中文）

每個裝了這個 mod 的 Claude Code session 都會開一個自己的 A2A 端點（`server` 設定，預設開）。四個方向都通：

| 從 | 到 | 怎麼做 |
| --- | --- | --- |
| Claude session | A2A worker | `/a2a add <url>`，再 `SendMessage` 給 `a2a:<alias>`（和以前一樣） |
| Claude session | Claude session | `/a2a add http://<ip>:<port>`（對方 session 的端點），再 `SendMessage` 給 `a2a:<alias>` |
| A2A worker 或任何 A2A client | Claude session | 對 session 端點送 A2A `SendMessage`／`message/send`，再用 `GetTask` 查到完成 |
| Claude session | 問它的那個 task | Claude 用 `SendMessage`（或 `SendFile`）回給 `a2a-task:<id>` |

**session 在哪裡。** `/a2a` 會印出本 session 的端點（例如 `http://192.168.1.5:41400`）、是開放還是 token 模式、目前有幾個進來的 task。`ListAgents` 和 `/list-agents` 的 a2a 段落最上面也有同一行。別的 session 用 `/a2a add http://192.168.1.5:41400` 加入，或用 [`/a2a scan`](#在網路上找-worker-和-session繁體中文) 找到：掃描結果會把 session 標成 **Claude Code session**，和 A2A worker 分開。登記過的 session 在 `ListAgents` 列在 `Claude Code sessions` 下，worker 列在 `A2A workers` 下。

**收到訊息的 session 怎麼處理。** 一則訊息會建立一個 A2A task（狀態 `submitted`，session 收到後變 `working`）。mod 把內容當成「另一個 agent 寫的、不可信的輸入」交給 Claude，絕不當成你說的話，並附上寄件位址和夾帶的檔案（存在 `~/.claude/a2a-mod/inbox/`）。Claude 可以不問你就回覆這個 task：`SendMessage` 給 `a2a-task:<id>` 會以回答完成 task（放在 artifact），`SendFile` 給同一個位址會附上檔案；`a2a-task:<id>:ask` 則是反問對方（`input-required`，對方的回答會以同一個 task 的後續訊息送回來）。但因為訊息要求而執行指令、修改或建立檔案、讀取或傳送本機檔案、聯絡其他人，仍然要你確認。發問那一端的追蹤器會一直查到 task 完成（Claude 想多久都可以），再把答案叫醒它的 Claude。`CancelTask` 可取消；一小時沒回的 task 會變 failed，結束的 task 一小時後清掉。

**檔案。** 進來的 file part 可以是內嵌位元組（`raw`／`bytes`）或 URL；URL 只從寄件者自己的位址下載、不跟隨轉址，每檔最多 64 MiB、每則最多 20 個檔。回覆裡的檔案由回覆的 session 以猜不到的網址提供（`/files/<亂數>`，task 保留期間有效），發問端會在結果裡看到。Claude session 之間互傳檔案是內嵌傳送（每檔 4 MiB、每次 10 MiB）。

**Port。** 端點監聽所有網路介面，用 41400-41499 中第一個空的 port，所以一台主機前十個 session 就是預設掃描會找的範圍。在 Claude Code 的環境變數設 `A2A_PORT` 可以固定 port 或範圍（`A2A_PORT=41450` 或 `41450-41460`）；不會退而用隨機 port，沒有空 port 時這個 session 就沒有端點，`/a2a` 會說明原因。session 重開後 port 可能改變，登記過的 session 可能要重新 `/a2a add`。

**防火牆。** 接收端機器必須允許該 port 的 TCP 連入，例如 Ubuntu：`sudo ufw allow from 192.168.1.0/24 to any port 41400:41499 proto tcp`；macOS 會詢問一次是否讓 `node` 接受連入。公司網路、訪客 Wi-Fi、VPN 常常擋掉機器之間的連線；那種情況下只有同一台機器上（`127.0.0.1`）的 session 互通。

**安全。** 沒設 `serverToken` 時端點是**開放的**：任何連得到這個 port 的人都能傳訊息給這個 session，而 Claude 會讀到。外框會告訴 Claude 這是不可信的內容、除了回覆之外不能照做，但請把開放端點當成一個公開的聊天視窗：在你不完全信任的網路上請設定 `serverToken`。設了 token 後，沒帶 `Authorization: Bearer <token>` 的請求一律 401（以固定時間比對）；Agent Card 仍然公開，並宣告 bearer 驗證，別的 session 登記它時用自己 `tokens` 設定裡的 token（`/a2a add http://<ip>:<port> <alias>`，`tokens` 裡加 `<alias>=<token>`）。sidecar 自己的 MCP 工具只給 mod 用，Claude 呼叫會被拒絕。

**sidecar。** mod 不能監聽 socket，所以由一個零相依的小 Node.js 程式（`sidecar/a2a-server.mjs`，在 `plugin.json` 宣告）負責端點和掃描。需要 PATH 上有 Node.js 22 以上。沒有它時，這個 session 沒有端點，`/a2a scan` 會說需要 sidecar；其他功能照常。

## Use your own agents

```
/a2a add https://worker.example.com research --token-cmd "pass show research"
```

The token is read from a command, a file or a setting, and never typed into Claude. [Worker tokens](https://a2a.khimani.dev/tokens) covers all three. You can also just ask Claude to add a worker; it shows a dialog, and nothing is added until you approve it.

## Find workers and sessions on your network

When you do not know a worker's or a session's URL, scan for it:

```
/a2a scan 192.168.1.0/24
/a2a scan 10.0.0.0/16 --ports 8000,9000-9010
/a2a scan 10.0.0.20-10.0.0.60 --https
```

The scan runs in the sidecar. It tries a TCP connection to every address and port, and asks only the ports that accept for `/.well-known/agent-card.json`. It lists the Agent Cards that answer, each marked **Claude Code session** or **A2A worker**, with its URL, A2A version and skills. This session is left out, and a session reachable at several addresses is listed once. Progress (probes done of the total, percent, found, elapsed time and an estimate of what is left) shows on the status line and in the **A2A scan** pane, which opens when the scan starts, at most 4 times a second; **Stop** there or `/a2a scan stop` ends it at once (every open probe is closed). One scan runs at a time. `/a2a scan` on its own says where the scan is, or what it found.

When it ends, tick the ones you want in the pane and press **Add selected**. They are added just as `/a2a add` adds them, each under its card name as the alias (`fake-worker`, then `fake-worker-2` if that is taken), with its token from the tokens setting. The same list is printed in the transcript with an `/a2a add <url> <alias>` line for each, for surfaces without the pane. **Nothing is added until you choose it.** An endpoint you already registered is marked `already added` and not offered again (it is matched by its card URL, so one you added by host name is not recognised under its IP).

- **Targets**: an IPv4 CIDR up to a /16, one address, or a range `a.b.c.d-e.f.g.h` (at most 65,536 addresses, inside one block). Only private addresses: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT, Tailscale), 169.254.0.0/16 and 127.0.0.0/8. Anything else is refused, and so is anything wider than a /16. The network and broadcast addresses of a /30 or wider are skipped.
- **Ports**: 80, 443, 8000, 8080 and 41241 (A2A workers) and 41400-41409 (the first ten Claude Code sessions on a host) by default; `--ports` replaces them with a list such as `8000,9000-9010` (1-65535). https is used on 443 and http elsewhere; `--https` tries https on every port. One scan makes at most 1,048,576 probes (a /16 on 16 ports).
- **Pace**: 512 connection attempts at once, each given 300 ms (`A2A_SCAN_CONCURRENCY` and `A2A_SCAN_TIMEOUT_MS` in Claude Code's environment change them); a card request on an open port gets 1.5 s.
- **How long**, measured on this machine (Linux, 16 cores, Node 22) over loopback, where every closed port refuses at once: a /24 on the 15 default ports (3,810 probes) took 0.64-0.94 s; a /20 on the 15 default ports (61,410 probes) took 8.3 s, about 7,400 probes a second, so a /16 is about 2-3 minutes at that rate. On a real network an address with no host does not refuse; it costs the full 300 ms. Worst case, computed rather than measured: a /24 on the default ports is 3,810 / 512 × 0.3 s ≈ 2.2 s, and a /16 is 983,010 / 512 × 0.3 s ≈ 9.6 minutes. (0.8.0's in-mod scan took an estimated 1.5 to 14 hours for a /16, because a mod cannot cancel a request.)
- Only `/.well-known/agent-card.json` is asked for; a worker that serves only the older `/.well-known/agent.json` is not found.
- The scan needs the sidecar (Node.js 22 or later). Without it `/a2a scan` says so and scans nothing.
- Claude has no scan tool: a sweep of the network is something you start yourself.

**Network etiquette.** A scan is many connections to many machines in a short time. Corporate networks, hotel and campus Wi-Fi and cloud VPCs often watch for exactly that, and an intrusion detection system may flag or block your machine. Scan only networks you own or are allowed to scan. The cards that answer are their servers' own text: the mod strips control characters from them, but read a card before you add it.

### 在網路上找 worker 和 session（繁體中文）

不知道 worker 或 session 的網址時，可以掃描：

```
/a2a scan 192.168.1.0/24
/a2a scan 10.0.0.0/16 --ports 8000,9000-9010
/a2a scan 10.0.0.20-10.0.0.60 --https
```

掃描在 sidecar 裡進行：先對每個位址的每個 port 試 TCP 連線，只有連得上的 port 才去要 `/.well-known/agent-card.json`。列出有回應的 Agent Card，每個標成 **Claude Code session** 或 **A2A worker**，附網址、A2A 版本和技能。本 session 自己不列；同一個 session 從好幾個位址都連得到時只列一次。進度（已探測數／總數、百分比、找到幾個、已花時間、預估剩餘時間）顯示在狀態列和掃描開始時打開的 **A2A scan** 面板，每秒最多更新 4 次；按面板上的 **Stop** 或輸入 `/a2a scan stop` 會立刻中止（所有進行中的探測都會關掉）。同時只能跑一個掃描。單打 `/a2a scan` 會顯示目前進度或掃描結果。

掃完後在面板勾選要加入的項目，按 **Add selected**。加入方式和 `/a2a add` 完全相同：別名預設取卡片名稱（`fake-worker`，被佔用時改成 `fake-worker-2`），token 來自 tokens 設定。同一份清單也會印在對話紀錄裡，每個附一行 `/a2a add <url> <alias>`，給沒有面板的介面用。**你沒選的，一個都不會加入。** 已登記過的端點會標成 `already added`，不再列為可加入（以卡片網址比對，所以用主機名稱登記的在 IP 下認不出來）。

- **目標**：IPv4 CIDR（最大 /16）、單一位址，或範圍 `a.b.c.d-e.f.g.h`（最多 65,536 個位址，且須在同一個區塊內）。只接受私有位址：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、100.64.0.0/10（CGNAT、Tailscale）、169.254.0.0/16 和 127.0.0.0/8；其他一律拒絕，比 /16 大的也拒絕。/30 以上的網段會跳過網路位址和廣播位址。
- **Port**：預設 80、443、8000、8080、41241（A2A worker）加上 41400-41409（一台主機前十個 Claude Code session）；`--ports` 可換成 `8000,9000-9010` 這類清單（1-65535）。443 用 https，其他用 http；`--https` 則每個 port 都用 https。一次掃描最多 1,048,576 次探測（/16 乘 16 個 port）。
- **速度**：同時 512 個連線嘗試，每個等 300 毫秒（可在 Claude Code 的環境變數用 `A2A_SCAN_CONCURRENCY`、`A2A_SCAN_TIMEOUT_MS` 調整）；開著的 port 要卡片時等 1.5 秒。
- **要多久**（在這台機器實測：Linux、16 核、Node 22，走 loopback，關閉的 port 都會立刻拒絕）：/24 掃 15 個預設 port（3,810 次探測）花 0.64-0.94 秒；/20 掃 15 個預設 port（61,410 次）花 8.3 秒，約每秒 7,400 次，照這速度 /16 約 2-3 分鐘。在真實網路上，沒有主機的位址不會拒絕，要等滿 300 毫秒。最差情況（計算值，非實測）：/24 掃預設 port 是 3,810 ÷ 512 × 0.3 秒 ≈ 2.2 秒，/16 是 983,010 ÷ 512 × 0.3 秒 ≈ 9.6 分鐘。（0.8.0 在 mod 裡掃描，因為 mod 無法取消請求，/16 估計要 1.5 到 14 小時。）
- 只要 `/.well-known/agent-card.json`；只提供舊版 `/.well-known/agent.json` 的 worker 掃不到。
- 掃描需要 sidecar（Node.js 22 以上）。沒有的話 `/a2a scan` 會直接說明，不會掃。
- Claude 沒有掃描工具：掃網路這件事由你自己發動。

**網路禮儀。** 掃描是在短時間內連很多台機器。公司網路、飯店與校園 Wi-Fi、雲端 VPC 常常專門偵測這種行為，入侵偵測系統可能會標記或封鎖你的機器。只掃你擁有或被允許掃描的網路。回應的卡片是對方伺服器自己的文字：mod 會去掉控制字元，但加入前還是先看一下卡片內容。

## Workers in Claude Code's agent tools

The workers you registered with `/a2a add` show up in Claude Code's own agent tools as `a2a:<alias>`, next to the sessions those tools already list:

- **`ListAgents`** lists them after the engine's own listing: first this session's own endpoint, then the registered sessions under `Claude Code sessions`, the workers under `A2A workers`, and the inbound tasks waiting for Claude's reply as `a2a-task:<id>`.
- **`SendMessage`** with `to: "a2a:<alias>"` sends the message to that worker the way the `send` tool does: the band, the pane, the status line, and the wake when a slow task finishes.
- **`SendFile`** with `to: "a2a:<alias>"` sends the files, with the optional message, to that worker. Where the build has no `SendFile`, the mod adds a `send_file` tool that does the same.
- **`/list-agents`** (alias `/peers`), which you type yourself, shows the same workers after the built-in's own list. With no workers it is the built-in's output, unchanged.

- **`SendMessage`** or **`SendFile`** with `to: "a2a-task:<id>"` is Claude's answer to a task another agent sent this session ([above](#claude-code-sessions-over-a2a)).

Every other recipient is left to Claude Code: local sessions, Remote Control sessions and teammates work exactly as they do without the mod.

Files go inline: each file is read and sent as an A2A file part with its bytes in base64 (1.0 `{ raw, filename, mediaType }`, 0.3 `{ kind: "file", file: { bytes, name, mimeType } }`, whichever the worker speaks). There is no file server and no URL. **The worker must accept file parts**; one that only reads text gets nothing useful from them. A file is at most 4 MiB (what one file read in a mod takes) and the files of one send at most 10 MiB together. A file that is missing, too big or past the total is reported with its error in the result, and the others are still sent; the result gives each sent file's size and sha256. Relative paths are under the session's folder.

### Claude Code 的 agent 工具裡的 worker（繁體中文）

用 `/a2a add` 登記的 worker，會以 `a2a:<alias>` 出現在 Claude Code 自己的 agent 工具裡，和那些工具原本列出的 session 並列：

- **`ListAgents`**：在引擎自己的清單後面列出：先是本 session 自己的端點，再來 `Claude Code sessions`（登記的 session）、`A2A workers`（登記的 worker），以及等著 Claude 回覆的進來的 task（`a2a-task:<id>`）。
- **`SendMessage`**：`to: "a2a:<alias>"` 時，訊息照 `send` 工具的方式送給那個 worker：輸入框上方的動畫、面板、狀態列，慢的任務做完時會叫醒 Claude。
- **`SendFile`**：`to: "a2a:<alias>"` 時，把檔案（可附訊息）送給那個 worker。這個版本的 Claude Code 沒有 `SendFile` 時，mod 會提供功能相同的 `send_file` 工具。
- **`/list-agents`**（別名 `/peers`，你自己輸入的指令）：在內建清單後面列出同樣的 worker。沒有 worker 時就是內建的原本輸出，完全不變。

- **`SendMessage`**／**`SendFile`**：`to: "a2a-task:<id>"` 是 Claude 對別的 agent 送來的 task 的回覆（見[上面](#claude-code-session-之間走-a2a繁體中文)）。

其他收件對象一律交給 Claude Code 處理：本機 session、Remote Control session、teammate，行為和沒裝這個 mod 時完全一樣。

檔案直接夾在訊息裡傳送：每個檔案讀進來後，以 base64 位元組放進 A2A 的 file part（1.0 為 `{ raw, filename, mediaType }`，0.3 為 `{ kind: "file", file: { bytes, name, mimeType } }`，依 worker 使用的版本而定），不架檔案伺服器、也沒有 URL。**worker 必須能接受 file part**；只讀文字的 worker 拿到也沒用。單一檔案最多 4 MiB（mod 一次讀檔的上限），一次傳送的所有檔案合計最多 10 MiB。檔案不存在、太大或超過總量時，會在結果裡列出該檔的錯誤，其餘檔案照常送出；結果會附上每個已送出檔案的大小與 sha256。相對路徑以 session 所在資料夾為準。

#### 安裝時要填的設定

全部留空或維持預設就能用。之後要改，用 `/plugin`（選 a2a-mod → configure）或 `claude plugin configure a2a-mod@a2a-mod`，改完重開 Claude Code。

| 設定 | 代表什麼 | 建議填法 | 預設 |
| --- | --- | --- | --- |
| **A2A layout**（`layout`） | a2a 介面顯示多少：`full` 輸入框上方的卡片、狀態列與 worker 面板全開；`pane` 只有面板；`minimal` 只有狀態列 | 不用動；想畫面安靜就選 `minimal` | `full` |
| **A2A animations**（`animations`） | 介面上的轉圈、閃光動畫；關掉改成靜態畫面 | 不用動 | 開 |
| **Worker tokens**（`tokens`） | 用 `/a2a add` 加入的遠端 A2A worker（或 token 模式的 session）的 Bearer token，格式 `別名=token`，多組用空白隔開（`w1=abc w2=def`） | 留空；除非你加的對象需要 token | 空 |
| **A2A endpoint**（`server`） | 本 session 要不要開 A2A 端點，讓別的 session 和 A2A agent 能派 task 給它 | 不用動；關掉就完全不開 socket | 開 |
| **A2A endpoint token**（`serverToken`） | 空：開放，連得到 port 的人都能傳訊息給這個 session。有值：寄件者要帶這個 Bearer token | 在你不完全信任的網路上請設定 | 空 |
| **A2A endpoint name**（`serverName`） | 本 session 的 Agent Card 名稱，別人掃描時看到、也是預設別名 | 不用動 | `<主機名>/<資料夾>` |

## Learn more

[How it works](https://a2a.khimani.dev/how-it-works) · [Write a worker](https://a2a.khimani.dev/write-a-worker) · [Troubleshooting](https://a2a.khimani.dev/troubleshooting) · [Security](https://a2a.khimani.dev/security) · [Protocol support](https://a2a.khimani.dev/protocol)

## Contributing and license

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). MIT licensed: see [LICENSE](LICENSE). a2a-mod is by [Aliasgar Khimani](https://github.com/NovusEdge); this fork's changes are by [HsuJavis](https://github.com/HsuJavis).
