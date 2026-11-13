import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getPreferences,
  listNotifications,
  markRead,
  notificationsPlugin,
  notify,
  pruneNotifications,
  sendPendingNotifications,
  setPreference,
  unreadCount,
  type KindRegistration,
  type NotificationKind,
} from '../src/index.js'

// Made-up people on a throwaway in-memory database, on two made-up sites.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const sent: { to: string; subject: string; text: string; kind: string }[] = []
let sendFails: number | 'always' = 0
const logs: unknown[] = []

const kinds: Record<string, NotificationKind> = {
  'transfer-offered': {
    text: (p) => `${p.from} offered you ${p.animal}`,
    email: (p, { link }) => ({ subject: `${p.from} wants to transfer ${p.animal} to you`, text: `Open ${link}` }),
    group: 'Transfers',
    priority: 'normal',
  },
  'transfer-accepted': { text: (p) => `${p.animal} was accepted`, email: (p) => ({ subject: `${p.animal} was accepted`, text: 'Accepted.' }), group: 'Transfers', priority: 'low' },
  'only-on-site': { text: () => 'Something small happened' },
  'account-approved': { text: () => 'You’re in', email: () => ({ subject: 'You’re in', text: 'Welcome.' }), required: true, priority: 'high' },
  'quiet-by-default': { text: () => 'A digest item', email: () => ({ subject: 'Digest', text: '.' }), emailByDefault: false },
}
/** Another plugin's kinds, registered after Notifications in the plugin list. */
const other: KindRegistration = { owner: 'a made-up plugin', kinds: { 'kit-ready': { text: (p) => `Kit ${p.code} is ready`, email: (p) => ({ subject: `Kit ${p.code}`, text: 'Ready.' }) } } }

const baseConfig = (extra: Partial<Parameters<typeof notificationsPlugin>[0]> = {}, plugins: ((c: Config) => Config)[] = []) =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    serverURL: 'https://site.example.com',
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('notifications'), ensureIndexes: true }),
    collections: [
      { slug: 'sites', fields: [{ name: 'name', type: 'text' }] },
      { slug: 'users', auth: true, access: { read: () => true }, fields: [{ name: 'role', type: 'text' }, { name: 'status', type: 'text' }] },
      { slug: 'devices', auth: true, fields: [] },
    ],
    admin: { user: 'users' },
    plugins: [
      notificationsPlugin({
        kinds,
        access: { manage: ({ req }) => (req.user as { role?: string } | null)?.role === 'staff' },
        isActive: async (u) => u.status !== 'disabled',
        sendEmail: async ({ to, subject, text, kind }) => {
          if (sendFails === 'always' || sendFails > 0) {
            if (sendFails !== 'always') sendFails--
            throw Object.assign(new Error(`mail server refused ${to}`), { code: 'EREFUSED' })
          }
          sent.push({ to, subject, text, kind })
        },
        scopeField: 'site',
        scopeFor: (req) => (req.headers?.get?.('x-site') as string | null) ?? null,
        ...extra,
      }),
      (c: Config) => {
        // Notifications doesn't add the site field: a tenant plugin does. This stands in for one.
        for (const coll of c.collections ?? []) if (['notifications', 'notification-preferences'].includes(coll.slug)) coll.fields.push({ name: 'site', type: 'relationship', relationTo: 'sites' as never })
        return { ...c, custom: { ...c.custom, notificationKinds: [...((c.custom?.notificationKinds as KindRegistration[]) ?? []), other] } }
      },
      ...plugins,
    ],
  })

let siteA: string
let siteB: string
let staff: Doc
let n = 0
const person = async (status = 'active') => (await payload.create({ collection: 'users', data: { email: `person${++n}@example.com`, password: 'a made-up password', role: 'member', status } as never, overrideAccess: true })) as Doc
const notices = async (recipient: unknown) => (await payload.find({ collection: 'notifications' as never, where: { recipient: { equals: recipient } }, sort: 'createdAt', depth: 0, overrideAccess: true })).docs as Doc[]
const offered = (u: Doc, extra: Doc = {}) => notify(payload, { recipient: u.id, kind: 'transfer-offered', params: { from: 'Made Up', animal: 'Gecko 1' }, link: '/my-animals', scope: siteA, ...extra })
const tokens = new Map<string, string>()
const tokenFor = async (u: Doc) => {
  if (!tokens.has(String(u.id))) tokens.set(String(u.id), (await payload.login({ collection: 'users', data: { email: u.email, password: 'a made-up password' } })).token!)
  return tokens.get(String(u.id))!
}
/** Through Payload's own routing, as a browser's request would go, with a real sign-in token. */
const call = async (path: string, method: string, user: Doc | null, opts: { body?: unknown; site?: string; query?: string } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.site ? { 'x-site': opts.site } : {}) })
  if (user) headers.set('Authorization', `JWT ${await tokenFor(user)}`)
  const request = new Request(`https://site.example.com/api${path}${opts.query ?? ''}`, { method: method.toUpperCase(), headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), request } as never)
  return { status: res.status, body: (await res.json()) as Doc }
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({ config: await baseConfig() })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  siteA = String(((await payload.create({ collection: 'sites' as never, data: { name: 'A' } as never, overrideAccess: true })) as Doc).id)
  siteB = String(((await payload.create({ collection: 'sites' as never, data: { name: 'B' } as never, overrideAccess: true })) as Doc).id)
  staff = (await payload.create({ collection: 'users', data: { email: 'staff@example.com', password: 'a made-up password', role: 'staff', status: 'active' } as never, overrideAccess: true })) as Doc
  for (const level of ['error', 'warn'] as const) {
    const orig = payload.logger[level].bind(payload.logger)
    vi.spyOn(payload.logger, level).mockImplementation(((obj: unknown, ...rest: unknown[]) => (logs.push(obj), orig(obj as never, ...(rest as [])))) as never)
  }
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

beforeEach(() => {
  sent.length = 0
  sendFails = 0
  logs.length = 0
})

describe('kinds', () => {
  it('takes kinds from the site and from another plugin registered after it', async () => {
    const u = await person()
    expect((await notify(payload, { recipient: u.id, kind: 'kit-ready', params: { code: '123' }, scope: siteA })).outcome).toBe('stored')
    expect((await listNotifications(payload, { user: u.id, scope: siteA }))[0]!.text).toBe('Kit 123 is ready')
  })

  it('stops the site at start-up when two owners register one kind, or a kind has no words', async () => {
    const twice = (c: Config) => ({ ...c, custom: { ...c.custom, notificationKinds: [...(c.custom!.notificationKinds as KindRegistration[]), { owner: 'a second plugin', kinds: { 'kit-ready': other.kinds['kit-ready']! } }] } })
    await expect(getPayload({ config: await baseConfig({}, [twice]), key: 'dup' } as never)).rejects.toThrow(/"kit-ready" is registered by both a made-up plugin and a second plugin/)
    const wordless = (c: Config) => ({ ...c, custom: { ...c.custom, notificationKinds: [...(c.custom!.notificationKinds as KindRegistration[]), { owner: 'x', kinds: { bad: {} as never } }] } })
    await expect(getPayload({ config: await baseConfig({}, [wordless]), key: 'wordless' } as never)).rejects.toThrow(/"bad" from x has no text/)
    const loud = (c: Config) => ({ ...c, custom: { ...c.custom, notificationKinds: [...(c.custom!.notificationKinds as KindRegistration[]), { owner: 'y', kinds: { loud: { text: () => 'x', priority: 'urgent' as never } } }] } })
    await expect(getPayload({ config: await baseConfig({}, [loud]), key: 'loud' } as never)).rejects.toThrow(/"loud" from y has priority "urgent"/)
  })

  it('refuses to start without access.manage, or with scopeField but no scopeFor', async () => {
    await expect(baseConfig({ access: undefined as never })).rejects.toThrow(/access\.manage/)
    await expect(baseConfig({ scopeFor: undefined })).rejects.toThrow(/scopeFor/)
  })
})

describe('notify', () => {
  it('stores a notice and emails a copy with the link and the preferences link', async () => {
    const u = await person()
    expect((await offered(u)).outcome).toBe('stored')
    const [doc] = await notices(u.id)
    expect([doc!.kind, doc!.params, doc!.link, doc!.emailStatus, String(doc!.site)]).toEqual(['transfer-offered', { from: 'Made Up', animal: 'Gecko 1' }, '/my-animals', 'sent', siteA])
    expect(sent).toEqual([{ to: u.email, subject: 'Made Up wants to transfer Gecko 1 to you', kind: 'transfer-offered', text: expect.stringContaining('https://site.example.com/my-animals') }])
    expect(sent[0]!.text).toContain('You can choose which emails you get: https://site.example.com/notifications')
  })

  it('tells nobody about their own action, and refuses non-string params, unknown kinds, outside links and a missing site', async () => {
    const u = await person()
    expect((await offered(u, { actor: u.id })).outcome).toBe('self')
    expect((await offered(u, { params: { from: 'x', animal: { private: 'record' } } })).outcome).toBe('refused')
    expect((await offered(u, { kind: 'no-such-kind' })).outcome).toBe('refused')
    expect((await offered(u, { link: 'https://elsewhere.example' })).outcome).toBe('refused')
    expect((await offered(u, { link: '//elsewhere.example' })).outcome).toBe('refused')
    expect((await offered(u, { link: '/\\elsewhere.example' })).outcome).toBe('refused')
    expect((await notify(payload, { recipient: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'only-on-site', scope: siteA })).outcome).toBe('refused')
    expect((await offered(u, { scope: null })).outcome).toBe('refused')
    expect(await notices(u.id)).toHaveLength(0)
  })

  it('stores a dedupe key once per person within the window', async () => {
    const u = await person()
    expect((await offered(u, { dedupeKey: 'gecko-1' })).outcome).toBe('stored')
    expect((await offered(u, { dedupeKey: 'gecko-1' })).outcome).toBe('duplicate')
    expect((await offered(await person(), { dedupeKey: 'gecko-1' })).outcome).toBe('stored')
    expect(await notices(u.id)).toHaveLength(1)
  })

  it('is part of the caller’s transaction: a rollback leaves no notice and sends nothing; a commit leaves the email to the queue', async () => {
    const u = await person()
    const tx = async (commit: boolean) => {
      const id = (await payload.db.beginTransaction())!
      const req = { payload, transactionID: id } as never
      await notify(payload, { recipient: u.id, kind: 'transfer-accepted', params: { animal: 'Gecko 2' }, scope: siteA }, req)
      if (commit) await payload.db.commitTransaction(id)
      else await payload.db.rollbackTransaction(id)
    }
    await offered(u)
    await tx(false)
    expect((await notices(u.id)).map((d) => d.kind)).toEqual(['transfer-offered'])
    sent.length = 0
    await tx(true)
    const accepted = (await notices(u.id)).find((d) => d.kind === 'transfer-accepted')!
    expect(accepted.emailStatus).toBe('pending')
    expect(sent).toEqual([]) // not before the commit's queue run
    await sendPendingNotifications(payload)
    expect(sent.map((m) => m.kind)).toContain('transfer-accepted')
  })

  it('never undoes the caller’s work, even when the notice fails inside the caller’s transaction', async () => {
    const u = await person()
    const id = (await payload.db.beginTransaction())!
    const req = { payload, transactionID: id } as never
    const site = (await payload.create({ collection: 'sites' as never, data: { name: 'caller work' } as never, overrideAccess: true, req })) as Doc
    expect((await notify(payload, { recipient: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'only-on-site', scope: siteA }, req)).outcome).toBe('refused')
    expect((await notify(payload, { recipient: u.id, kind: 'only-on-site', scope: siteA, params: { x: 1 } as never }, req)).outcome).toBe('refused')
    const spy = vi.spyOn(payload.db, 'create').mockRejectedValueOnce(new Error('made-up failure'))
    expect((await notify(payload, { recipient: u.id, kind: 'only-on-site', scope: siteA }, req)).outcome).toBe('error')
    spy.mockRestore()
    await payload.db.commitTransaction(id)
    expect(await payload.findByID({ collection: 'sites' as never, id: site.id, overrideAccess: true, disableErrors: true })).toBeTruthy()
  })

  it('never throws, and logs the kind and the failure only: no params, address or link', async () => {
    const u = await person()
    sendFails = 'always'
    await expect(offered(u, { params: { from: 'Secret Name', animal: 'Gecko 1' } })).resolves.toMatchObject({ outcome: 'stored' })
    const spy = vi.spyOn(payload.db, 'create').mockRejectedValueOnce(new Error(`database down for ${u.email}`))
    await expect(offered(u)).resolves.toEqual({ id: null, outcome: 'error' })
    spy.mockRestore()
    const text = JSON.stringify(logs)
    expect(text).toContain('transfer-offered')
    expect(text).not.toMatch(new RegExp(`${u.email}|Secret Name|my-animals|mail server refused`))
  })
})

describe('email copies', () => {
  it('skips when the person turned the group off, or all email, unless the kind is required', async () => {
    const u = await person()
    await setPreference(payload, { user: u.id, scope: siteA, key: 'group:Transfers', email: false })
    await offered(u)
    await notify(payload, { recipient: u.id, kind: 'account-approved', scope: siteA })
    await setPreference(payload, { user: u.id, scope: siteA, key: 'group:Transfers', email: true })
    await setPreference(payload, { user: u.id, scope: siteA, key: 'all', email: false })
    await offered(u)
    await notify(payload, { recipient: u.id, kind: 'account-approved', scope: siteA })
    expect((await notices(u.id)).map((d) => [d.kind, d.emailStatus, d.emailSkipReason ?? null])).toEqual([
      ['transfer-offered', 'skipped', 'turned off'],
      ['account-approved', 'sent', null],
      ['transfer-offered', 'skipped', 'turned off'],
      ['account-approved', 'sent', null],
    ])
    // Preferences are per site: site B still emails.
    await notify(payload, { recipient: u.id, kind: 'transfer-offered', params: { from: 'a', animal: 'b' }, scope: siteB })
    expect((await notices(u.id)).at(-1)!.emailStatus).toBe('sent')
  })

  it('follows a kind that is off by default until the person turns it on, and never emails an on-site-only kind', async () => {
    const u = await person()
    await notify(payload, { recipient: u.id, kind: 'quiet-by-default', scope: siteA })
    await setPreference(payload, { user: u.id, scope: siteA, key: 'kind:quiet-by-default', email: true })
    await notify(payload, { recipient: u.id, kind: 'quiet-by-default', scope: siteA })
    await notify(payload, { recipient: u.id, kind: 'only-on-site', scope: siteA })
    expect((await notices(u.id)).map((d) => [d.emailStatus, d.emailSkipReason ?? null])).toEqual([['skipped', 'turned off'], ['sent', null], ['skipped', 'never emailed']])
  })

  it('skips an inactive account', async () => {
    const u = await person('disabled')
    await offered(u)
    expect((await notices(u.id))[0]).toMatchObject({ emailStatus: 'skipped', emailSkipReason: 'inactive account' })
  })

  it('never sends a backlog: a notice older than the age limit is skipped when its turn comes', async () => {
    const u = await person()
    sendFails = 'always'
    await offered(u)
    const [doc] = await notices(u.id)
    await payload.db.updateOne({ collection: 'notifications', where: { id: { equals: doc!.id } }, data: { createdAt: new Date(Date.now() - 49 * 3600_000).toISOString(), emailNextAt: new Date(0).toISOString() } } as never)
    sendFails = 0
    await sendPendingNotifications(payload)
    expect((await notices(u.id))[0]).toMatchObject({ emailStatus: 'skipped', emailSkipReason: 'too old' })
    expect(sent.filter((m) => m.to === u.email)).toHaveLength(0)
  })
})

describe('the send queue', () => {
  const due = (id: unknown) => payload.db.updateOne({ collection: 'notifications', where: { id: { equals: id } }, data: { emailNextAt: new Date(0).toISOString() } } as never)

  it('retries with backoff, then marks failed after 5 tries, keeping the notice', async () => {
    const u = await person()
    sendFails = 'always'
    await offered(u)
    let [doc] = await notices(u.id)
    expect([doc!.emailStatus, doc!.emailAttempts]).toEqual(['pending', 1])
    const wait = new Date(doc!.emailNextAt).getTime() - Date.now()
    expect(wait).toBeGreaterThan(4 * 60_000)
    expect(wait).toBeLessThan(6 * 60_000)
    await sendPendingNotifications(payload)
    expect((await notices(u.id))[0]!.emailAttempts).toBe(1) // not due yet
    for (let i = 0; i < 4; i++) {
      await due(doc!.id)
      await sendPendingNotifications(payload)
    }
    ;[doc] = await notices(u.id)
    expect([doc!.emailStatus, doc!.emailAttempts]).toEqual(['failed', 5])
    expect((await listNotifications(payload, { user: u.id, scope: siteA }))).toHaveLength(1)
  })

  it('sends high priority first, then normal, then low', async () => {
    const u = await person()
    sendFails = 'always'
    await notify(payload, { recipient: u.id, kind: 'transfer-accepted', params: { animal: 'low' }, scope: siteA })
    await offered(u)
    await notify(payload, { recipient: u.id, kind: 'account-approved', scope: siteA })
    for (const d of await notices(u.id)) await due(d.id)
    sendFails = 0
    await sendPendingNotifications(payload)
    expect(sent.map((m) => m.kind)).toEqual(['account-approved', 'transfer-offered', 'transfer-accepted'])
  })

  it('sends each email once when runners overlap', async () => {
    const u = await person()
    sendFails = 'always'
    for (let i = 0; i < 6; i++) await offered(u, { params: { from: 'Made Up', animal: `Gecko ${i}` } })
    for (const d of await notices(u.id)) await due(d.id)
    sendFails = 0
    await Promise.all([sendPendingNotifications(payload), sendPendingNotifications(payload), sendPendingNotifications(payload)])
    expect(sent).toHaveLength(6)
    expect(new Set(sent.map((m) => m.subject)).size).toBe(6)
  })

  it('picks up an email left mid-send by a runner that died', async () => {
    const u = await person()
    sendFails = 'always'
    await offered(u)
    const [doc] = await notices(u.id)
    await payload.db.updateOne({ collection: 'notifications', where: { id: { equals: doc!.id } }, data: { emailStatus: 'sending', emailClaimedAt: new Date(Date.now() - 20 * 60_000).toISOString() } } as never)
    sendFails = 0
    await sendPendingNotifications(payload)
    expect((await notices(u.id))[0]!.emailStatus).toBe('sent')
  })
})

describe('reading and access', () => {
  it('lists a person’s own notices on one site, counts unread, and marks only their own read', async () => {
    const a = await person()
    const b = await person()
    await offered(a)
    await offered(a)
    await offered(b)
    await notify(payload, { recipient: a.id, kind: 'only-on-site', scope: siteB })
    expect(await unreadCount(payload, { user: a.id, scope: siteA })).toBe(2)
    const bNotice = (await notices(b.id))[0]!
    expect(await markRead(payload, { user: a.id, scope: siteA, ids: [bNotice.id] })).toBe(0)
    expect(await unreadCount(payload, { user: b.id, scope: siteA })).toBe(1)
    expect(await markRead(payload, { user: a.id, scope: siteA, all: true })).toBe(2)
    expect(await unreadCount(payload, { user: a.id, scope: siteA })).toBe(0)
    expect(await unreadCount(payload, { user: a.id, scope: siteB })).toBe(1)
    const list = await listNotifications(payload, { user: a.id, scope: siteA })
    expect(list.map((x) => [x.text, x.read, x.link])).toEqual([
      ['Made Up offered you Gecko 1', true, '/my-animals'],
      ['Made Up offered you Gecko 1', true, '/my-animals'],
    ])
  })

  it('lets a person read only their own notices and preferences through the API; managers read all; nobody writes', async () => {
    const a = await person()
    const b = await person()
    await offered(a)
    await setPreference(payload, { user: a.id, scope: siteA, key: 'all', email: false })
    const as = (u: Doc) => ({ overrideAccess: false, user: { ...u, collection: 'users' } as never, req: { headers: new Headers({ 'x-site': siteA }) } as never })
    expect((await payload.find({ collection: 'notifications' as never, ...as(b) })).docs).toHaveLength(0)
    expect((await payload.find({ collection: 'notifications' as never, where: { recipient: { equals: a.id } }, ...as(a) })).docs.length).toBeGreaterThanOrEqual(1)
    expect((await payload.find({ collection: 'notifications' as never, where: { recipient: { equals: a.id } }, ...as(staff) })).docs).toHaveLength(1)
    expect((await payload.find({ collection: 'notification-preferences' as never, where: { user: { equals: a.id } }, ...as(b) })).docs).toHaveLength(0)
    expect((await payload.find({ collection: 'notification-preferences' as never, where: { user: { equals: a.id } }, ...as(a) })).docs).toHaveLength(1)
    // A skipped email with a reason and a dedupe key: none of the delivery fields reach the person.
    await offered(a, { dedupeKey: 'k-1' })
    const own = (await payload.find({ collection: 'notifications' as never, where: { recipient: { equals: a.id } }, ...as(a) })).docs as Doc[]
    expect(own.length).toBe(2)
    for (const d of own) expect(Object.keys(d).filter((k) => k.startsWith('email') || k === 'dedupeKey')).toEqual([])
    expect((await notices(a.id)).some((d) => d.emailSkipReason === 'turned off' && d.dedupeKey === 'k-1')).toBe(true)
    // An account from another sign-in collection, with the same id, gets nothing.
    const device = { ...a, collection: 'devices' }
    await expect(payload.find({ collection: 'notifications' as never, overrideAccess: false, user: device as never, req: { headers: new Headers({ 'x-site': siteA }) } as never })).rejects.toThrow(/not allowed/)
    const theirs = (await payload.find({ collection: 'notifications' as never, where: { recipient: { equals: a.id } }, ...as(staff) })).docs[0] as Doc
    expect(theirs.emailStatus).toBeTruthy()
    const [doc] = await notices(a.id)
    await expect(payload.create({ collection: 'notifications' as never, data: { recipient: b.id, kind: 'only-on-site' } as never, ...as(a) })).rejects.toThrow()
    await expect(payload.update({ collection: 'notifications' as never, id: doc!.id, data: { readAt: new Date().toISOString() } as never, ...as(a) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'notifications' as never, id: doc!.id, ...as(staff) })).rejects.toThrow()
    await expect(payload.create({ collection: 'notification-preferences' as never, data: { user: b.id, allEmail: false } as never, ...as(a) })).rejects.toThrow()
  })

  it('shows a person only the current site’s notices through the REST API, and nothing without a site', async () => {
    const a = await person()
    await offered(a)
    await notify(payload, { recipient: a.id, kind: 'only-on-site', scope: siteB })
    const list = async (site?: string) => (await call('/notifications', 'get', a, { site })).body.docs as Doc[]
    expect((await list(siteA)).map((d) => d.kind)).toEqual(['transfer-offered'])
    expect((await list(siteB)).map((d) => d.kind)).toEqual(['only-on-site'])
    const none = await call('/notifications', 'get', a)
    expect([none.status, none.body.docs ?? []]).toEqual([expect.any(Number), []])
  })

  it('serves the endpoints only to a signed-in person on a known site, for their own notices', async () => {
    const a = await person()
    const b = await person()
    await offered(a)
    await offered(b)
    expect((await call('/notifications/mine', 'get', null, { site: siteA })).status).toBe(401)
    expect((await call('/notifications/mine', 'get', a)).status).toBe(403)
    const mine = await call('/notifications/mine', 'get', a, { site: siteA })
    expect(mine.body.docs.map((d: Doc) => d.text)).toEqual(['Made Up offered you Gecko 1'])
    expect((await call('/notifications/unread', 'get', a, { site: siteA })).body).toEqual({ count: 1 })
    const bId = (await notices(b.id))[0]!.id
    expect((await call('/notifications/read', 'post', a, { site: siteA, body: { ids: [bId] } })).body).toEqual({ marked: 0 })
    expect((await call('/notifications/read', 'post', a, { site: siteA, body: { all: true } })).body).toEqual({ marked: 1 })
    const prefs = await call('/notification-preferences/mine', 'post', a, { site: siteA, body: { key: 'group:Transfers', email: false } })
    expect(prefs.body.rows.find((r: Doc) => r.key === 'group:Transfers')).toMatchObject({ email: false, label: 'Transfers' })
    expect(prefs.body.rows.find((r: Doc) => r.key === 'kind:account-approved')).toMatchObject({ email: true, required: true })
    expect(prefs.body.rows.some((r: Doc) => r.key === 'kind:only-on-site')).toBe(false)
    expect((await call('/notification-preferences/mine', 'post', a, { site: siteA, body: { key: 'kind:made-up', email: false } })).status).toBe(400)
    expect((await call('/notification-preferences/mine', 'post', a, { site: siteA, body: { key: 'all', email: 'no' } })).status).toBe(400)
  })
})

describe('retention', () => {
  it('deletes read notices past the limit and unread ones past twice it, and keeps the rest', async () => {
    const u = await person()
    for (let i = 0; i < 4; i++) await notify(payload, { recipient: u.id, kind: 'only-on-site', scope: siteA })
    const docs = await notices(u.id)
    const age = (d: Doc, days: number, read: boolean) =>
      payload.db.updateOne({ collection: 'notifications', where: { id: { equals: d.id } }, data: { createdAt: new Date(Date.now() - days * 86_400_000).toISOString(), readAt: read ? new Date().toISOString() : null } } as never)
    await age(docs[0]!, 200, true) // read, past 180: deleted
    await age(docs[1]!, 200, false) // unread, under 360: kept
    await age(docs[2]!, 400, false) // unread, past 360: deleted
    await age(docs[3]!, 10, true) // read, recent: kept
    await pruneNotifications(payload)
    expect((await notices(u.id)).map((d) => String(d.id)).sort()).toEqual([String(docs[1]!.id), String(docs[3]!.id)].sort())
  })
})
