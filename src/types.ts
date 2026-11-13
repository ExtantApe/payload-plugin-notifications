import type { Access, Payload, PayloadRequest } from 'payload'

export type ID = string | number
export type Req = Partial<PayloadRequest>
export type Params = Record<string, string>
export type Priority = 'high' | 'normal' | 'low'
export const PRIORITIES: Priority[] = ['high', 'normal', 'low']

/** What one kind of notice says, and how it's sent. Registered by the site or by another plugin. */
export type NotificationKind = {
  /** Words for the person's list. Params are plain strings; use them, don't trust them as HTML. */
  text: (params: Params, ctx: { locale?: string }) => string
  /** The email copy. Leave it out, or return null, for a kind that's never emailed. */
  email?: (params: Params, ctx: { locale?: string; link: string }) => { subject: string; text: string } | null
  /** Email on or off until the person chooses. Default: on. */
  emailByDefault?: boolean
  /** high goes first in the queue. Default: normal. */
  priority?: Priority
  /** Kinds in one group share one switch on the preferences page, for example "Transfers". */
  group?: string
  /** People can't turn this kind's email off (an account notice, say). The site's own send switch still applies. */
  required?: boolean
}

/** How another plugin registers its kinds, without importing this one: push onto `config.custom.notificationKinds`. */
export type KindRegistration = { owner: string; kinds: Record<string, NotificationKind> }

export type SendEmail = (args: { to: string; subject: string; text: string; link: string; kind: string; req: Req; payload: Payload }) => Promise<unknown>

export type NotifyInput = {
  recipient: ID | null | undefined
  kind: string
  params?: Params
  /** A site path the notice opens. */
  link?: string | null
  /** Who caused it. Nobody is told about their own action. */
  actor?: ID | null
  /** The same key for the same person within `dedupeHours` is stored once. */
  dedupeKey?: string
  /** The site, when `scopeField` is set. */
  scope?: ID | null
}

export type NotifyResult = { id: ID | null; outcome: 'stored' | 'self' | 'duplicate' | 'refused' | 'error' }

export type NotificationsPluginOptions = {
  /** The site's own kinds. Other plugins add theirs through `config.custom.notificationKinds`. */
  kinds?: Record<string, NotificationKind>
  /** Who sees every notice and everyone's preferences in the admin. Required, so nothing is open by accident. */
  access: { manage: Access }
  /** The auth collection notices go to. Default: `admin.user`, else `users`. */
  users?: string
  /** Sends one email. Default: `payload.sendEmail`. Pass your site's sender so its branding and send switch apply. */
  sendEmail?: SendEmail
  /** Whether an account should get email at all, for example only active ones. Default: every account with an email. */
  isActive?: (user: Record<string, unknown>) => boolean | Promise<boolean>
  /** Where a notice's link points in emails. Default: `serverURL` plus the path. */
  absoluteURL?: (path: string, ctx: { scope: ID | null; req: Req; payload: Payload }) => string | Promise<string>
  /** The path of the person's preferences page, linked at the foot of every email. Default: '/notifications'. */
  preferencesPath?: string
  /** A field that separates sites, such as `tenant`. Your tenant plugin adds the field; notices fill it. */
  scopeField?: string
  /** The site of a signed-in request (with `scopeField`), for the endpoints. Return null to refuse. */
  scopeFor?: (req: Req) => ID | null | Promise<ID | null>
  /** Hours a dedupe key holds. Default 24. */
  dedupeHours?: number
  /** Days a read notice is kept. Unread ones are kept twice as long. Default 180. */
  retentionDays?: number
  /** Tries before an email is marked failed. Default 5. */
  maxAttempts?: number
  /** A notice older than this when its email's turn comes is skipped, so switching email on never sends a backlog. Default 48. */
  emailMaxAgeHours?: number
  slugs?: { notifications?: string; preferences?: string }
  /** Admin group. Default 'Notifications'. */
  adminGroup?: string
}

export type ResolvedNotifications = {
  users: string
  notifications: string
  preferences: string
  ownKinds: Record<string, NotificationKind>
  manage: Access
  sendEmail?: SendEmail
  isActive: (user: Record<string, unknown>) => boolean | Promise<boolean>
  absoluteURL?: NotificationsPluginOptions['absoluteURL']
  preferencesPath: string
  scopeField?: string
  scopeFor?: NotificationsPluginOptions['scopeFor']
  dedupeHours: number
  retentionDays: number
  maxAttempts: number
  emailMaxAgeHours: number
  adminGroup: string
}
