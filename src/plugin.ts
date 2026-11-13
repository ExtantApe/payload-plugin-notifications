import type { Access, Config, Plugin } from 'payload'

import { notificationsCollection, preferencesCollection } from './collections.js'
import { notificationEndpoints, preferenceEndpoints } from './endpoints.js'
import { kindsOf } from './kinds.js'
import { notify } from './notify.js'
import type { NotificationsPluginOptions, ResolvedNotifications } from './types.js'

/**
 * Notifications: in-site notices, email copies people can turn off, and a retrying send queue. Kinds come from
 * the site's options and from other plugins' `config.custom.notificationKinds`. Other plugins send through
 * `config.custom.notifications.notify` when it's there, so nobody imports this package but the site.
 */
export const notificationsPlugin =
  (options: NotificationsPluginOptions): Plugin =>
  (config: Config): Config => {
    const o: ResolvedNotifications = {
      users: options.users ?? config.admin?.user ?? 'users',
      notifications: options.slugs?.notifications ?? 'notifications',
      preferences: options.slugs?.preferences ?? 'notification-preferences',
      ownKinds: options.kinds ?? {},
      manage: options?.access?.manage as Access,
      sendEmail: options.sendEmail,
      isActive: options.isActive ?? (() => true),
      absoluteURL: options.absoluteURL,
      preferencesPath: options.preferencesPath ?? '/notifications',
      scopeField: options.scopeField,
      scopeFor: options.scopeFor,
      dedupeHours: options.dedupeHours ?? 24,
      retentionDays: options.retentionDays ?? 180,
      maxAttempts: options.maxAttempts ?? 5,
      emailMaxAgeHours: options.emailMaxAgeHours ?? 48,
      adminGroup: options.adminGroup ?? 'Notifications',
    }
    // Fail closed: without it, the admin's list of everyone's notices would follow whatever default a site has.
    if (typeof o.manage !== 'function') throw new Error('Notifications: give `access.manage`, saying who may see everyone’s notices and preferences.')
    if (o.scopeField && !o.scopeFor) throw new Error('Notifications: with `scopeField`, give `scopeFor` so the endpoints know the site.')
    const collections = config.collections ?? []
    if (!collections.some((c) => c.slug === o.users && c.auth)) throw new Error(`Notifications: "${o.users}" isn't an auth collection in this config. Set \`users\`.`)
    const clash = collections.filter((c) => [o.notifications, o.preferences].includes(c.slug)).map((c) => c.slug)
    if (clash.length) throw new Error(`Notifications: ${clash.join(', ')} already exist in this config. Remove the site's own collection, or give Notifications other slugs with \`slugs\`.`)

    return {
      ...config,
      custom: { ...config.custom, notifications: { ...o, notify: (payload: Parameters<typeof notify>[0], input: Parameters<typeof notify>[1], req?: Parameters<typeof notify>[2]) => notify(payload, input, req) } },
      collections: [...collections, { ...notificationsCollection(o), endpoints: notificationEndpoints }, { ...preferencesCollection(o), endpoints: preferenceEndpoints }],
      onInit: async (payload) => {
        // Every plugin has added its kinds by now: a duplicate or a kind without words stops the site here, not later.
        kindsOf(payload)
        await config.onInit?.(payload)
      },
    }
  }
