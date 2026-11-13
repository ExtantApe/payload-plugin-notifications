# 0001: Notifications design record

Status: **draft** (2026-11-10). Nothing is built yet. Task K280, P3: Guardians and the kit plugins send notices through it, so it comes first.

## Context

The Captive Origins site already has on-site notifications:
- `src/collections/Notifications.ts`: recipient, kind, params, link and readAt, per site.
- `src/lib/notifications/index.ts`: `notify()`, `unreadCount()` and `markAllRead()`.
- The `/my-notifications` page.
- One email switch on the user (`emailNotifications`).

Twelve kinds are hard-coded in a select, and their email wording sits in one map. Eight callers in the site use it: transfers, offspring, projects, handoffs, duplicates, pre-orders and kit drop-offs.

Coming next are Guardians (a suggestion waiting for the kid's answer), Sample Kits (pre-order and result notices), Shipping (tracking notices, which the owner wants sent by us rather than by the carrier, 2026-11-09) and Docs. Each would otherwise write its own emails and its own unread list.

Name approved 2026-11-10 (`ops/plugin-names.md`): **Notifications**, `@extantape/payload-plugin-notifications`. MIT, as a general Payload plugin. Agnostic (D2): it imports none of our other plugins, and none of them import it.

## Decision

Notifications owns **storing a notice for a person, showing it, emailing a copy when the person allows it, and retrying that email**. What a notice says belongs to whoever registers its kind.

## 1. Kinds, registered by anyone

A kind is a key with its own wording and defaults:

```ts
type NotificationKind = {
  /** Words for the person's list, in their language. Params are plain strings. */
  text: (params: Record<string, string>, ctx: { locale?: string }) => string
  /** The email copy, or null for "never email this kind". */
  email?: (params: Record<string, string>, ctx: { locale?: string; link: string }) => { subject: string; text: string } | null
  /** On or off for email until the person chooses. Default: on. */
  emailByDefault?: boolean
  /** high is sent first and never waits for a digest; low can wait. Default: normal. */
  priority?: 'high' | 'normal' | 'low'
  /** Shown on the preferences page, for example "Transfers". Kinds in one group share a switch. */
  group?: string
  /** People may not turn this one off (for example, "your account was approved"). Default: false. */
  required?: boolean
}
```

- **The site registers its kinds** in the plugin's options: `notificationsPlugin({ kinds: { 'transfer-offered': {…} } })`.
- **Another plugin registers its own** without importing this one. It merges them into `config.custom.notificationKinds` (an object keyed by kind) in its own config function. Notifications reads that object when it's called, not at startup, so plugin order doesn't matter.
  - Two registrations of one key are a startup error naming both. One owner per kind.
- **Another plugin sends** through `config.custom.notifications.notify` when it's there, and falls back to its own behavior when it isn't. The README gives the five-line pattern.
- **The kind is stored as text**, not a select, so kinds can be added without a schema change. The admin shows the kind's group and text.

## 2. Sending: `notify(payload, input, req?)`

```ts
notify(payload, {
  recipient: ID,           // a user
  kind: string,            // a registered kind; an unknown kind is refused, and that's logged by key only
  params?: Record<string, string>,  // names and words shown in the message; never private details
  link?: string,           // a site path the notice opens
  actor?: ID | null,       // who caused it; nobody is notified about their own action
  dedupeKey?: string,      // the same key for the same recipient within dedupeHours is stored once
  scope?: ID,              // the site, when scopeField is set
}, req)
```

- **It never throws.** A notice must not break the action that caused it. A failure is logged with the kind, never with the params, the recipient's email or the link.
- **It runs inside the caller's transaction** when given `req`, so a rolled-back action leaves no notice. The email goes only after the commit. This is the same after-commit queue Sign-up uses.
- **Params are strings only.** Anything else is refused at write time, so a caller can't drop a whole document, with its private fields, into a notice.

## 3. Email copies and the queue

Each notice carries its email state: `pending`, `sent`, `skipped` (with the reason: preference, no email, inactive account or side effects off), `failed`, plus `attempts` and `nextAttemptAt`.

- **After the commit,** `notify` tries the email once.
- **`sendPendingNotifications(payload, { limit })`** runs from the site's scheduled job, every few minutes. It picks pending emails ordered by priority (high, then normal, then low), then by age. It retries with backoff (5 min, 30 min, 2 h, 12 h). After 5 tries the email is `failed`, and the notice itself stays in the list.
- **Each email is claimed with a conditional update** (state and attempts in the `where`) before it's sent, so two runners never send it twice.
- **Sending goes through the site's adapter:** `sendEmail({ to, subject, text, link, kind, req })`. The default is `payload.sendEmail`. Captive Origins passes its `sendSiteEmail`, so the environment's side-effect switch and the site's branding apply. Every email ends with a link to the preferences page.
- **Who gets an email:** the account has an email, is active (the `isActive(user)` adapter, by default true), and the person's preference for that kind is on. A required kind ignores the preference, but never the side-effect switch.

## 4. Preferences

- **Stored in one hidden-from-others document per person**, `notification-preferences` (user, scope, and a map of group or kind to `{ email: boolean }`). It's sparse: only what the person changed. Everything else follows the kind's default.
  - It isn't stored on the users collection, so the plugin adds no fields to a site's users.
- **Read and changed only by the person and by managers** (`access.manage`, required, as in Sign-up).
- **One switch for all email,** plus one per group. The site's page shows them, and the plugin gives `getPreferences` and `setPreference` for it.
- **Captive Origins' existing `emailNotifications: false`** becomes "all email off" in the site switch, done once by a script the Site lead runs. It's a data step, so Seed World hears about it first (D8).
- **Digest (low priority, daily):** not in 0.1. Low-priority emails go out like the others until it exists.

## 5. Reading

- **Access:** a person reads only their own notices; managers read all. Nobody creates, updates or deletes through the API.
- **Endpoints, for the signed-in person:**
  - `GET /api/notifications?limit&before`: newest first, with `text` filled in from the kind in their locale.
  - `GET /api/notifications/unread`: `{ count }`, cheap, for the header badge.
  - `POST /api/notifications/read`: `{ ids }` or `{ all: true }`, which marks only their own.
- **Functions** for the site's own pages: `listNotifications`, `unreadCount`, `markRead`.
- **Retention:** `pruneNotifications(payload)` deletes read notices older than `retentionDays` (default 180), and unread ones older than twice that. Run it daily.

## 6. Kids and privacy

- Params are names and words only: no ages, birth dates, locations or contact details. The README says so, and each kind's owner keeps to it.
- A notice is visible only to its recipient and to managers. The unread count is the recipient's own.
- Logs carry the kind and the outcome only.
- No tracking pixels or open tracking.

## 7. Multi-tenant

`scopeField` and `scopeFor`, as in Kitting and Sign-up: each notice and each preferences document belongs to one site. Lists, counts and marking read are per site.

## Adapters

| Plugin | Kinds | When |
| --- | --- | --- |
| Captive Origins site | the 12 existing kinds, moved into its config with their wording | site switch (K-task for the Site lead) |
| Guardians | suggestion waiting, suggestion answered, link requested or ended | Guardians 0.1 (K281) |
| Sample Kits | pre-order changed or late, results ready, kit drop-off | Sample Kits build (K74) |
| Shipping | out for delivery, delivered, exception, return received | Shipping build (K78, K92) |
| Sign-up | not used: its emails go to people who don't have an account yet | — |

## The site switch (Captive Origins)

- **Same slug** (`notifications`). Same fields for recipient, params, link and readAt. `kind` goes from select to text, which needs no data change in MongoDB.
- **New fields:** the email state, attempts, nextAttemptAt, priority and dedupeKey. A new collection: `notification-preferences`.
- **Seed World hears before the change (D8):** new fields, the preferences collection, and the `emailNotifications` move.
- The site's `notify()` becomes a thin call to the plugin. The `/my-notifications` page uses `listNotifications`, and the email switch becomes the preferences section.
- One PR in captive-origins, owned by the Site lead. I review it.

## Tests (planned)

- Kinds:
  - registered from options and from `config.custom` in either plugin order;
  - a duplicate key is a startup error;
  - an unknown kind is refused and logged by key only.
- notify:
  - nobody is told about their own action;
  - non-string params are refused;
  - a dedupe key stores once;
  - a rolled-back transaction leaves no notice and sends no email;
  - it never throws, even when the database or the email adapter does.
- Email:
  - preference off gives skipped;
  - a required kind ignores the preference;
  - an inactive account or no email gives skipped;
  - the side-effect switch is the site adapter's job, and is tested in the site.
- Queue:
  - priority order;
  - backoff timings;
  - failed after 5 tries;
  - two runners at once send each email exactly once.
- Access:
  - a person sees only their own notices and preferences;
  - managers see all;
  - API create, update and delete are refused;
  - marking read touches only the person's own notices;
  - per-site isolation with `scopeField`.
- Retention: deletes the right notices.
- Logs: no params, email or link appear in any log line from a failing notify.

## Open

- **Push** (the PWA, P4) becomes a third channel with its own adapter, after 0.1. The data model leaves room: email state is a group, and push would get its own group.
- **Digest** for low-priority kinds: 0.2.

## Rough time

These are guesses of session days, not promises: kinds and notify, 1; queue and preferences, 1; endpoints, access and retention, 1; tests, a security read and docs, 1. About 4 in all.
