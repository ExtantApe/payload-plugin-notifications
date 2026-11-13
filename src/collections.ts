import type { Access, CollectionConfig } from 'payload'

import { PRIORITIES, type ResolvedNotifications } from './types.js'

/**
 * Managers see all (only when `manage` answers exactly true; a query counts as no). Anyone else signed in sees
 * their own, on the current site only when the plugin is scoped. A site that can't be worked out shows nothing.
 */
const ownOrManage =
  (o: ResolvedNotifications, field: string): Access =>
  async (args) => {
    if ((await o.manage(args)) === true) return true
    if (!args.req.user || args.req.user.collection !== o.users) return false
    if (!o.scopeField) return { [field]: { equals: args.req.user.id } }
    let scope = null
    try {
      scope = (await o.scopeFor?.(args.req)) ?? null
    } catch {
      scope = null
    }
    return scope === null ? false : { and: [{ [field]: { equals: args.req.user.id } }, { [o.scopeField]: { equals: scope } }] }
  }
/** Delivery details are for managers: a skip reason can say "inactive account", and a dedupe key is the caller's. */
const managersOnly = (o: ResolvedNotifications) => ({ read: async (args: Parameters<Access>[0]) => (await o.manage(args as never)) === true })
const nobody: Access = () => false

/**
 * Notices. Written only by `notify` (the Local API with access overridden), read by their recipient and by
 * managers. Nobody creates, changes or deletes them through the API: the person marks them read through the
 * plugin's endpoint, which can only touch their own.
 */
export const notificationsCollection = (o: ResolvedNotifications): CollectionConfig => ({
  slug: o.notifications,
  labels: { singular: 'Notification', plural: 'Notifications' },
  admin: { group: o.adminGroup, defaultColumns: ['recipient', 'kind', 'createdAt', 'readAt', 'emailStatus'], useAsTitle: 'kind' },
  access: { read: ownOrManage(o, 'recipient'), create: nobody, update: nobody, delete: nobody },
  timestamps: true,
  indexes: [{ fields: ['emailStatus', 'emailNextAt'] }, { fields: ['recipient', 'dedupeKey'] }],
  fields: [
    { name: 'recipient', type: 'relationship', relationTo: o.users as never, required: true, index: true },
    { name: 'kind', type: 'text', required: true, index: true },
    { name: 'params', type: 'json', admin: { description: 'Names and words shown in the message. Never private details.' } },
    { name: 'link', type: 'text', admin: { description: 'The site path the notice opens.' } },
    { name: 'readAt', type: 'date', index: true },
    { name: 'priority', type: 'select', options: PRIORITIES, defaultValue: 'normal', required: true },
    { name: 'dedupeKey', type: 'text', admin: { hidden: true }, access: managersOnly(o) },
    {
      type: 'collapsible',
      label: 'Email copy',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'emailStatus',
          type: 'select',
          options: ['pending', 'sending', 'sent', 'skipped', 'failed'],
          admin: { description: 'skipped: the person turned it off, has no email, or the kind is never emailed.' },
          access: managersOnly(o),
        },
        { name: 'emailSkipReason', type: 'text', access: managersOnly(o) },
        { name: 'emailAttempts', type: 'number', defaultValue: 0, access: managersOnly(o) },
        { name: 'emailNextAt', type: 'date', access: managersOnly(o) },
        { name: 'emailSentAt', type: 'date', access: managersOnly(o) },
        { name: 'emailClaimedAt', type: 'date', admin: { hidden: true }, access: managersOnly(o) },
      ],
    },
  ],
})

/**
 * Each person's choices, per site: one switch for all email, and one per group or kind. Sparse: only what they
 * changed; everything else follows the kind's default. Read by the person and managers; changed only through the
 * plugin's endpoint or functions.
 */
export const preferencesCollection = (o: ResolvedNotifications): CollectionConfig => ({
  slug: o.preferences,
  labels: { singular: 'Notification preferences', plural: 'Notification preferences' },
  admin: { group: o.adminGroup, defaultColumns: ['user', 'allEmail', 'updatedAt'] },
  access: { read: ownOrManage(o, 'user'), create: nobody, update: nobody, delete: nobody },
  timestamps: true,
  indexes: [{ fields: o.scopeField ? ['user', o.scopeField] : ['user'], unique: true }],
  fields: [
    { name: 'user', type: 'relationship', relationTo: o.users as never, required: true },
    { name: 'allEmail', type: 'checkbox', defaultValue: true, label: 'Email copies on' },
    { name: 'email', type: 'json', admin: { description: 'Per group or kind: true or false. Missing means the kind\'s default.' } },
  ],
})
