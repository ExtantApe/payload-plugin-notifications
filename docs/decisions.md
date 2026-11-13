# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.

- 2026-11-10: name approved by the owner on 2026-11-10. MIT, as a general Payload plugin, and public from its first push after the first-public-push audit. Design in [architecture/0001-design.md](architecture/0001-design.md); not built yet.
- 2026-11-10: notices older than `emailMaxAgeHours` (48) are never emailed, so switching email on or restoring a database can't send a backlog. Asked for by the site's team, whose test data holds about 8,000 notices.
- 2026-11-10: inside a caller's transaction the email waits for the queue, rather than an after-commit hook. Payload has no general after-commit hook for someone else's operation, and sending before the commit could email about something that rolled back.
