# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

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
