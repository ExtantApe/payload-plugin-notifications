# Changelog

## Unreleased

Test audit after 0.1.0: nine more tests, with no change to the plugin's code. They cover every endpoint's refusals (signed out, an account from another sign-in collection, no site, a site lookup that throws), other people's notices and preferences through the REST API, writes refused for everyone, marking read and preferences staying with the caller, the list's six fields and its limit of 100, `access.manage` and `isActive` counting only an answer of exactly true and refusing when they throw, each email going only to its notice's recipient, sending through `config.custom.notifications.notify`, and a site with no `scopeField`.

Tested: 31 integration tests on a real MongoDB in memory. Each new test was run against a one-line break of the code it guards and failed, then passed on the real code. Not tested: a real site, real email, a real tenant plugin, GraphQL, the fallback to Payload's own email adapter, and databases other than MongoDB.

## 0.1.0 (unreleased)

First version: kinds registered by the site and by other plugins; `notify` that never throws and joins the caller's transaction; email copies through the site's sender with per-person, per-site preferences; a retrying, priority-ordered send queue with claimed sends and an age limit; endpoints and functions for the person's list, unread count, marking read and preferences; managers-only access to everyone's notices; retention.

Tested: 22 integration tests on a real MongoDB in memory, with the endpoints going through Payload's routing. A security read found the endpoints unreachable at their first paths and a failing notice able to roll back the caller's transaction; both are fixed. Not tested: a real site, real email, a real tenant plugin.
