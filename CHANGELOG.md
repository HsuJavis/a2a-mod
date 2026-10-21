# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-21

### Added

- Every Claude Code session serves an A2A endpoint, from a zero-dependency Node.js sidecar (`sidecar/a2a-server.mjs`, Node 22 or later) declared in `plugin.json`'s `mcpServers`: HTTP on all interfaces, the first free port in 41400-41499 (`A2A_PORT` pins a port or range; there is no random fallback, and with none free the session has no endpoint and `/a2a` says why). Its Agent Card at `/.well-known/agent-card.json` lists JSON-RPC for A2A 1.0 and 0.3 (and the legacy `url`), carries `a2aMod: { kind: "claude-session", name, id, version, auth }` and a `claude-session` skill, and passes the mod's own discovery. So Claude session to Claude session, and A2A worker (or any A2A client) to Claude session, work as well as Claude session to worker.
- Real A2A task semantics on that endpoint: `SendMessage` / `message/send` make a task (`submitted`, then `working` once the session has it) and return it; `GetTask` / `tasks/get` read it; `CancelTask` / `tasks/cancel` cancel it. A follow-up with the `taskId` of an open task reaches the session as a follow-up; one on an ended task is refused (-32004). An unanswered task fails after an hour, and ended tasks are dropped an hour later. Tested against the `@a2a-js/sdk` client.
- Inbound messages reach Claude as one prompt framed as untrusted input from another agent (`<a2a-message>`, lookalike tags made inert as in 0.6.1), with a toast. Claude answers with `SendMessage` to `a2a-task:<id>` (completes the task with the answer as an artifact), `SendFile` to the same address (adds files, served at an unguessable `/files/<id>` URL while the task is kept), or `a2a-task:<id>:ask` (asks the sender a question: `input-required`). It may answer the asking task without asking the user; running commands, editing or creating files, reading or sending local files or contacting others because a message asks still needs the user's confirmation.
- Inbound file parts, inline bytes (1.0 `raw`, 0.3 `bytes`) or URLs, are saved under `~/.claude/a2a-mod/inbox/` (mode 0600) with their size and sha256; a URL is fetched only from the sender's own address, with no redirects, at most 64 MiB a file and 20 files a message.
- Settings `server` (on by default), `serverToken` (sensitive; empty is open: anyone who can reach the port can message the session; set, a request needs `Authorization: Bearer`, compared in constant time, and the card declares the bearer scheme) and `serverName` (default `<hostname>/<folder>`).
- `/a2a` shows this session's endpoint URL, open or token mode, the inbound task count and other addresses, or why there is no endpoint.

### Changed

- `ListAgents` and `/list-agents` start their a2a part with this session's endpoint (`/a2a add http://<ip>:<port>` for others), list registered Claude Code sessions under `Claude Code sessions` apart from `A2A workers`, and list inbound tasks waiting for a reply as `a2a-task:<id>`. With the sidecar down and nothing registered they are the built-in's own.
- `/a2a scan` runs in the sidecar: TCP connect probes (512 at once, 300 ms each; `A2A_SCAN_CONCURRENCY`, `A2A_SCAN_TIMEOUT_MS`) and an Agent Card request (1.5 s) only on open ports, so **Stop** and `/a2a scan stop` are immediate. The default ports add 41400-41409 for Claude Code sessions; one scan takes up to 1,048,576 probes (a /16 on 16 ports). Hits are labelled Claude Code session or A2A worker; this session is left out and a session seen at several addresses is listed once. Measured over loopback: a /24 on the 15 default ports in under 1 s, a /20 in 8.3 s. Without the sidecar the scan says it needs it.
- A worker record keeps `kind: "claude-session"` for a session's card; `/a2a add`, `/a2a list` and the add dialog say so.

### Removed

- The in-mod scan pump (`$.http.fetch` probes with the in-flight cap of 192).

### Security

- The sidecar's MCP tools (`status`, `inbox`, `reply`, `scan_start`, `scan_progress`, `scan_stop`) are refused to the model by a `tool.check` hook; only the mod calls them.

## [0.8.0] - 2026-10-21

### Added

- `/a2a scan <target> [--ports <list>] [--https]` finds A2A workers on a private network: it asks every address and port for `/.well-known/agent-card.json` (through the same discovery as `/a2a add`) and lists the cards that answer. Targets are an IPv4 CIDR up to a /16, one address or a range `a.b.c.d-e.f.g.h`, inside 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 or 127/8 only; network and broadcast addresses of a /30 or wider are skipped. Ports default to 80, 443, 8000, 8080 and 41241 (https on 443; `--https` everywhere); at most 524,288 probes a scan.
- The scan runs in the background, 128 probes at once with 1 s each and at most 192 host requests unsettled. Progress (done/total, percent, found, elapsed, ETA) shows on the status line and in a new **A2A scan** pane, at most 4 times a second; **Stop** or `/a2a scan stop` cancels it, and one scan runs at a time. `/a2a scan` alone prints where it is or what it found.
- In the scan pane the person ticks the workers to add and presses **Add selected**: the same Worker record as `/a2a add`, the card name's slug as the alias (suffixed `-2`, `-3` when taken or held by the tokens setting), the token from the tokens setting. The result list is also printed with an `/a2a add <url> <alias>` line per worker. Endpoints already registered are marked `already added`. Nothing is added without the person's choice, and Claude gets no scan tool.


## [0.7.0] - 2026-10-21

### Added

- `SendFile` to `a2a:<alias>` sends the files, with the optional message, to that registered worker through the worker send (band, pane, status line and wake as for `SendMessage`). The files go inline as A2A file parts with their bytes in base64: 1.0 `{ raw, filename, mediaType }`, 0.3 `{ kind: "file", file: { bytes, name, mimeType } }`, per the worker's version; the worker must accept file parts. At most 4 MiB a file and 10 MiB a send; a file that is missing, too big or past the total is a per-file error in the result and the rest are still sent, each sent file with its size and sha256. Where the build has no `SendFile`, a `send_file` tool does the same for `a2a:` workers. Every other recipient is left to Claude Code.

### Changed

- The built-in `/list-agents` (alias `/peers`) shows the registered A2A workers after its own output, in the words `ListAgents` uses. With no workers, or when they cannot be read, it is the built-in's own.
- `ListAgents` names `SendFile` beside `SendMessage` for the `a2a:<alias>` workers.

### Removed

- LAN mode: the per-session sidecar (`sidecar/lan-a2a.mjs` and the `mcpServers` entry), the `lan`, `lanSecret`, `lanName` and `lanPeers` options, `lan:<name>` addresses in `ListAgents`, `SendMessage` and `SendFile`, inbound LAN messages, `/a2a lan` (and `add`/`remove`), the LAN box in the pane and the LAN lines in the `workers` tool and `/a2a list`. For Claude Code sessions on other machines, use Claude Code's built-in Remote Control. The registered workers stay in `ListAgents` and `SendMessage` as `a2a:<alias>`.

## [0.6.1] - 2026-10-20

### Added

- The built-in `/list-agents` command (alias `/peers`) shows the LAN agents after its own output, in the words `ListAgents` uses; with no peers it says none are seen yet and points at `/a2a lan`. With LAN mode off it is the built-in's own; with the sidecar down it gains one line. The model's notes from the command are left as they were.

### Security

- An inbound LAN message can no longer close or reopen its frame with a lookalike tag: zero-width characters, soft hyphens or spaces inside the name, full-width or small angle brackets, full-width letters and solidus, and dash lookalikes (U+2010-U+2015, U+2212, U+FE58, U+FE63, U+FF0D) are folded before the check, and only the bracket is escaped, so the rest of the text (emoji sequences included) arrives as sent.

## [0.6.0] - 2026-10-20

### Added

- LAN discovery that does not depend on multicast alone. Each announce also goes to every LAN interface's subnet broadcast address, and every announce carries how it was sent.
- A TCP hello, `POST /lan/hello` (open mode: no auth; secret mode: the bearer, as on `/a2a`): the body is an announce, checked as one; the receiver registers the sender at the address it connected from and answers with its own announce, so one call teaches both sides.
- Static peers: `/a2a lan add <host>[:port]` and `/a2a lan remove <host>`, kept in the mod's store, and the `lanPeers` option (space-separated host[:port]). With no port, 41400-41409 are tried. The sidecar hellos them over TCP every announce period, so a peer stays alive when all UDP is dropped. A static peer that answers the hello with 404 (0.5.x) is registered from its agent card, when the card asks for no auth and this session is in open mode; only the card is fetched.
- The agent card carries `lanA2a` (`id`, `name`, `mode`, and `group` in open mode only: a secret-mode group is a hash of the secret).
- `/a2a lan` says how each peer was found (multicast, broadcast, hello, static), lists the static peers, and with no peers gives a troubleshooting hint: firewall ports, VPN and multicast, `/a2a lan add <ip>`.
- `LAN_A2A_NO_MCAST=1` runs the sidecar with no UDP at all (static peers only).
- The README (English and 繁體中文) has a troubleshooting section: ufw commands, macOS firewall, Local Network permission and VPN notes.

## [0.5.1] - 2026-10-20

### Changed

- The frame around an inbound LAN message (open and secret mode alike) now lets Claude reply to the sender with SendMessage to its `lan:` address without asking the user, so a conversation runs in real time. Running commands, editing or creating files, reading or sending local files (SendFile, send_file) and contacting any other peer because a message asks still need the user's confirmation. Before, open mode told Claude to ask the user first even for a reply.

## [0.5.0] - 2026-10-20

### Added

- LAN open mode, now the default: with no `lanSecret`, sessions join a fixed public discovery group and talk with no bearer on `/a2a` or `/files` and no `Authorization` header out. Open and secret sessions do not see each other. Files are still served only by an unguessable id for an hour and fetched only from the sender's host.
- A `lan` option (default on). Off, the sidecar opens no socket and the mod behaves as upstream's.
- `/a2a lan` names the mode: open, secret or off.

### Changed

- `lanSecret` is optional: empty is open mode, 8 or more characters is secret mode as before, and 1 to 7 characters is refused with the reason instead of running.
- A message from an open-mode sender is framed for Claude as coming from an unauthenticated LAN host, with its IP: untrusted content, and no commands, file edits or file sends on its say-so without the user's confirmation.
- The README documents the modes, open mode's risks, and the random-port fallback past 41400-41499.

### Fixed

- A LAN message's text could close its `<lan-message>` frame and forge the mod's header lines; every `lan-message` tag in it, in any case or spacing (zero-width characters included), is made inert. Peer names and addresses keep to letters, digits and `. _ / -` (64 characters), and hosts to IP characters.
- A message naming another peer's id in its metadata showed under that peer's name from any host; the name now needs the message to come from an address that peer announced from.

## [0.4.0] - 2026-10-20

### Added

- LAN mode, in HsuJavis's fork: Claude Code sessions on one network that share the new `lanSecret` option find each other by UDP multicast and show in `ListAgents` as `lan:<host>/<folder>`, beside the registered workers as `a2a:<alias>`. `SendMessage` to `lan:<name>` or `a2a:<alias>`, and `SendFile` to `lan:<name>`, go through the mod; where the build has no `SendFile`, a `send_file` tool does. A message in is a toast, a row in the pane's LAN box, and a prompt framed as untrusted. `/a2a lan` shows the session's address. A per-session Node sidecar (`sidecar/lan-a2a.mjs`, declared in `mcpServers`) holds the sockets. With no secret nothing changes.

### Changed

- The manifest's author, homepage and repository, and the marketplace owner, point at the fork.

### Fixed

- Twelve band tests failed on Claude Code 2.1.304, whose test kit tags drawn trees with `part`; they compare with `toMatchObject` now.

## [0.3.1] - 2026-10-04

### Fixed

- The message that wakes Claude shows as one short line (`a2a: fake task … completed`); the full result goes to Claude without filling the transcript. Claude Code never drew the wake card, so the old message showed as the engine's raw framed text.
- The `send` result now tells Claude what the wake line looks like, that it comes from the mod and not the user, and to call `task` if it carries no result.

## [0.3.0] - 2026-10-04

### Added

- `add_worker` and `remove_worker` tools: Claude can register and forget a worker. Each call opens a dialog the user answers, in every permission mode; Cancel, a dismissed dialog or a `-p` run changes nothing. A tool-added worker uses the `tokens` setting only. Token commands, token files and `--trust-endpoint` stay in the user's own `/a2a add`.

### Security

- `add_worker` refuses to refresh a worker whose card or endpoint is on a different origin from the stored one, and to give a new worker an alias that already has a token in the `tokens` setting. Both need the user's own `/a2a add`. Before, a refresh could point a worker with a stored token at another host.
- `add_worker` refreshes an existing alias only from the exact card URL it was stored with. Before, another path on the same host passed the origin check, so on a shared host one tenant could take over another's alias.
- `add_worker` never cuts the endpoint origin in the dialog and refuses one over 100 characters. The dialog's Authentication line says whether a token would really be sent.
- Aliases such as `constructor` or `toString` no longer match members of `Object.prototype` in the worker and token lookups; `__proto__` is refused as an alias.
- `add_worker` tells Claude only "Could not read an Agent Card at that URL." when the fetch fails, so it cannot probe addresses through the HTTP status. `/a2a add` keeps the detail.
- Unicode format characters (bidi overrides, zero-width spaces) are stripped from the dialog and from worker text shown to Claude and the user. Zero-width joiners stay in worker text.

### Fixed

- `/a2a remove` now also drops the worker's run-time history, so a worker added again under the same alias starts without the old averages.
- A task's wake message draws as the boxed wake card again. It was skipped whenever Claude Code reported the row as expanded, and when the engine wrapped the text in its "plugin sent a message" framing.
- The "needs input" result card shows the worker's question and `task <id> · reply in the a2a pane`, not the summary line written for Claude. Completed and failed cards likewise show only the result or the error.
- The status line no longer starts with `a2a`: Claude Code already prefixes the mod's name, so it read `a2a-mod: a2a ⠋ …`.
- In the workers pane, `Clear done` sits on its own right-aligned row under the rule instead of running into the worker count.

## [0.2.0] - 2026-10-04

### Changed

- The status line shows the live task: `a2a ⠋ fake slow 20 build 0:12`. With several tasks it reads `a2a ⠋ 2 running · 1 waiting`; a task that asks a question reads `a2a ? fake waiting: <question>`; a task that just ended shows `a2a ✓ fake done 0:20` for 5 seconds. It updates once a second while a task runs.
- The hand-off band above the prompt draws only while a task runs or waits, plus the 2-second return packet after the last one ends. It no longer lingers for 10 minutes, and its chips no longer show elapsed time.
- The workers pane opens only when you run `/a2a`, never on its own, so a running task no longer switches the dock away from `/diff`. It asks for a slim dock (32 columns) or a short block (12 rows) and does not take the keyboard.
- The workers pane is redrawn for that width, and holds down to 24 columns: a header (`⇄ a2a` and a count of workers and live tasks), one rounded box per worker with its tasks inside, and a footer with the key hints pinned to the bottom. Rows run the full width, with times and versions at the right edge. The empty pane is centred.
- The transcript cards for `send` and for wake messages are rounded boxes, indented two columns and as wide as the transcript allows (up to 100). The worker is in the header with its version and organization at the right; the message is wrapped under a quote bar; the result has a coloured badge (`● tracked`, `✓ completed`, `? needs input`, `✕ failed`) and an indented body. A tracked task reads `tracked · task 5954ae32 · you'll be told when it lands` instead of the text written for Claude.

- The workers pane starts with an agent tree: `Claude` and a branch per worker with its task counts by state (`● 1  ? 1  ✓ 4`). Pressing a branch folds or opens that worker's box, which shows `▾` or `▸` in its title.
- A worker box lists three tasks, running and waiting first. `+N more` lists them all and `show less` goes back. Fold state and the list size are kept for the session.
- A task row is one line and the line is the button. Pressing it opens the task (one at a time) with its result, question or latest status message, then only the actions its state allows in one row: Copy, Reply, Cancel. A waiting row ends with a violet `reply ↵`. The Cancel, Open and Reply buttons at the edge of every row are gone.
- `Clear done` in the pane header hides finished tasks from the pane. The transcript cards keep them.
- The running row's glyph and shimmer no longer animate; its bar and elapsed time do, on the line under the task.

### Fixed

- A task whose send was cut short by a reload no longer leaves the status line spinning: on reload a running task nobody tracks is tracked again, or marked removed when its worker is gone.
- The empty pane, the header and the transcript cards are cut to the width they are given, down to 10 columns.
- The status line says `failed` for a rejected task, as the result card does.
- A `send` result card reads `✓ completed` (or the state it reached) once the task lands, instead of staying on `tracked`.
- The band is described as a wire line with a row of chips, not one row.

## [0.1.0] - 2026-10-04

### Added

- Tools for Claude: `mcp__a2a-mod__workers` lists registered workers and their skills, `mcp__a2a-mod__send` sends a task, and `mcp__a2a-mod__task` reads or cancels one.
- `/a2a add <url> [alias]`, `/a2a list` and `/a2a remove <alias>` to manage workers. `/a2a list` also shows running tasks and their age.
- A2A protocol 1.0 and 0.3 over the JSON-RPC binding. The version comes from the Agent Card.
- Background tracking: a task that does not finish within about 7 seconds is polled every 5 seconds, and Claude gets a message when it finishes. A worker that fails 6 polls in a row is dropped, and Claude is told. The status line shows `a2a: N running`.
- A workers pane (`/a2a` with no arguments opens it). It lists each worker's version, skills and recent run times, and its tasks from the last 10 minutes. Running tasks have an animated row with elapsed time and a progress bar. Buttons: Cancel, Open (the full result, with Copy; one result open at a time), and Reply for a worker that asked a question. The pane opens on its own when a task is tracked, if the terminal is wide enough.
- Cards for the `send` tool in the transcript: the worker, its A2A version and organization, the message, a live row while it runs, and a state badge on the result. A completed result types itself in once.
- A card for each task in the message that wakes Claude. Press ctrl+o to see the raw message.
- A hand-off band above the prompt while tasks run or finished in the last 10 minutes: `Claude ┄●┄ worker` with a packet going out and coming back, and a chip per running or waiting task. It shares the band with other mods and yields to surveys.
- `layout` setting in `/config`: `full` (default), `pane` (the workers pane only) or `minimal` (the status line only). `animations` setting: off draws every effect as one still frame.
- Bearer tokens for workers, from one of three sources per worker: the sensitive `tokens` setting (`alias=token` pairs separated by spaces, the default; `/a2a add` prints the command to set it only for workers whose card asks for authentication), `--token-cmd "<command>"` (run without a shell; stdout is the token), or `--token-file <path>`. Command and file tokens are cached for 5 minutes and fetched again after a 401 or 403. A token is never typed into `/a2a`, and every text the mod emits has it replaced with `[token]`.
- The origin rule: a token is not sent to an endpoint on another origin than the worker's card unless the worker was added with `--trust-endpoint`.

### Changed

- `/a2a` with no arguments opens the workers pane, and still prints the usage text.
- A task that asks a question stays listed as waiting until someone answers it, and the status line adds `· N waiting`.
- Worker text shown in the UI has terminal control characters removed (ANSI colour codes, bells).

