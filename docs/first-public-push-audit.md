# First public push audit

By the Plugins Lead, 2026-11-10, before the repo's first push. The owner's rule: "No private repos because CI" (2026-11-10, D5). Every commit was scanned, not just the latest files.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh`, with the private terms and in CI mode (`LEAK_PRIVATE_TERMS=/nonexistent`) | both passed (security read, 6412b5e; rerun at the commit below) |
| Keys, tokens, passwords, secrets | none. Tests use made-up passwords and `test-secret-not-for-production` |
| Email addresses in history | only made-up `@example.com` addresses in tests and the noreply author address |
| Server or database hosts, deploy URLs, IP addresses | none; `site.example.com` in tests only |
| Real people's data, personal names | none in files or commit messages. Git's author field holds the full name, which `~/Code/CLAUDE.md` allows |
| Claude session links in commit text | none |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed (ignored) |
| Leak check in CI | yes, `.github/workflows/leak-check.yml` |
| LICENSE | MIT, "Copyright (c) 2026 Captive Origins" |
| Keywords | base words, then `notifications` and `email` (categories in captive-origins `docs/plugin-tags.md`), no family tags, 12 in all |
| README status line | yes |
| Pre-publish security read | approved at 6e94609 after two rounds (a subagent with Plugin Security's checklist) |

Result: clean.
