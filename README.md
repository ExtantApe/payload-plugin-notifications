# payload-plugin-notifications

Notifications for Payload: in-site notices, email copies people can turn off per kind, and a retrying send queue, with kinds registered by your own code or other plugins.

**Status:** 0.1.0, not on npm yet. 22 tests pass against Payload 3.92 with an in-memory MongoDB replica set. They cover the endpoints through Payload's own routing with real sign-in tokens, kinds from two owners, refusals, dedupe, the caller's transaction, logs without personal data, preferences per site, the age limit on emails, backoff, priority order, overlapping queue runs, access and retention. No site uses it yet, and no real email has been sent: the tests capture email.

## What it does

- **Kinds, registered by anyone.** A kind is a key with its words (`text`), an optional email (`email`), and defaults: priority, a group for the preferences page, on or off by default, or required. Your site passes its kinds as an option. Another plugin adds its own to `config.custom.notificationKinds` without importing this one, and plugin order doesn't matter. A kind registered twice stops the site at start-up, naming both owners.
- **`notify(payload, { recipient, kind, params, link, actor, dedupeKey, scope }, req)`** stores a notice and sends its email copy.
  - It never throws, so a notice can't break the action that caused it.
  - Nobody is told about their own action.
  - Params must be strings, and the link must be a path on your site.
  - The same `dedupeKey` for the same person within 24 hours is stored once.
  - Inside your transaction (a `req` with one), a rolled-back action leaves no notice, and the email waits for the queue instead of going out before the commit. A refused or failed notice never rolls back your transaction, because notify checks everything first and writes through the database adapter, not a Payload operation. A database error inside your transaction (a write conflict, say) can still abort it, as any write in it would.
  - Dedupe is a check, then a write: two calls at the same moment can both be stored.
- **Email copies** go through your sender (`sendEmail`), so your branding and your send switch apply. Each email ends with a link to the person's preferences.
  - An email is skipped when the person turned its group off, or all email; when the account has no email or isn't active (`isActive`); or when the kind is never emailed.
  - A required kind ignores the person's switch.
  - An email that can't go out is retried after 5 minutes, 30 minutes, 2 hours and 12 hours, then marked failed. The notice stays either way.
- **A send queue** for retries and for notices made inside transactions: `sendPendingNotifications(payload)`, every few minutes from your scheduled job. It sends high priority first, then normal, then low, oldest first. Each email is claimed with a conditional write before it's sent, so runs that overlap don't send one twice. That's tested on MongoDB; other databases aren't tested. A claim left by a run that died is picked up after 15 minutes, so a send that hangs longer than that can go twice.
- **No backlog, ever.** A notice older than `emailMaxAgeHours` (48) when its email's turn comes is skipped. Switching email on, or restoring a copy of the database, can't send old notices.
- **Preferences** per person and per site: one switch for all email, and one per group (or per kind without a group). Only what the person changed is stored. They're in their own collection, `notification-preferences`, so nothing is added to your users.
- **Reading:**
  - A person reads only their own notices, on the current site (`scopeFor`) when the plugin is scoped; with no site, nothing. Managers read everyone's: `access.manage` is required, and only an answer of exactly `true` counts.
  - The delivery fields (email status, skip reason, attempts, times, dedupe key) are for managers only.
  - Nobody creates, changes or deletes notices through the API.
  - Endpoints for the signed-in person, all `Cache-Control: no-store`:

    | Method and path | Body | Answer |
    | --- | --- | --- |
    | `GET /api/notifications/mine?limit&before` | | `{ docs: [{ id, kind, text, link, createdAt, read }] }`, newest first, at most 100 |
    | `GET /api/notifications/unread` | | `{ count }` |
    | `POST /api/notifications/read` | `{ ids }` or `{ all: true }` | `{ marked }`, the person's own only |
    | `GET /api/notification-preferences/mine` | | `{ allEmail, rows: [{ key, label, email, required }] }` |
    | `POST /api/notification-preferences/mine` | `{ key, email }`, where key is `all` or a row's key | the preferences |

    They're collection endpoints, so with other slugs the paths follow. Signed out is 401, and a request with no site is 403.

  - The same functions are exported for your own pages: `listNotifications`, `unreadCount`, `markRead`, `getPreferences`, `setPreference`.
- **Retention:** `pruneNotifications(payload)`, daily, deletes read notices older than 180 days (`retentionDays`) and unread ones older than twice that.
- **This plugin's logs** carry the kind and the failure's name, never the params, an address or a link. With no `sendEmail` and no email adapter, Payload's own console adapter prints each email's address and subject: set one before real people sign up.
- **Preferences:** two changes at the same moment can lose one of them.

Params are what a notice shows, so keep them to names and words. Never put ages, birth dates, locations or contact details in them.

## On its own, and with others

**On its own:** Notifications needs only Payload, an `access.manage` rule, your kinds, and a way to send email (`sendEmail`, or Payload's email adapter). Run its queue and its clean-up from your scheduled jobs.

**Works with:** any plugin that registers kinds at `config.custom.notificationKinds` and sends through `config.custom.notifications.notify`, as shown under [Install](#install). Neither side imports the other. Those designed so far:
- **Sample Kits:** your site points its `notify` option at this plugin's `notify`.
- **Shipping:** sends nothing itself. Its `noticeFor` gives the tracking status, and the plugin that owns the parcel sends it through here.
- **Guardians** (planned): its suggestion and link notices, from its 0.1.

**Family:** Notifications has no family on purpose: it's meant to work with any plugin. The families are a working draft, and Fulfillment, where several of its partners sit, is due to be split.

## Install

```sh
npm install @extantape/payload-plugin-notifications
```

```ts
import { notificationsPlugin, notify } from '@extantape/payload-plugin-notifications'

export default buildConfig({
  plugins: [
    notificationsPlugin({
      kinds: {
        'transfer-offered': {
          text: (p) => `${p.from} offered you ${p.animal}`,
          email: (p, { link }) => ({ subject: `${p.from} wants to transfer ${p.animal} to you`, text: `Accept or decline it: ${link}` }),
          group: 'Transfers',
        },
      },
      access: { manage: ({ req }) => req.user?.role === 'admin' }, // required
      sendEmail: ({ to, subject, text }) => mySiteEmail({ to, subject, text }),
      isActive: (user) => user.status === 'active',
      // With a tenant plugin: scopeField: 'tenant', scopeFor: (req) => tenantOf(req), and add both collections to it.
    }),
  ],
})

await notify(payload, { recipient: animal.offeredTo, actor: req.user?.id, kind: 'transfer-offered', params: { from: 'Made Up', animal: animal.name }, link: '/my-animals' }, req)
```

**From another plugin**, without a dependency:

```ts
// In your plugin's config function:
config.custom = { ...config.custom, notificationKinds: [...(config.custom?.notificationKinds ?? []), { owner: 'my-plugin', kinds: { 'kit-ready': { text: (p) => `Kit ${p.code} is ready` } } }] }
// When something happens:
const notify = payload.config.custom?.notifications?.notify
if (notify) await notify(payload, { recipient, kind: 'kit-ready', params: { code } }, req)
else /* your own fallback, or nothing */
```

Build the collections' indexes before first use. Run `sendPendingNotifications` every few minutes and `pruneNotifications` daily.

## Commands

```sh
npm test          # integration tests, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
