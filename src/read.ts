import type { CollectionSlug, Payload, Where } from 'payload'

import { kindsOf, prefKey } from './kinds.js'
import type { ID, Req } from './types.js'
import { asReq, configOf, DAY, idOf } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const sys = { overrideAccess: true, depth: 0 } as const

const mine = (payload: Payload, user: ID, scope: ID | null): Where => {
  const o = configOf(payload)
  const where: Where = { and: [{ recipient: { equals: user } }] }
  if (o.scopeField) where.and!.push({ [o.scopeField]: { equals: scope } })
  return where
}

export type ListedNotification = { id: ID; kind: string; text: string; link: string | null; createdAt: string; read: boolean }

/** A person's notices on one site, newest first, with their words filled in from the kind. */
export async function listNotifications(payload: Payload, args: { user: ID; scope?: ID | null; limit?: number; before?: string; locale?: string; req?: Req }): Promise<ListedNotification[]> {
  const o = configOf(payload)
  const where = mine(payload, args.user, idOf(args.scope))
  if (args.before) where.and!.push({ createdAt: { less_than: args.before } })
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 100)
  const docs = (await payload.find({ collection: o.notifications as CollectionSlug, where, sort: '-createdAt', limit, pagination: false, ...sys, req: asReq(payload, args.req) })).docs as Doc[]
  const kinds = kindsOf(payload)
  return docs.map((d) => {
    const kind = kinds[d.kind]
    let text = ''
    try {
      text = kind ? kind.text((d.params ?? {}) as Record<string, string>, { locale: args.locale }) : ''
    } catch {
      text = ''
    }
    return { id: d.id, kind: d.kind, text, link: d.link ?? null, createdAt: d.createdAt, read: Boolean(d.readAt) }
  })
}

export async function unreadCount(payload: Payload, args: { user: ID; scope?: ID | null; req?: Req }): Promise<number> {
  const o = configOf(payload)
  const where = mine(payload, args.user, idOf(args.scope))
  where.and!.push({ readAt: { exists: false } })
  return (await payload.count({ collection: o.notifications as CollectionSlug, where, overrideAccess: true, req: asReq(payload, args.req) })).totalDocs
}

/** Marks the person's own notices read: the ones named, or all. Others' notices are never touched. */
export async function markRead(payload: Payload, args: { user: ID; scope?: ID | null; ids?: ID[]; all?: boolean; req?: Req }): Promise<number> {
  const o = configOf(payload)
  const where = mine(payload, args.user, idOf(args.scope))
  where.and!.push({ readAt: { exists: false } })
  if (!args.all) {
    const ids = (args.ids ?? []).filter((i) => typeof i === 'string' || typeof i === 'number').slice(0, 500)
    if (!ids.length) return 0
    where.and!.push({ id: { in: ids } })
  }
  const res = await payload.update({ collection: o.notifications as CollectionSlug, where, data: { readAt: new Date().toISOString() } as never, ...sys, req: asReq(payload, args.req), context: { audit: false } })
  return res.docs.length
}

// ---------------------------------------------------------------------------------------------
// Preferences

export type PreferenceRow = { key: string; label: string; email: boolean; required: boolean }

/** The switches a person sees: all email, then one per group (or per kind without a group) that can be emailed. */
export async function getPreferences(payload: Payload, args: { user: ID; scope?: ID | null; req?: Req }): Promise<{ allEmail: boolean; rows: PreferenceRow[] }> {
  const doc = await prefsDoc(payload, args.user, idOf(args.scope), args.req)
  const own = (doc?.email ?? {}) as Record<string, unknown>
  const rows = new Map<string, PreferenceRow>()
  for (const [key, kind] of Object.entries(kindsOf(payload))) {
    if (typeof kind.email !== 'function') continue
    const k = prefKey(key, kind)
    const prev = rows.get(k)
    const def = kind.emailByDefault !== false
    const choice = typeof own[k] === 'boolean' ? (own[k] as boolean) : def
    rows.set(k, { key: k, label: kind.group ?? key, email: kind.required ? true : choice, required: Boolean(kind.required) || Boolean(prev?.required) })
  }
  return { allEmail: doc?.allEmail !== false, rows: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label)) }
}

/** Sets one switch: `all` for every email, or a key from `getPreferences`. Unknown keys are refused. */
export async function setPreference(payload: Payload, args: { user: ID; scope?: ID | null; key: string; email: boolean; req?: Req }): Promise<void> {
  const o = configOf(payload)
  if (typeof args.email !== 'boolean') throw new Error('Notifications: a preference is true or false.')
  const scope = idOf(args.scope)
  if (o.scopeField && scope === null) throw new Error('Notifications: no site for this preference.')
  const known = args.key === 'all' || Object.entries(kindsOf(payload)).some(([k, kind]) => typeof kind.email === 'function' && prefKey(k, kind) === args.key)
  if (!known) throw new Error('Notifications: no such preference.')
  const r = asReq(payload, args.req)
  const doc = await prefsDoc(payload, args.user, scope, args.req)
  const data = args.key === 'all' ? { allEmail: args.email } : { email: { ...((doc?.email ?? {}) as object), [args.key]: args.email } }
  if (doc) await payload.update({ collection: o.preferences as CollectionSlug, id: doc.id, data: data as never, ...sys, req: r })
  else await payload.create({ collection: o.preferences as CollectionSlug, data: { user: args.user, ...(o.scopeField ? { [o.scopeField]: scope } : {}), ...data } as never, ...sys, req: r })
}

async function prefsDoc(payload: Payload, user: ID, scope: ID | null, req?: Req): Promise<Doc | undefined> {
  const o = configOf(payload)
  const where: Where = { and: [{ user: { equals: user } }] }
  if (o.scopeField) where.and!.push({ [o.scopeField]: { equals: scope } })
  return ((await payload.find({ collection: o.preferences as CollectionSlug, where, limit: 1, pagination: false, ...sys, req: asReq(payload, req) })).docs as Doc[])[0]
}

// ---------------------------------------------------------------------------------------------
// Retention

/** Deletes read notices older than `retentionDays`, and unread ones older than twice that. Run it daily. */
export async function pruneNotifications(payload: Payload, now = new Date()): Promise<number> {
  const o = configOf(payload)
  const readCut = new Date(now.getTime() - o.retentionDays * DAY).toISOString()
  const unreadCut = new Date(now.getTime() - 2 * o.retentionDays * DAY).toISOString()
  const where: Where = {
    or: [
      { and: [{ readAt: { exists: true } }, { createdAt: { less_than: readCut } }] },
      { createdAt: { less_than: unreadCut } },
    ],
  }
  const res = await payload.delete({ collection: o.notifications as CollectionSlug, where, ...sys })
  return res.docs.length
}
