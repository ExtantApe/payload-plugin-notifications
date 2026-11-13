import type { Endpoint, PayloadRequest } from 'payload'

import { getPreferences, listNotifications, markRead, setPreference, unreadCount } from './read.js'
import type { ID } from './types.js'
import { configOf, errorShape } from './util.js'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** The signed-in person and their site. Anyone else gets 401; a site that can't be worked out gets 403. */
async function who(req: PayloadRequest): Promise<{ user: ID; scope: ID | null } | Response> {
  const o = configOf(req.payload)
  if (!req.user || req.user.collection !== o.users) return json({ error: 'Sign in first.' }, 401)
  let scope: ID | null = null
  if (o.scopeField) {
    try {
      scope = (await o.scopeFor?.(req)) ?? null
    } catch {
      scope = null
    }
    if (scope === null) return json({ error: 'No site for this request.' }, 403)
  }
  return { user: req.user.id as ID, scope }
}

const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  try {
    return ((await req.json?.()) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

const guarded =
  (fn: (req: PayloadRequest, me: { user: ID; scope: ID | null }) => Promise<Response>) =>
  async (req: PayloadRequest) => {
    const me = await who(req)
    if (me instanceof Response) return me
    try {
      return await fn(req, me)
    } catch (error) {
      req.payload.logger.error({ ...errorShape(error), msg: 'notifications: request failed' })
      return json({ error: 'Something went wrong. Please try again.' }, 400)
    }
  }

/** On the notifications collection: /api/<notifications>/mine, /unread and /read. Collection endpoints come before Payload's own `/:id`. */
export const notificationEndpoints: Endpoint[] = [
  {
    path: '/mine',
    method: 'get',
    handler: guarded(async (req, me) => {
      const q = new URL(req.url ?? 'http://x').searchParams
      const before = q.get('before') ?? undefined
      return json({ docs: await listNotifications(req.payload, { ...me, limit: Number(q.get('limit') ?? 50) || 50, before: before && !Number.isNaN(Date.parse(before)) ? before : undefined, locale: req.locale ?? undefined, req }) })
    }),
  },
  { path: '/unread', method: 'get', handler: guarded(async (req, me) => json({ count: await unreadCount(req.payload, { ...me, req }) })) },
  {
    path: '/read',
    method: 'post',
    handler: guarded(async (req, me) => {
      const b = await body(req)
      const marked = await markRead(req.payload, { ...me, all: b.all === true, ids: Array.isArray(b.ids) ? (b.ids as ID[]) : [], req })
      return json({ marked })
    }),
  },
]

/** On the preferences collection: /api/<notification-preferences>/mine, to read and to change one switch. */
export const preferenceEndpoints: Endpoint[] = [
  { path: '/mine', method: 'get', handler: guarded(async (req, me) => json(await getPreferences(req.payload, { ...me, req }))) },
  {
    path: '/mine',
    method: 'post',
    handler: guarded(async (req, me) => {
      const b = await body(req)
      if (typeof b.key !== 'string' || typeof b.email !== 'boolean') return json({ error: 'Send { key, email }.' }, 400)
      await setPreference(req.payload, { ...me, key: b.key, email: b.email, req })
      return json(await getPreferences(req.payload, { ...me, req }))
    }),
  },
]
