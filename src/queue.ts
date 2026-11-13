import type { CollectionSlug, Payload, Where } from 'payload'

import { kindsOf, prefKey } from './kinds.js'
import type { ID, Priority, Req } from './types.js'
import { asReq, configOf, errorShape, HOUR, idOf } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const sys = { overrideAccess: true, depth: 0 } as const
/** Waits between tries: 5 min, 30 min, 2 h, 12 h. */
const BACKOFF = [5 * 60_000, 30 * 60_000, 2 * HOUR, 12 * HOUR]
/** A claim older than this was left by a runner that died; the email can be tried again. */
const STALE_CLAIM = 15 * 60_000
const ORDER: Priority[] = ['high', 'normal', 'low']

/**
 * Claim one email with a conditional write: only a pending (or stale sending) email whose attempts match is
 * claimed, so two runners never send the same email. `db.updateOne` ignores `where` when given an id, so the id
 * goes inside `where`.
 */
async function claim(payload: Payload, doc: Doc): Promise<Doc | null> {
  const o = configOf(payload)
  const now = new Date()
  const stale = new Date(now.getTime() - STALE_CLAIM).toISOString()
  const where: Where = {
    and: [
      { id: { equals: doc.id } },
      { emailAttempts: { equals: doc.emailAttempts ?? 0 } },
      { or: [{ emailStatus: { equals: 'pending' } }, { and: [{ emailStatus: { equals: 'sending' } }, { emailClaimedAt: { less_than: stale } }] }] },
    ],
  }
  const claimed = await payload.db.updateOne({
    collection: o.notifications as CollectionSlug,
    where,
    data: { emailStatus: 'sending', emailClaimedAt: now.toISOString(), emailAttempts: (doc.emailAttempts ?? 0) + 1 },
    returning: true,
  } as never)
  return (claimed as Doc | null) ?? null
}

const finish = (payload: Payload, id: ID, data: Doc) =>
  payload.db.updateOne({ collection: configOf(payload).notifications as CollectionSlug, where: { id: { equals: id } }, data } as never)

/** Whether this person gets this kind by email, from their preferences and the kind's default. */
async function wants(payload: Payload, doc: Doc, key: string, req: Req): Promise<boolean> {
  const o = configOf(payload)
  const kind = kindsOf(payload)[key]!
  if (kind.required) return true
  const where: Where = { user: { equals: idOf(doc.recipient) } }
  if (o.scopeField) Object.assign(where, { [o.scopeField]: { equals: idOf(doc[o.scopeField]) } })
  const prefs = ((await payload.find({ collection: o.preferences as CollectionSlug, where, limit: 1, pagination: false, ...sys, req: asReq(payload, req) })).docs as Doc[])[0]
  if (prefs && prefs.allEmail === false) return false
  const own = (prefs?.email ?? {}) as Record<string, unknown>
  const choice = own[prefKey(key, kind)]
  return typeof choice === 'boolean' ? choice : kind.emailByDefault !== false
}

/**
 * Try one notice's email: claim it, check it's still wanted and not too old, send, record the outcome. Never
 * throws. A failure is retried with backoff until `maxAttempts`, then marked failed; the notice itself stays.
 */
export async function sendOne(payload: Payload, id: ID, req: Req = {}): Promise<'sent' | 'skipped' | 'retry' | 'failed' | 'busy'> {
  const o = configOf(payload)
  let kindKey = '(unknown)'
  let claimed: Doc | null = null
  try {
    const doc = (await payload.findByID({ collection: o.notifications as CollectionSlug, id, ...sys, disableErrors: true })) as Doc | null
    if (!doc) return 'busy'
    kindKey = String(doc.kind)
    claimed = await claim(payload, doc)
    if (!claimed) return 'busy'
    const skip = async (reason: string) => (await finish(payload, id, { emailStatus: 'skipped', emailSkipReason: reason, emailClaimedAt: null }), 'skipped' as const)

    const kind = kindsOf(payload)[kindKey]
    if (!kind?.email) return skip(kind ? 'never emailed' : 'unknown kind')
    if (Date.now() - new Date(doc.createdAt).getTime() > o.emailMaxAgeHours * HOUR) return skip('too old')
    const user = (await payload.findByID({ collection: o.users as CollectionSlug, id: idOf(doc.recipient)!, ...sys, disableErrors: true })) as Doc | null
    if (!user || typeof user.email !== 'string' || !user.email) return skip('no email')
    if ((await o.isActive(user)) !== true) return skip('inactive account')
    if (!(await wants(payload, doc, kindKey, req))) return skip('turned off')

    const scope = o.scopeField ? idOf(doc[o.scopeField]) : null
    const r = asReq(payload, req)
    const path = typeof doc.link === 'string' && doc.link ? doc.link : o.preferencesPath
    const url = (p: string) => (o.absoluteURL ? o.absoluteURL(p, { scope, req: r, payload }) : `${payload.config.serverURL ?? ''}${p}`)
    const link = await url(path)
    const message = kind.email((doc.params ?? {}) as Record<string, string>, { locale: (user.locale as string | undefined) ?? undefined, link })
    if (!message) return skip('never emailed')
    const text = `${message.text}\n\n${link}\n\nYou can choose which emails you get: ${await url(o.preferencesPath)}`
    if (o.sendEmail) await o.sendEmail({ to: user.email, subject: message.subject, text, link, kind: kindKey, req: r, payload })
    else await payload.sendEmail({ to: user.email, subject: message.subject, text })
    await finish(payload, id, { emailStatus: 'sent', emailSentAt: new Date().toISOString(), emailClaimedAt: null })
    return 'sent'
  } catch (error) {
    payload.logger.error({ kind: kindKey, ...errorShape(error), msg: 'notifications: email not sent' })
    if (!claimed) return 'busy'
    const attempts = Number(claimed.emailAttempts ?? 1)
    try {
      if (attempts >= o.maxAttempts) {
        await finish(payload, id, { emailStatus: 'failed', emailClaimedAt: null })
        return 'failed'
      }
      const wait = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]!
      await finish(payload, id, { emailStatus: 'pending', emailNextAt: new Date(Date.now() + wait).toISOString(), emailClaimedAt: null })
    } catch (e) {
      // The claim goes stale and the email is tried again later.
      payload.logger.error({ kind: kindKey, ...errorShape(e), msg: 'notifications: email outcome not recorded' })
    }
    return 'retry'
  }
}

/**
 * Send what's due, high priority first, then oldest. Run it from the site's scheduled job every few minutes. Each
 * email is claimed before it's sent, so overlapping runs are safe.
 */
export async function sendPendingNotifications(payload: Payload, { limit = 100, req }: { limit?: number; req?: Req } = {}) {
  const o = configOf(payload)
  const now = new Date()
  const stale = new Date(now.getTime() - STALE_CLAIM).toISOString()
  const tally = { sent: 0, skipped: 0, retry: 0, failed: 0, busy: 0 }
  let left = limit
  for (const priority of ORDER) {
    if (left <= 0) break
    const where: Where = {
      and: [
        { priority: { equals: priority } },
        { or: [{ and: [{ emailStatus: { equals: 'pending' } }, { emailNextAt: { less_than_equal: now.toISOString() } }] }, { and: [{ emailStatus: { equals: 'sending' } }, { emailClaimedAt: { less_than: stale } }] }] },
      ],
    }
    const due = (await payload.find({ collection: o.notifications as CollectionSlug, where, sort: 'createdAt', limit: left, pagination: false, ...sys })).docs as Doc[]
    for (const doc of due) tally[await sendOne(payload, doc.id, req)]++
    left -= due.length
  }
  return tally
}
