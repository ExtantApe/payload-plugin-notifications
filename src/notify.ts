import type { Payload, Where } from 'payload'

import { kindsOf } from './kinds.js'
import { sendOne } from './queue.js'
import type { NotifyInput, NotifyResult, Req } from './types.js'
import { asReq, configOf, errorShape, HOUR, idOf } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Store a notice for one person, and send its email copy when they allow it.
 *
 * - Never throws: a notice must not break the action that caused it. A failure is logged by kind only, never with
 *   the params, the address or the link.
 * - With a `req` in a transaction, the notice is part of it: a rolled-back action leaves none. Its email is left
 *   for `sendPendingNotifications`, because it mustn't go before the commit. Otherwise the email is tried at once.
 * - It writes through the database adapter, not a Payload operation, so a failed notice can't roll back the
 *   caller's transaction. A database error inside that transaction (a write conflict, say) can still abort it,
 *   as any write in it would.
 * - Nobody is told about their own action. Params must be strings, so a whole document (and its private fields)
 *   can't be dropped into a notice by mistake.
 */
export async function notify(payload: Payload, input: NotifyInput, req?: Req): Promise<NotifyResult> {
  const kindKey = typeof input?.kind === 'string' ? input.kind : '(none)'
  try {
    const o = configOf(payload)
    const recipient = idOf(input?.recipient)
    if (recipient === null) return refuse(payload, kindKey, 'no recipient')
    if (input.actor !== undefined && input.actor !== null && String(idOf(input.actor)) === String(recipient)) return { id: null, outcome: 'self' }
    const kind = kindsOf(payload)[kindKey]
    if (!kind) return refuse(payload, kindKey, 'unknown kind')
    const params = input.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((v) => typeof v !== 'string')) return refuse(payload, kindKey, 'params must be strings')
    if (input.link !== undefined && input.link !== null && (typeof input.link !== 'string' || !/^\/(?![/\\])[^\\\s\x00-\x1f]*$/.test(input.link) || input.link.length > 2000))
      return refuse(payload, kindKey, 'link must be a site path')
    const scope = idOf(input.scope)
    if (o.scopeField && scope === null) return refuse(payload, kindKey, 'no scope')

    if (input.dedupeKey !== undefined && (typeof input.dedupeKey !== 'string' || input.dedupeKey.length > 200)) return refuse(payload, kindKey, 'dedupeKey must be a short string')

    // Straight to the database adapter, with no operation around it: Payload's operations roll back the caller's
    // whole transaction when they fail, and a notice must never undo the action that caused it. Everything the
    // operation would check is checked above, or here.
    const r = asReq(payload, req)
    const db = { ...(r.transactionID ? { req: r } : {}) }
    const exists = await payload.db.findOne({ collection: o.users, where: { id: { equals: recipient } }, ...db } as never)
    if (!exists) return refuse(payload, kindKey, 'no such recipient')
    if (input.dedupeKey) {
      const since = new Date(Date.now() - o.dedupeHours * HOUR).toISOString()
      const where: Where = { and: [{ recipient: { equals: recipient } }, { dedupeKey: { equals: input.dedupeKey } }, { createdAt: { greater_than: since } }] }
      if (o.scopeField) where.and!.push({ [o.scopeField]: { equals: scope } })
      const found = await payload.db.findOne({ collection: o.notifications, where, ...db } as never)
      if (found) return { id: null, outcome: 'duplicate' }
    }

    const emailed = typeof kind.email === 'function'
    const now = new Date().toISOString()
    const doc = (await payload.db.create({
      collection: o.notifications,
      data: {
        createdAt: now,
        updatedAt: now,
        recipient,
        kind: kindKey,
        params,
        ...(input.link ? { link: input.link } : {}),
        priority: kind.priority ?? 'normal',
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        ...(o.scopeField ? { [o.scopeField]: scope } : {}),
        emailStatus: emailed ? 'pending' : 'skipped',
        ...(emailed ? { emailNextAt: now } : { emailSkipReason: 'never emailed' }),
        emailAttempts: 0,
      },
      ...db,
    } as never)) as Doc

    // Inside someone's transaction the notice isn't committed yet: the queue sends it after.
    if (emailed && !r.transactionID) await sendOne(payload, doc.id)
    return { id: doc.id, outcome: 'stored' }
  } catch (error) {
    payload.logger.error({ kind: kindKey, ...errorShape(error), msg: 'notifications: notice not stored' })
    return { id: null, outcome: 'error' }
  }
}

function refuse(payload: Payload, kind: string, why: string): NotifyResult {
  payload.logger.warn({ kind, why, msg: 'notifications: notice refused' })
  return { id: null, outcome: 'refused' }
}
