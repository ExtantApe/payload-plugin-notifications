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
/** Stand-ins for a site's own rules, so a test can make them answer oddly or throw. Reset before each test. */
let manageAs: (() => unknown) | null = null
let activeAs: ((user: Doc) => unknown) | null = null

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

const baseConfig = (extra: Partial<Parameters<typeof notificationsPlugin>[0]> = {}, plugins: ((c: Config) => Config)[] = [], database = 'notifications') =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    serverURL: 'https://site.example.com',
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(database), ensureIndexes: true }),
    collections: [
      { slug: 'sites', fields: [{ name: 'name', type: 'text' }] },
      { slug: 'users', auth: true, access: { read: () => true }, fields: [{ name: 'role', type: 'text' }, { name: 'status', type: 'text' }] },
      { slug: 'devices', auth: true, fields: [] },
    ],
    admin: { user: 'users' },
    plugins: [
      notificationsPlugin({
        kinds,
        access: { manage: ({ req }) => (manageAs ? manageAs() : (req.user as { role?: string } | null)?.role === 'staff') as boolean },
        isActive: async (u) => (activeAs ? activeAs(u) : u.status !== 'disabled') as boolean,
        sendEmail: async ({ to, subject, text, kind }) => {
          if (sendFails === 'always' || sendFails > 0) {
            if (sendFails !== 'always') sendFails--
            throw Object.assign(new Error(`mail server refused ${to}`), { code: 'EREFUSED' })
          }
          sent.push({ to, subject, text, kind })
        },
        scopeField: 'site',
        scopeFor: (req) => {
          const site = (req.headers?.get?.('x-site') as string | null) ?? null
          if (site === 'lookup-fails') throw new Error('made-up site lookup failure')
          return site
        },
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
const call = async (path: string, method: string, user: Doc | null, opts: { body?: unknown; site?: string; query?: string; token?: string; on?: Payload } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.site ? { 'x-site': opts.site } : {}) })
  if (opts.token) headers.set('Authorization', `JWT ${opts.token}`)
  else if (user) headers.set('Authorization', `JWT ${await tokenFor(user)}`)
  const request = new Request(`https://site.example.com/api${path}${opts.query ?? ''}`, { method: method.toUpperCase(), headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const res = await handleEndpoints({ config: Promise.resolve((opts.on ?? payload).config), request, ...(opts.on ? { payloadInstanceCacheKey: 'plain' } : {}) } as never)
  return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json().catch(() => ({}))) as Doc }
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
  manageAs = null
  activeAs = null
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

// Added by the 2026-11-26 test audit: refusals, what an email or an answer carries, and gates that fail closed.
describe('refusals and leaks, audited after 0.1.0', () => {
  const due = (id: unknown) => payload.db.updateOne({ collection: 'notifications', where: { id: { equals: id } }, data: { emailNextAt: new Date(0).toISOString() } } as never)
  const prefsOf = async (user: unknown) => (await payload.find({ collection: 'notification-preferences' as never, where: { user: { equals: user } }, depth: 0, overrideAccess: true })).docs as Doc[]
  const routes: [string, string, unknown?][] = [
    ['/notifications/mine', 'get'],
    ['/notifications/unread', 'get'],
    ['/notifications/read', 'post', { all: true }],
    ['/notification-preferences/mine', 'get'],
    ['/notification-preferences/mine', 'post', { key: 'all', email: false }],
  ]

  it('refuses every endpoint to a signed-out visitor, to an account from another sign-in collection, and without a site, never cacheable', async () => {
    const a = await person()
    await offered(a)
    await payload.create({ collection: 'devices' as never, data: { email: 'device1@example.com', password: 'a made-up password' } as never, overrideAccess: true })
    const device = (await payload.login({ collection: 'devices' as never, data: { email: 'device1@example.com', password: 'a made-up password' } })).token!
    for (const [path, method, body] of routes) {
      const refused = [
        await call(path, method, null, { site: siteA, body }),
        await call(path, method, null, { site: siteA, body, token: device }),
        await call(path, method, a, { body }),
        await call(path, method, a, { site: 'lookup-fails', body }),
      ]
      expect([path, method, ...refused.map((r) => r.status)]).toEqual([path, method, 401, 401, 403, 403])
      for (const r of refused) {
        expect(Object.keys(r.body)).toEqual(['error'])
        expect(r.cache).toBe('no-store')
      }
      expect((await call(path, method, a, { site: siteA, body: method === 'get' ? undefined : {} })).cache).toBe('no-store')
    }
    // None of the refused posts did anything.
    expect((await notices(a.id))[0]!.readAt ?? null).toBeNull()
    expect(await prefsOf(a.id)).toEqual([])
  })

  it('keeps another person’s notices and preferences out of reach through the REST API, signed in or not', async () => {
    const a = await person()
    const b = await person()
    await offered(a)
    await offered(b, { params: { from: 'Someone Else', animal: 'Skink 9' } })
    await setPreference(payload, { user: b.id, scope: siteA, key: 'all', email: false })
    const bNotice = (await notices(b.id))[0]!
    const bPrefs = (await prefsOf(b.id))[0]!
    const tries = [
      await call(`/notifications/${bNotice.id}`, 'get', a, { site: siteA }),
      await call('/notifications', 'get', a, { site: siteA, query: `?where[recipient][equals]=${b.id}` }),
      await call('/notifications', 'get', a, { site: siteA, query: '?limit=100&depth=2' }),
      await call(`/notification-preferences/${bPrefs.id}`, 'get', a, { site: siteA }),
      await call('/notification-preferences', 'get', a, { site: siteA }),
      await call(`/notifications/${bNotice.id}`, 'get', null, { site: siteA }),
      await call('/notifications', 'get', null, { site: siteA }),
      await call('/notification-preferences', 'get', null, { site: siteA }),
    ]
    for (const r of tries) expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`Someone Else|Skink 9|${bNotice.id}|${bPrefs.id}|${b.email}`))
    expect(tries.map((r) => r.status)).toEqual([404, 200, 200, 404, 200, 403, 403, 403])
    expect(tries[1]!.body.docs).toEqual([])
    expect(tries[2]!.body.docs.map((d: Doc) => String(d.recipient?.id ?? d.recipient))).toEqual([String(a.id)])
    // The delivery fields can't be read, searched or sorted on by the person, and nobody writes, a manager included.
    expect((await call('/notifications', 'get', a, { site: siteA, query: '?where[emailStatus][equals]=sent' })).status).toBe(400)
    expect((await call('/notifications', 'get', a, { site: siteA, query: '?sort=emailSkipReason' })).status).toBe(400)
    const aNotice = (await notices(a.id))[0]!
    for (const who of [a, staff]) {
      expect((await call('/notifications', 'post', who, { site: siteA, body: { recipient: b.id, kind: 'only-on-site', site: siteA } })).status).toBe(403)
      expect((await call(`/notifications/${aNotice.id}`, 'patch', who, { site: siteA, body: { readAt: new Date().toISOString(), params: { from: 'x', animal: 'y' } } })).status).toBe(403)
      expect((await call(`/notifications/${aNotice.id}`, 'delete', who, { site: siteA })).status).toBe(403)
      expect((await call(`/notification-preferences/${bPrefs.id}`, 'patch', who, { site: siteA, body: { allEmail: true } })).status).toBe(403)
      expect((await call(`/notification-preferences/${bPrefs.id}`, 'delete', who, { site: siteA })).status).toBe(403)
    }
    expect(await notices(b.id)).toHaveLength(1)
    expect((await notices(a.id))[0]).toMatchObject({ params: { from: 'Made Up', animal: 'Gecko 1' } })
    expect((await notices(a.id))[0]!.readAt ?? null).toBeNull()
    expect((await prefsOf(b.id))[0]!.allEmail).toBe(false)
  })

  it('marks read and changes preferences for the signed-in person on the current site only, whatever the body names', async () => {
    const a = await person()
    const b = await person()
    await offered(a)
    await notify(payload, { recipient: a.id, kind: 'only-on-site', scope: siteB })
    await offered(b)
    const bNotice = (await notices(b.id))[0]!
    const elsewhere = (await notices(a.id)).find((d) => String(d.site) === siteB)!
    expect((await call('/notifications/read', 'post', a, { site: siteA, body: { ids: [bNotice.id, elsewhere.id], user: b.id, recipient: b.id, scope: siteB } })).body).toEqual({ marked: 0 })
    expect((await call('/notifications/read', 'post', a, { site: siteA, body: { all: true, user: b.id, recipient: b.id, scope: siteB } })).body).toEqual({ marked: 1 })
    expect((await notices(b.id))[0]!.readAt ?? null).toBeNull()
    expect(((await notices(a.id)).find((d) => String(d.site) === siteB)!).readAt ?? null).toBeNull()
    // Only an `all` of exactly true marks everything.
    await offered(a)
    expect((await call('/notifications/read', 'post', a, { site: siteA, body: { all: 'true' } })).body).toEqual({ marked: 0 })
    expect((await call('/notifications/unread', 'get', a, { site: siteA })).body).toEqual({ count: 1 })
    // A preference change lands on the caller's own row for this site, not on the person the body names.
    expect((await call('/notification-preferences/mine', 'post', a, { site: siteA, body: { key: 'all', email: false, user: b.id, scope: siteB, site: siteB } })).status).toBe(200)
    expect(await prefsOf(b.id)).toEqual([])
    expect((await prefsOf(a.id)).map((d) => [String(d.site), d.allEmail])).toEqual([[siteA, false]])
    expect((await call('/notification-preferences/mine', 'get', a, { site: siteB })).body.allEmail).toBe(true)
    expect((await call('/notification-preferences/mine', 'get', b, { site: siteA })).body.allEmail).toBe(true)
  })

  it('answers the list with its six fields only, and at most 100 notices', async () => {
    const a = await person()
    await offered(a, { dedupeKey: 'private-key-1' })
    const { body } = await call('/notifications/mine', 'get', a, { site: siteA })
    expect(Object.keys(body)).toEqual(['docs'])
    expect(Object.keys(body.docs[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'link', 'read', 'text'])
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${a.email}|${a.id}|private-key-1|sent|${siteA}`))
    for (let i = 0; i < 10; i++) await Promise.all(Array.from({ length: 10 }, () => notify(payload, { recipient: a.id, kind: 'only-on-site', scope: siteA })))
    expect(await unreadCount(payload, { user: a.id, scope: siteA })).toBe(101)
    expect((await call('/notifications/mine', 'get', a, { site: siteA, query: '?limit=1000' })).body.docs).toHaveLength(100)
    expect(await listNotifications(payload, { user: a.id, scope: siteA, limit: 1000 })).toHaveLength(100)
  })

  it('counts only an answer of exactly true from access.manage, and refuses when it throws', async () => {
    const a = await person()
    const b = await person()
    await offered(a, { dedupeKey: 'k-2' })
    await setPreference(payload, { user: a.id, scope: siteA, key: 'all', email: false })
    const as = (u: Doc) => ({ overrideAccess: false, depth: 0, user: { ...u, collection: 'users' } as never, req: { headers: new Headers({ 'x-site': siteA }) } as never })
    const about = { where: { recipient: { equals: a.id } } }
    for (const answer of [{}, { recipient: { exists: true } }, 'true', 1, null, undefined, false]) {
      manageAs = () => answer
      // Nobody is a manager now, the staff account included: others see nothing, and the person sees no delivery fields.
      for (const u of [b, staff]) {
        expect((await payload.find({ collection: 'notifications' as never, ...about, ...as(u) })).docs).toEqual([])
        expect((await payload.find({ collection: 'notification-preferences' as never, where: { user: { equals: a.id } }, ...as(u) })).docs).toEqual([])
      }
      const own = (await payload.find({ collection: 'notifications' as never, ...about, ...as(a) })).docs as Doc[]
      expect(own).toHaveLength(1)
      expect(Object.keys(own[0]!).filter((k) => k.startsWith('email') || k === 'dedupeKey')).toEqual([])
    }
    manageAs = () => {
      throw new Error('made-up rule failure')
    }
    for (const u of [a, b, staff]) {
      await expect(payload.find({ collection: 'notifications' as never, ...about, ...as(u) })).rejects.toThrow('made-up rule failure')
      await expect(payload.find({ collection: 'notification-preferences' as never, ...as(u) })).rejects.toThrow('made-up rule failure')
    }
    const viaRest = await call('/notifications', 'get', staff, { site: siteA })
    expect(viaRest.status).toBeGreaterThanOrEqual(400)
    expect(viaRest.body.docs).toBeUndefined()
  })

  it('sends each email copy to its notice’s own recipient only, carrying nobody else’s address or words', async () => {
    const a = await person()
    const b = await person()
    const c = await person()
    sendFails = 'always'
    // Queued together, each caused by another person, and in the other order on the second site.
    await offered(a, { actor: c.id, params: { from: 'Alpha Sender', animal: 'Gecko A' }, link: '/for-a' })
    await offered(b, { actor: a.id, params: { from: 'Beta Sender', animal: 'Skink B' }, link: '/for-b' })
    for (const u of [a, b]) for (const d of await notices(u.id)) await due(d.id)
    sendFails = 0
    await sendPendingNotifications(payload)
    // Sent at once, outside the queue.
    await offered(b, { actor: a.id, params: { from: 'Beta Sender', animal: 'Skink B' }, link: '/for-b' })
    const ours = sent.filter((m) => [a.email, b.email, c.email, staff.email].includes(m.to))
    expect(ours.map((m) => m.to)).toEqual([a.email, b.email, b.email])
    const [toA, ...toB] = ours.map((m) => JSON.stringify(m))
    expect(toA).toMatch(/Alpha Sender.*Gecko A.*\/for-a/)
    expect(toA).not.toMatch(new RegExp(`Beta Sender|Skink B|/for-b|${b.email}|${c.email}|${b.id}|${c.id}`))
    for (const m of toB) {
      expect(m).toMatch(/Beta Sender.*Skink B.*\/for-b/)
      expect(m).not.toMatch(new RegExp(`Alpha Sender|Gecko A|/for-a|${a.email}|${c.email}|${a.id}|${c.id}`))
    }
    expect(sent.every((m) => typeof m.to === 'string' && !/[,;\s]/.test(m.to))).toBe(true)
  })

  it('emails only on an isActive answer of exactly true, and sends nothing when a gate throws or the account has no address', async () => {
    const u = await person()
    for (const answer of ['yes', 1, {}, null, undefined, false]) {
      activeAs = () => answer
      await offered(u)
      expect((await notices(u.id)).at(-1)).toMatchObject({ emailStatus: 'skipped', emailSkipReason: 'inactive account' })
    }
    // A rule that throws: nothing goes out, the email waits, and the log names no one.
    activeAs = (user) => {
      throw new Error(`made-up lookup failure for ${user.email}`)
    }
    await offered(u)
    expect((await notices(u.id)).at(-1)).toMatchObject({ emailStatus: 'pending', emailAttempts: 1 })
    // The preferences can't be read: the same.
    activeAs = null
    const find = payload.find.bind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation(((args: Doc) => (args.collection === 'notification-preferences' ? Promise.reject(new Error(`made-up database failure for ${u.email}`)) : find(args as never))) as never)
    await offered(u)
    spy.mockRestore()
    expect((await notices(u.id)).at(-1)).toMatchObject({ emailStatus: 'pending', emailAttempts: 1 })
    // An account with no address is skipped before the sender is called.
    await payload.db.updateOne({ collection: 'users', where: { id: { equals: u.id } }, data: { email: '' } } as never)
    await offered(u)
    expect((await notices(u.id)).at(-1)).toMatchObject({ emailStatus: 'skipped', emailSkipReason: 'no email' })
    expect(sent).toEqual([])
    expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${u.email}|made-up lookup failure|made-up database failure`))
    // Once the rules answer again, the two waiting emails go out, and the skipped ones stay skipped.
    await payload.db.updateOne({ collection: 'users', where: { id: { equals: u.id } }, data: { email: u.email } } as never)
    for (const d of await notices(u.id)) await due(d.id)
    await sendPendingNotifications(payload)
    expect(sent.filter((m) => m.to === u.email)).toHaveLength(2)
  })

  it('lets another plugin send through config.custom.notifications.notify', async () => {
    const u = await person()
    const viaConfig = (payload.config.custom as Doc).notifications.notify as typeof notify
    expect((await viaConfig(payload, { recipient: u.id, kind: 'kit-ready', params: { code: '77' }, scope: siteA })).outcome).toBe('stored')
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[u.email, 'Kit 77']])
  })
})

describe('with no site field', () => {
  let plain: Payload
  beforeAll(async () => {
    plain = await getPayload({ config: await baseConfig({ scopeField: undefined, scopeFor: undefined }, [], 'notifications-plain'), key: 'plain' } as never)
  }, 120_000)
  afterAll(async () => {
    await plain?.db.connection?.dropDatabase?.()
    await plain?.destroy()
  })

  it('shows a person only their own notices and preferences, and marks only their own read', async () => {
    const make = async (email: string, role = 'member') => (await plain.create({ collection: 'users', data: { email, password: 'a made-up password', role, status: 'active' } as never, overrideAccess: true })) as Doc
    const [a, b, boss] = [await make('plain-a@example.com'), await make('plain-b@example.com'), await make('plain-staff@example.com', 'staff')]
    expect((await notify(plain, { recipient: a.id, kind: 'transfer-offered', params: { from: 'Made Up', animal: 'Gecko 1' } })).outcome).toBe('stored')
    expect((await notify(plain, { recipient: b.id, kind: 'transfer-offered', params: { from: 'Someone Else', animal: 'Skink 9' } })).outcome).toBe('stored')
    await setPreference(plain, { user: b.id, key: 'all', email: false })
    const as = (u: Doc) => ({ overrideAccess: false, depth: 0, user: { ...u, collection: 'users' } as never })
    const seen = async (u: Doc) => ((await plain.find({ collection: 'notifications' as never, ...as(u) })).docs as Doc[]).map((d) => String(d.recipient))
    expect(await seen(a)).toEqual([String(a.id)])
    expect((await seen(boss)).sort()).toEqual([String(a.id), String(b.id)].sort())
    expect((await plain.find({ collection: 'notification-preferences' as never, ...as(a) })).docs).toEqual([])
    await expect(plain.find({ collection: 'notifications' as never, overrideAccess: false })).rejects.toThrow(/not allowed/)
    // The endpoints need no site here, and still answer for the caller alone.
    const token = (await plain.login({ collection: 'users', data: { email: a.email, password: 'a made-up password' } })).token!
    expect((await call('/notifications/mine', 'get', null, { on: plain })).status).toBe(401)
    expect((await call('/notifications/mine', 'get', null, { on: plain, token })).body.docs.map((d: Doc) => d.text)).toEqual(['Made Up offered you Gecko 1'])
    const bNotice = (await plain.find({ collection: 'notifications' as never, where: { recipient: { equals: b.id } }, overrideAccess: true })).docs[0] as Doc
    expect((await call(`/notifications/${bNotice.id}`, 'get', null, { on: plain, token })).status).toBe(404)
    expect((await call('/notifications/read', 'post', null, { on: plain, token, body: { ids: [bNotice.id] } })).body).toEqual({ marked: 0 })
    expect((await call('/notifications/read', 'post', null, { on: plain, token, body: { all: true } })).body).toEqual({ marked: 1 })
    expect(await unreadCount(plain, { user: b.id })).toBe(1)
  })
})
