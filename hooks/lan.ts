import type { Fetcher } from './client.ts'
import { SidecarDown, type Sidecar } from './inbound.ts'

// On macOS, Local Network privacy can keep Claude Code itself off the LAN while the node sidecar it
// started reaches it: $.http.fetch then fails with EHOSTUNREACH. Such a request is made again through
// the sidecar's http tool, and its host goes that way for the rest of the session. Nothing here
// touches $: register.ts hands in both paths.

/** Errors that say this process may not reach the host, not that the host said no. ECONNREFUSED is an answer. */
const BLOCKED = /EHOSTUNREACH|ENETUNREACH|EPERM|EACCES|Local Network/i

export const LAN_HINT = 'macOS: allow the terminal app under System Settings → Privacy & Security → Local Network, then restart it.'

/** Hosts (by name, so every port on a box) that go through the sidecar. A reload starts it empty. */
const viaSidecar = new Set<string>()

/** How long the sidecar waits on one request. The callers' own deadlines are shorter. */
const SIDECAR_TIMEOUT_MS = 30_000

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return url } }

async function throughSidecar(sidecar: Sidecar, url: string, init: Parameters<Fetcher>[1]): ReturnType<Fetcher> {
  const out = await sidecar('http', { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), timeoutMs: SIDECAR_TIMEOUT_MS })
  if (typeof out.error === 'string') throw new Error(out.error)
  const status = Number(out.status)
  return { status, ok: status >= 200 && status < 300, text: String(out.text ?? '') }
}

/** The direct fetch, falling back to the sidecar for a host Claude Code may not reach. */
export function lanFetch(direct: Fetcher, sidecar: Sidecar): Fetcher {
  return async (url, init) => {
    const host = hostOf(url)
    if (viaSidecar.has(host)) {
      try { return await throughSidecar(sidecar, url, init) } catch (err) {
        if (!(err instanceof SidecarDown)) throw withHint(`through the a2a-mod sidecar: ${messageOf(err)}`)
        // The sidecar went away: the host is tried directly again, as at first.
        viaSidecar.delete(host)
      }
    }
    let first: unknown
    try { return await direct(url, init) } catch (err) {
      if (!BLOCKED.test(messageOf(err))) throw err
      first = err
    }
    try {
      const res = await throughSidecar(sidecar, url, init)
      viaSidecar.add(host)
      return res
    } catch (err) {
      const why = err instanceof SidecarDown ? `the a2a-mod sidecar, which could try it instead, is not running (${messageOf(err)})` : `through the a2a-mod sidecar too: ${messageOf(err)}`
      throw withHint(`${messageOf(first)}; ${why}`)
    }
  }
}

const withHint = (text: string) => new Error(BLOCKED.test(text) ? `${text}. ${LAN_HINT}` : text)
