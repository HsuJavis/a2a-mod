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

> **This is HsuJavis's fork of [NovusEdge/a2a-mod](https://github.com/NovusEdge/a2a-mod)** by Aliasgar Khimani (MIT). It adds a [LAN mode](#lan-mode): Claude Code sessions on the same network find each other and exchange messages and files. Everything else is upstream's.

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

Every Claude Code session on the network that runs this mod with the same secret shows up in the built-in `ListAgents` tool as `lan:<host>/<folder>`, next to the sessions on this machine and the A2A workers you registered (`a2a:<alias>`). Claude talks to them with the built-in `SendMessage` (`to: "lan:<name>"`, or `"a2a:<alias>"` for a worker) and sends files with `SendFile`; where the build has no `SendFile`, the mod adds a `send_file` tool.

Turn it on with the same secret on every machine, then restart Claude Code:

```
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanSecret":"<8 or more characters>"}'
```

`lanName` sets the name others use (default `<hostname>/<folder>`). With no secret LAN mode is off and the mod behaves as upstream's. `LAN_A2A_SECRET` and `LAN_A2A_NAME` in the environment work too, when the options are empty.

- A message in shows as a toast, a row in the `/a2a` pane, and a prompt that starts a turn. It is framed as another agent's words, not yours. Files land in `~/.claude/lan-a2a/inbox/` (`LAN_A2A_INBOX` moves it), with their sha256.
- `/a2a lan` shows this session's address and the sessions it sees; `/a2a list` and the `workers` tool list them too.
- How it works: the mod starts a small Node sidecar (`sidecar/lan-a2a.mjs`, no dependencies) per session. It serves an A2A 1.0/0.3 endpoint on a port from 41400, announces itself by UDP multicast on `239.255.41.99:41399` (TTL 1, this subnet only), and sends files by URL with the shared secret as the bearer token.

Security: anyone with the secret can message your session and drop files in its inbox. Claude is told the text is untrusted, but it still reads it, so use LAN mode on networks you trust and keep the secret to yourself. Traffic is plain HTTP on the LAN: the secret and the content are not encrypted. The agent card at `/.well-known/agent-card.json` is public; everything else needs the secret. Allow UDP 41399 and TCP 41400-41499 in a host firewall, and note that guest Wi-Fi with client isolation blocks multicast.

### LAN 模式（繁體中文）

同一個區網裡、裝了這個 mod 且設定同一組密鑰的每個 Claude Code session，都會出現在內建的 `ListAgents` 工具裡，名稱是 `lan:<主機>/<資料夾>`，和本機的 session、你登記的 A2A worker（`a2a:<alias>`）並列。Claude 用內建的 `SendMessage`（`to: "lan:<名稱>"`，worker 則是 `"a2a:<alias>"`）傳訊息，用 `SendFile` 傳檔案；這個版本的 Claude Code 沒有 `SendFile` 時，mod 會改提供 `send_file` 工具。

在每台機器設定同一組密鑰（至少 8 個字元），然後重開 Claude Code：

```
claude plugin configure a2a-mod@a2a-mod --values-stdin <<< '{"lanSecret":"<至少 8 個字元>"}'
```

`lanName` 可自訂別人用來稱呼你的名稱（預設 `<主機名>/<資料夾>`）。沒有密鑰時 LAN 模式關閉，mod 的行為與上游完全相同。選項留空時，也可用環境變數 `LAN_A2A_SECRET`、`LAN_A2A_NAME`。

- 收到訊息時會跳 toast、在 `/a2a` 面板多一列，並自動開始一個 turn；內容會標示為「另一個 agent 寫的、不是使用者」的不可信輸入。檔案存到 `~/.claude/lan-a2a/inbox/`（可用 `LAN_A2A_INBOX` 改），附 sha256。
- `/a2a lan` 顯示本 session 的位址與看得到的其他 session；`/a2a list` 和 `workers` 工具也會列出。
- 運作方式：每個 session 會啟動一個小型 Node sidecar（`sidecar/lan-a2a.mjs`，零相依），在 41400 起的 port 提供 A2A 1.0/0.3 端點，用 UDP multicast `239.255.41.99:41399`（TTL 1，只限本網段）互相發現，檔案以 URL 傳遞、用共用密鑰當 bearer token。

安全：拿到密鑰的人就能傳訊息給你的 session、把檔案放進 inbox。雖然會告訴 Claude 這是不可信內容，它仍會讀到，所以只在信任的網路使用，密鑰不要外流。區網內走明文 HTTP，密鑰與內容都沒有加密。`/.well-known/agent-card.json` 是公開的，其餘都需要密鑰。主機防火牆要放行 UDP 41399 與 TCP 41400-41499；有「用戶端隔離」的訪客 Wi-Fi 會擋掉 multicast。

## Learn more

[How it works](https://a2a.khimani.dev/how-it-works) · [Write a worker](https://a2a.khimani.dev/write-a-worker) · [Troubleshooting](https://a2a.khimani.dev/troubleshooting) · [Security](https://a2a.khimani.dev/security) · [Protocol support](https://a2a.khimani.dev/protocol)

## Contributing and license

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). MIT licensed: see [LICENSE](LICENSE). a2a-mod is by [Aliasgar Khimani](https://github.com/NovusEdge); LAN mode is by [HsuJavis](https://github.com/HsuJavis).
