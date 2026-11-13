# First public push audit

By the maintainers, 2026-11-10, before the repo's first push. The owner's rule (2026-11-10): plugins are public from their first push, so CI runs on them. Every commit was scanned, not just the latest files.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh`, with the private terms and in CI mode (`LEAK_PRIVATE_TERMS=/nonexistent`) | both passed (security read, 6412b5e; rerun at the commit below) |
| Keys, tokens, passwords, secrets | none. Tests use made-up passwords and `test-secret-not-for-production` |
| Email addresses in history | only made-up `@example.com` addresses in tests and the noreply author address |
| Server or database hosts, deploy URLs, IP addresses | none; `site.example.com` in tests only |
| Real people's data, personal names | none in files or commit messages. Git's author field holds the full name, which the owner allows |
| Claude session links in commit text | none |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed (ignored) |
| Leak check in CI | yes, `.github/workflows/leak-check.yml` |
| LICENSE | MIT, Copyright (c) 2026 EXTANT APE |
| Keywords | base words, then `notifications` and `email` (categories from the shared plugin tag list), no family tags, 12 in all |
| README status line | yes |
| Pre-publish security read | approved at 6e94609 after two rounds (an automated review against the plugin security checklist) |

Result: clean.
