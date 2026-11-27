# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-26: sweep after 0.1.0

All tests are in `test/notifications.test.ts`, so each one below is named by its group and the start of its title. 31 tests, up from 22. The plugin's code didn't change.

- **Promises.** Read from the README and `docs/decisions.md`:
  - Kinds come from the site and from other plugins, in any plugin order. A kind registered twice, without words or with an unknown priority stops start-up. `access.manage` is required, and so is `scopeFor` with `scopeField`.
  - `notify` stores a notice and emails a copy. It never throws, tells nobody about their own action, takes string params and site paths only, stores a dedupe key once per person in 24 hours, joins the caller's transaction and never undoes the caller's work.
  - Other plugins send through `config.custom.notifications.notify`.
  - An email goes to the notice's recipient through the site's sender, with the preferences link. It's skipped for a group or all email turned off, an account with no address, an inactive account and a kind that's never emailed. A required kind ignores the switch.
  - Retries after 5 minutes, 30 minutes, 2 hours and 12 hours, then failed, with the notice kept. High priority goes first. Overlapping runs send once. A dead run's claim is picked up.
  - A notice older than 48 hours is never emailed (decision, 2026-11-10). Inside a transaction the email waits for the queue (decision, 2026-11-10).
  - Preferences are per person and per site, in their own collection.
  - A person reads only their own notices, on the current site, and nothing without a site. Managers read everyone's, and only an answer of exactly `true` from `access.manage` counts. Delivery fields are for managers. Nobody creates, changes or deletes through the API.
  - Five endpoints, all `no-store`: 401 signed out, 403 with no site, the caller's own data only, at most 100 notices in a list.
  - Retention deletes read notices after 180 days and unread ones after 360.
  - Logs carry the kind and the failure's name only.
- **Covered.** Promise by test:
  - Kinds and start-up checks: `kinds > takes kinds…`, `kinds > stops the site at start-up…`, `kinds > refuses to start without access.manage…`
  - Storing, the email and its links: `notify > stores a notice…`
  - Self-actions and refused input: `notify > tells nobody about their own action…`
  - Dedupe: `notify > stores a dedupe key once…`
  - The caller's transaction: `notify > is part of the caller’s transaction…`, `notify > never undoes the caller’s work…`
  - Never throws, clean logs: `notify > never throws…`, `refusals and leaks > emails only on an isActive answer…`
  - Sending through the config: `refusals and leaks > lets another plugin send…`
  - Email switches, required kinds, per site: `email copies > skips when the person turned the group off…`, `email copies > follows a kind that is off by default…`
  - Inactive accounts, and `isActive` counting only exactly `true`: `email copies > skips an inactive account`, `refusals and leaks > emails only on an isActive answer…`
  - A rule or a preferences read that throws sends nothing, and an account with no address is skipped: `refusals and leaks > emails only on an isActive answer…`
  - Each email to its own recipient only: `refusals and leaks > sends each email copy to its notice’s own recipient only…`
  - The age limit: `email copies > never sends a backlog…`
  - Backoff, priority, overlapping runs, stale claims: `the send queue` (4)
  - Own notices per site through the functions: `reading and access > lists a person’s own notices…`
  - Own data, managers and no writes through the Local API, with delivery fields hidden: `reading and access > lets a person read only their own…`
  - The same through REST, signed in and signed out, with writes refused for a manager too, and delivery fields closed to searching and sorting: `refusals and leaks > keeps another person’s notices and preferences out of reach…`, `reading and access > shows a person only the current site’s notices…`
  - `access.manage` counting only exactly `true`, and refusing when it throws: `refusals and leaks > counts only an answer of exactly true…`
  - Every endpoint refused when signed out, from another sign-in collection, with no site or a site lookup that throws, and `no-store` on every answer: `refusals and leaks > refuses every endpoint…`, `reading and access > serves the endpoints…`
  - Marking read and preferences stay with the caller and the current site: `refusals and leaks > marks read and changes preferences for the signed-in person…`
  - The list's six fields and its limit of 100: `refusals and leaks > answers the list with its six fields only…`
  - A site with no `scopeField`: `with no site field > shows a person only their own…`
  - Retention: `retention > deletes read notices…`
- **Gaps added.** Nine tests. Each one failed against a one-line break of the code it guards, then passed on the real code:
  - `refuses every endpoint…`: before this, only `/mine` was tried signed out and without a site, and `no-store` wasn't checked at all.
  - `keeps another person’s notices and preferences out of reach…`: another person's notice or preferences by id, by search and by list through REST, signed in and signed out, and writes through REST as a member and as a manager.
  - `marks read and changes preferences for the signed-in person…`: a body that names another person or another site changes nothing of theirs, and only `all: true` marks everything.
  - `answers the list with its six fields only…`: no recipient, params, site or delivery field in the answer, and 100 at most.
  - `counts only an answer of exactly true…`: a query, a string, a number and nothing from `access.manage` all count as no, and a throw refuses the read.
  - `sends each email copy to its notice’s own recipient only…`: two people's emails in one queue run and one sent at once, each checked for the other's address, id, words and link, and for the actor's.
  - `emails only on an isActive answer…`: odd answers skip, a throwing rule or a failed preferences read sends nothing and waits, an account with no address is skipped, and the log names no one.
  - `lets another plugin send…`: the path other plugins use had no test.
  - `with no site field…`: the whole unscoped mode had no test.
- **Gaps skipped**, and why:
  - **GraphQL.** It uses the same access functions as REST, and Payload's own routing of them is its to test.
  - **Payload's own email adapter as the fallback** (no `sendEmail`), and `absoluteURL`. Each needs another Payload instance for one line of pass-through. The README already warns about the console adapter.
  - **The 200-character dedupe key and the 2,000-character link.** Input limits beside the link and params checks, which are covered.
  - **Start-up errors for a users collection without sign-in, and for a slug that already exists.** Configuration messages with no access or data at stake.
  - **Two `notify` calls at the same moment, and two preference changes at the same moment.** The README states both as limits.
  - **Two runners' claims on Postgres, a real tenant plugin, real email, locales in `text`.** As on 2026-11-10.

## 2026-11-10: 0.1.0

| Promise | Test |
| --- | --- |
| Kinds from options and from another plugin's registration, in either plugin order | `kinds > takes kinds…` |
| A kind registered twice, or with no words, stops start-up; `access.manage` and `scopeFor` required | `kinds` (2) |
| A notice is stored and its email sent with its link and the preferences link | `notify > stores a notice…` |
| Self-actions, non-string params, unknown kinds, outside links and a missing site are refused, storing nothing | `notify > tells nobody…` |
| Dedupe per person within the window | `notify > stores a dedupe key…` |
| A rolled-back transaction leaves nothing; a committed one leaves the email to the queue | `notify > is part of the caller's transaction…` |
| Never throws; logs carry no params, address, link or mail-server text | `notify > never throws…` |
| Preferences: group off, all off, required kinds, per site, off by default, never-emailed kinds, inactive accounts | `email copies` (3) |
| A notice past the age limit is never emailed | `email copies > never sends a backlog…` |
| Backoff, failed after 5, the notice kept | `the send queue > retries…` |
| High, then normal, then low | `the send queue > sends high priority first…` |
| Overlapping runs send each email once; a dead run's claim is picked up | `the send queue` (2) |
| Own notices only, per site; marking read touches only one's own | `reading and access > lists…` |
| API access: own notices and preferences only, managers all, no writes for anyone | `reading and access > lets a person read…` |
| Endpoints through Payload's real routing: 401 signed out, 403 without a site, own data only, unknown preference refused | `reading and access > serves the endpoints…` |
| REST shows only the current site's own notices, nothing without a site; delivery fields hidden from non-managers | `reading and access > shows a person only…`, `lets a person read…` |
| Members never see delivery fields (status, skip reason, dedupe key); an account from another sign-in collection is refused | `reading and access > lets a person read…` |
| A failing notice inside the caller's transaction leaves the caller's work committed | `notify > never undoes the caller's work…` |
| Retention | `retention` |

Gaps added after the security read (an automated review against the plugin security checklist): routing, the caller's transaction, site scoping and hidden fields above.

Gaps skipped, and why:
- **Two runners' claims on Postgres.** Only MongoDB is tested; the README says so.
- **A real tenant plugin.** The test adds the site field itself; the first site's switch tests the real one.
- **Real email.** It goes through the site's sender, which the site tests.
- **Locales in `text`.** The plugin passes `req.locale` through; what the words are is the kind owner's job.
