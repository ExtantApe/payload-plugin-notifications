import type { Payload } from 'payload'

import type { KindRegistration, NotificationKind } from './types.js'
import { configOf } from './util.js'

const cache = new WeakMap<object, Record<string, NotificationKind>>()

/**
 * Every registered kind: the site's own (the plugin's `kinds` option) and each plugin's registration in
 * `config.custom.notificationKinds`. Read when first needed, not at startup, so plugin order doesn't matter.
 * A key registered twice is an error naming both owners: one owner per kind.
 */
export function kindsOf(payload: Payload): Record<string, NotificationKind> {
  const hit = cache.get(payload.config)
  if (hit) return hit
  const o = configOf(payload)
  const all: Record<string, NotificationKind> = {}
  const owner: Record<string, string> = {}
  const add = (who: string, kinds: Record<string, NotificationKind>) => {
    for (const [key, kind] of Object.entries(kinds ?? {})) {
      if (owner[key]) throw new Error(`Notifications: the kind "${key}" is registered by both ${owner[key]} and ${who}. Each kind has one owner.`)
      if (typeof kind?.text !== 'function') throw new Error(`Notifications: the kind "${key}" from ${who} has no text function.`)
      if (kind.priority !== undefined && !['high', 'normal', 'low'].includes(kind.priority)) throw new Error(`Notifications: the kind "${key}" from ${who} has priority "${String(kind.priority)}"; use high, normal or low.`)
      owner[key] = who
      all[key] = kind
    }
  }
  add('the site', o.ownKinds)
  const regs = payload.config.custom?.notificationKinds as KindRegistration[] | undefined
  if (regs !== undefined && !Array.isArray(regs)) throw new Error('Notifications: `config.custom.notificationKinds` must be an array of { owner, kinds }.')
  for (const reg of regs ?? []) add(String(reg?.owner ?? 'a plugin'), reg?.kinds)
  cache.set(payload.config, all)
  return all
}

/** The preference key for a kind: its group when it has one, so one switch covers the group. */
export const prefKey = (key: string, kind: NotificationKind) => (kind.group ? `group:${kind.group}` : `kind:${key}`)
