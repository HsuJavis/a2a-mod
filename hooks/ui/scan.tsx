import type { RenderElement } from 'claude-code'
import type { ScanState } from '../../types/index.d.ts'
import { progressLine } from '../scan.ts'
import { fit } from './fx.ts'
import type { PaneEls } from './pane.tsx'

export type ScanActions = { stop(): void; toggle(url: string): void; add(): void }

export type ScanData = {
  width: number
  height: number
  state: ScanState | null
  /** A scan is running in this module, not just left as running in the state by a reload. */
  running: boolean
  /** The alias each hit would be added under. */
  aliases: ReadonlyMap<string, string>
}

/** The scan pane: progress and Stop while it runs, then the hits to tick and Add. (`h` is the JSX factory: no variable here may take that name.) */
export function scanTree(el: Pick<PaneEls, 'Box' | 'Text' | 'Button'>, d: ScanData, act: ScanActions): RenderElement {
  const { Box, Text, Button } = el
  const inner = Math.max(1, d.width - 2)
  const frame = { width: d.width, minHeight: d.height, paddingX: 1, paddingTop: 1 } as const
  const s = d.state
  if (!s) {
    return (
      <Box flexDirection="column" {...frame}>
        <Text>{fit('No scan yet', inner)}</Text>
        <Text color="inactive">{fit('/a2a scan <target> [--ports <list>]', inner)}</Text>
      </Box>
    )
  }
  const live = d.running && s.phase === 'running'
  const title = live ? 'Scanning' : s.phase === 'done' ? 'Scan done' : 'Scan stopped'
  const barWidth = Math.max(1, inner)
  const filled = s.total ? Math.round((barWidth * s.done) / s.total) : barWidth
  const rule = <Text color="inactive">{'─'.repeat(inner)}</Text>
  return (
    <Box flexDirection="column" {...frame}>
      <Text bold>{fit(`${title} ${s.target} · ports ${s.ports.join(',')}`, inner)}</Text>
      <Text>
        <Text color="success">{'█'.repeat(filled)}</Text>
        <Text color="inactive">{'░'.repeat(barWidth - filled)}</Text>
      </Text>
      <Text>{fit(progressLine(s), inner)}</Text>
      {live ? <Box><Button key="scan-stop" label="Stop" onPress={() => act.stop()} /></Box> : null}
      {rule}
      {s.hits.length ? null : <Text color="inactive">{fit(live ? 'Nothing found yet.' : 'No session or worker answered.', inner)}</Text>}
      {s.hits.map(hit => {
        const kind = hit.kind === 'claude-session' ? 'Claude Code session' : 'A2A worker'
        const detail = fit(`   ${kind} · ${hit.url} · A2A ${hit.version}${hit.skills.length && !hit.kind ? ` · ${hit.skills.join(', ')}` : ''}`, inner)
        if (hit.known) {
          return (
            <Box flexDirection="column">
              <Text color="inactive">{fit(` ✓ ${hit.name} · already added as ${hit.known}`, inner)}</Text>
              <Text color="inactive">{detail}</Text>
            </Box>
          )
        }
        const picked = s.picked.includes(hit.url)
        return (
          <Box flexDirection="column">
            <Box>
              <Button key={`pick:${hit.url}`} plain label={fit(`${picked ? '[x]' : '[ ]'} ${hit.name}`, Math.max(1, inner - 20))} onPress={() => act.toggle(hit.url)} />
              <Text color="inactive">{fit(` as ${d.aliases.get(hit.url) ?? ''}`, 20)}</Text>
            </Box>
            <Text color="inactive">{detail}</Text>
          </Box>
        )
      })}
      {!live && s.picked.length ? <Box marginTop={1}><Button key="scan-add" variant="primary" label={`Add selected (${s.picked.length})`} onPress={() => act.add()} /></Box> : null}
      <Box flexGrow={1} />
      {rule}
      <Text color="inactive">{fit(live ? '/a2a scan stop cancels' : 'Tick to add; nothing is added until you do', inner)}</Text>
    </Box>
  )
}
