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

> **This is HsuJavis's fork of [NovusEdge/a2a-mod](https://github.com/NovusEdge/a2a-mod)** by Aliasgar Khimani (MIT). It puts your registered workers into Claude Code's own agent tools: [`ListAgents`, `SendMessage`, `SendFile` and `/list-agents`](#workers-in-claude-codes-agent-tools) show and reach them as `a2a:<alias>`, and [`/a2a scan`](#find-workers-on-your-network) finds workers on a private network. Everything else is upstream's. The LAN mode of 0.4.0-0.6.1 was removed in 0.7.0: for Claude Code sessions on other machines, use Claude Code's built-in Remote Control.

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
| **Worker tokens** (`tokens`) | Bearer tokens for remote A2A workers you add with `/a2a add`, as `alias=token` pairs separated by spaces (`w1=abc w2=def`) | Empty, unless a worker you added needs a token | empty |

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

## Find workers on your network

When you do not know a worker's URL, scan for it:

```
/a2a scan 192.168.1.0/24
/a2a scan 10.0.0.0/16 --ports 8000,9000-9010
/a2a scan 10.0.0.20-10.0.0.60 --https
```

The scan asks every address in the target for `/.well-known/agent-card.json` on each port, and lists the Agent Cards that answer: name, URL, A2A version and skills. It runs in the background. Progress (probes done of the total, percent, workers found, elapsed time and an estimate of what is left) shows on the status line and in the **A2A scan** pane, which opens when the scan starts; **Stop** there or `/a2a scan stop` ends it. One scan runs at a time. `/a2a scan` on its own says where the scan is, or what it found.

When it ends, tick the workers you want in the pane and press **Add selected**. They are added just as `/a2a add` adds them, each under its card name as the alias (`fake-worker`, then `fake-worker-2` if that is taken), with its token from the tokens setting. The same list is printed in the transcript with an `/a2a add <url> <alias>` line for each, for surfaces without the pane. **Nothing is added until you choose it.** An endpoint you already registered is marked `already added` and not offered again (it is matched by its card URL, so a worker you added by host name is not recognised under its IP).

- **Targets**: an IPv4 CIDR up to a /16, one address, or a range `a.b.c.d-e.f.g.h` (at most 65,536 addresses, inside one block). Only private addresses: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT, Tailscale), 169.254.0.0/16 and 127.0.0.0/8. Anything else is refused, and so is anything wider than a /16. The network and broadcast addresses of a /30 or wider are skipped.
- **Ports**: 80, 443, 8000, 8080 and 41241 by default; `--ports` replaces them with a list such as `8000,9000-9010` (1-65535). https is used on 443 and http elsewhere; `--https` tries https on every port. One scan makes at most 524,288 probes (a /16 on 8 ports).
- **Pace**: 128 probes at once, each given 1 s. Progress updates at most 4 times a second. A mod cannot cancel a request it made, so a probe that gives up leaves the host's request running to its own 30 s timeout; the scan keeps at most 192 of those unsettled at once (under the 256 simultaneous fetches Bun allows by default), and waits when it reaches that.
- **How long**: a /24 on the 5 default ports is 1,270 probes: about 20 s when most addresses are empty, about 3.5 minutes at worst. A /16 on 5 ports is 327,670 probes: a few minutes when the addresses answer or refuse at once, about 85 minutes when most addresses are empty on your own subnet (the host gives up on each after about 3 s, so 192 in flight is about 64 probes a second), and up to about 14 hours when the network silently drops them (each held for the host's 30 s). Scan the smallest range you can.
- Only `/.well-known/agent-card.json` is asked for; a worker that serves only the older `/.well-known/agent.json` is not found.
- **Claude Code sessions are not found by a scan.** They serve no A2A endpoint (the LAN mode that gave them one was removed in 0.7.0); use Claude Code's Remote Control for those.
- Claude has no scan tool: a sweep of the network is something you start yourself.

**Network etiquette.** A scan is many connections to many machines in a short time. Corporate networks, hotel and campus Wi-Fi and cloud VPCs often watch for exactly that, and an intrusion detection system may flag or block your machine. Scan only networks you own or are allowed to scan. The cards that answer are their servers' own text: the mod strips control characters from them, but read a card before you add it.

### 在網路上找 worker（繁體中文）

不知道 worker 的網址時，可以掃描：

```
/a2a scan 192.168.1.0/24
/a2a scan 10.0.0.0/16 --ports 8000,9000-9010
/a2a scan 10.0.0.20-10.0.0.60 --https
```

掃描會對目標裡每個位址的每個 port 要 `/.well-known/agent-card.json`，列出有回應的 Agent Card：名稱、網址、A2A 版本與技能。掃描在背景執行。進度（已探測數／總數、百分比、找到幾個、已花時間、預估剩餘時間）顯示在狀態列和掃描開始時打開的 **A2A scan** 面板；按面板上的 **Stop** 或輸入 `/a2a scan stop` 可中止。同時只能跑一個掃描。單打 `/a2a scan` 會顯示目前進度或掃描結果。

掃完後在面板勾選要加入的 worker，按 **Add selected**。加入方式和 `/a2a add` 完全相同：別名預設取卡片名稱（`fake-worker`，被佔用時改成 `fake-worker-2`），token 來自 tokens 設定。同一份清單也會印在對話紀錄裡，每個附一行 `/a2a add <url> <alias>`，給沒有面板的介面用。**你沒選的，一個都不會加入。** 已登記過的端點會標成 `already added`，不再列為可加入（以卡片網址比對，所以用主機名稱登記的 worker 在 IP 下認不出來）。

- **目標**：IPv4 CIDR（最大 /16）、單一位址，或範圍 `a.b.c.d-e.f.g.h`（最多 65,536 個位址，且須在同一個區塊內）。只接受私有位址：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、100.64.0.0/10（CGNAT、Tailscale）、169.254.0.0/16 和 127.0.0.0/8；其他一律拒絕，比 /16 大的也拒絕。/30 以上的網段會跳過網路位址和廣播位址。
- **Port**：預設 80、443、8000、8080、41241；`--ports` 可換成 `8000,9000-9010` 這類清單（1-65535）。443 用 https，其他用 http；`--https` 則每個 port 都用 https。一次掃描最多 524,288 次探測（/16 乘 8 個 port）。
- **速度**：同時 128 個探測，每個等 1 秒。進度每秒最多更新 4 次。mod 無法取消自己發出的請求，探測放棄後主機端的請求仍會跑到它自己的 30 秒逾時；掃描最多同時留 192 個這種未結束的請求（低於 Bun 預設的 256 個同時 fetch 上限），到了就等。
- **要多久**：/24 掃 5 個預設 port 是 1,270 次探測：大多是空位址時約 20 秒，最差約 3.5 分鐘。/16 掃 5 個 port 是 327,670 次：位址會立刻回應或拒絕時幾分鐘；同網段大多是空位址時約 85 分鐘（主機約 3 秒放棄一個，192 個同時進行約每秒 64 次）；網路默默丟棄封包時最久約 14 小時（每個都卡滿主機的 30 秒）。範圍能多小就多小。
- 只要 `/.well-known/agent-card.json`；只提供舊版 `/.well-known/agent.json` 的 worker 掃不到。
- **掃描找不到 Claude Code session。** 它們沒有 A2A 端點（提供端點的 LAN 模式已在 0.7.0 移除）；要連 Claude Code session 請用 Claude Code 的 Remote Control。
- Claude 沒有掃描工具：掃網路這件事由你自己發動。

**網路禮儀。** 掃描是在短時間內連很多台機器。公司網路、飯店與校園 Wi-Fi、雲端 VPC 常常專門偵測這種行為，入侵偵測系統可能會標記或封鎖你的機器。只掃你擁有或被允許掃描的網路。回應的卡片是對方伺服器自己的文字：mod 會去掉控制字元，但加入前還是先看一下卡片內容。

## Workers in Claude Code's agent tools

The workers you registered with `/a2a add` show up in Claude Code's own agent tools as `a2a:<alias>`, next to the sessions those tools already list:

- **`ListAgents`** lists them after the engine's own listing, under `A2A workers`.
- **`SendMessage`** with `to: "a2a:<alias>"` sends the message to that worker the way the `send` tool does: the band, the pane, the status line, and the wake when a slow task finishes.
- **`SendFile`** with `to: "a2a:<alias>"` sends the files, with the optional message, to that worker. Where the build has no `SendFile`, the mod adds a `send_file` tool that does the same.
- **`/list-agents`** (alias `/peers`), which you type yourself, shows the same workers after the built-in's own list. With no workers it is the built-in's output, unchanged.

Every other recipient is left to Claude Code: local sessions, Remote Control sessions and teammates work exactly as they do without the mod.

Files go inline: each file is read and sent as an A2A file part with its bytes in base64 (1.0 `{ raw, filename, mediaType }`, 0.3 `{ kind: "file", file: { bytes, name, mimeType } }`, whichever the worker speaks). There is no file server and no URL. **The worker must accept file parts**; one that only reads text gets nothing useful from them. A file is at most 4 MiB (what one file read in a mod takes) and the files of one send at most 10 MiB together. A file that is missing, too big or past the total is reported with its error in the result, and the others are still sent; the result gives each sent file's size and sha256. Relative paths are under the session's folder.

The LAN mode of 0.4.0-0.6.1 (a per-session sidecar that found Claude Code sessions on the network) was removed in 0.7.0. To reach a Claude Code session on another machine, use Claude Code's built-in Remote Control.

### Claude Code 的 agent 工具裡的 worker（繁體中文）

用 `/a2a add` 登記的 worker，會以 `a2a:<alias>` 出現在 Claude Code 自己的 agent 工具裡，和那些工具原本列出的 session 並列：

- **`ListAgents`**：在引擎自己的清單後面，以 `A2A workers` 一節列出。
- **`SendMessage`**：`to: "a2a:<alias>"` 時，訊息照 `send` 工具的方式送給那個 worker：輸入框上方的動畫、面板、狀態列，慢的任務做完時會叫醒 Claude。
- **`SendFile`**：`to: "a2a:<alias>"` 時，把檔案（可附訊息）送給那個 worker。這個版本的 Claude Code 沒有 `SendFile` 時，mod 會提供功能相同的 `send_file` 工具。
- **`/list-agents`**（別名 `/peers`，你自己輸入的指令）：在內建清單後面列出同樣的 worker。沒有 worker 時就是內建的原本輸出，完全不變。

其他收件對象一律交給 Claude Code 處理：本機 session、Remote Control session、teammate，行為和沒裝這個 mod 時完全一樣。

檔案直接夾在訊息裡傳送：每個檔案讀進來後，以 base64 位元組放進 A2A 的 file part（1.0 為 `{ raw, filename, mediaType }`，0.3 為 `{ kind: "file", file: { bytes, name, mimeType } }`，依 worker 使用的版本而定），不架檔案伺服器、也沒有 URL。**worker 必須能接受 file part**；只讀文字的 worker 拿到也沒用。單一檔案最多 4 MiB（mod 一次讀檔的上限），一次傳送的所有檔案合計最多 10 MiB。檔案不存在、太大或超過總量時，會在結果裡列出該檔的錯誤，其餘檔案照常送出；結果會附上每個已送出檔案的大小與 sha256。相對路徑以 session 所在資料夾為準。

#### 安裝時要填的設定

全部留空或維持預設就能用。之後要改，用 `/plugin`（選 a2a-mod → configure）或 `claude plugin configure a2a-mod@a2a-mod`，改完重開 Claude Code。

| 設定 | 代表什麼 | 建議填法 | 預設 |
| --- | --- | --- | --- |
| **A2A layout**（`layout`） | a2a 介面顯示多少：`full` 輸入框上方的卡片、狀態列與 worker 面板全開；`pane` 只有面板；`minimal` 只有狀態列 | 不用動；想畫面安靜就選 `minimal` | `full` |
| **A2A animations**（`animations`） | 介面上的轉圈、閃光動畫；關掉改成靜態畫面 | 不用動 | 開 |
| **Worker tokens**（`tokens`） | 用 `/a2a add` 加入的遠端 A2A worker 的 Bearer token，格式 `別名=token`，多組用空白隔開（`w1=abc w2=def`） | 留空；除非你加的 worker 需要 token | 空 |

0.4.0 到 0.6.1 的 LAN 模式（每個 session 啟動一個 sidecar，在區網上找其他 Claude Code session）已在 0.7.0 移除。要連到其他機器上的 Claude Code session，請改用 Claude Code 內建的 Remote Control。

## Learn more

[How it works](https://a2a.khimani.dev/how-it-works) · [Write a worker](https://a2a.khimani.dev/write-a-worker) · [Troubleshooting](https://a2a.khimani.dev/troubleshooting) · [Security](https://a2a.khimani.dev/security) · [Protocol support](https://a2a.khimani.dev/protocol)

## Contributing and license

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). MIT licensed: see [LICENSE](LICENSE). a2a-mod is by [Aliasgar Khimani](https://github.com/NovusEdge); this fork's changes are by [HsuJavis](https://github.com/HsuJavis).
