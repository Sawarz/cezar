/**
 * Permission mode presets (spec 2026-07-17-permission-modes, #475).
 * Shared by Settings → Agents and the new-task composer pill.
 */

export type PermissionMode = 'auto' | 'guarded' | 'read-only' | 'manual'

export const PERMISSION_MODES: ReadonlyArray<{
  id: PermissionMode
  label: string
  desc: string
  /** Short phrase used in the autonomous-conflict copy ("shell commands and network access"). */
  askWhat: string
}> = [
  {
    id: 'auto',
    label: 'Auto',
    desc: 'Run without asking — the agent edits files and runs commands on its own (default).',
    askWhat: '',
  },
  {
    id: 'guarded',
    label: 'Guarded',
    desc: 'Edits run automatically; shell commands and network access ask first.',
    askWhat: 'shell commands and network access',
  },
  {
    id: 'read-only',
    label: 'Read-only',
    desc: 'The agent may read the repo; any change or command asks first.',
    askWhat: 'any change or command',
  },
  {
    id: 'manual',
    label: 'Manual',
    desc: 'Every tool use asks first.',
    askWhat: 'every tool use',
  },
]

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode
}

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.some((m) => m.id === value)
}

/** Parse one-specifiers-per-line textareas into rule arrays (empty → undefined). */
export function parsePermissionRulesText(text: string): string[] | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines : undefined
}

export function formatPermissionRulesText(rules: string[] | undefined): string {
  return (rules ?? []).join('\n')
}
