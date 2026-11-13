# Changelog

## 0.1.0 (unreleased)

First version: kinds registered by the site and by other plugins; `notify` that never throws and joins the caller's transaction; email copies through the site's sender with per-person, per-site preferences; a retrying, priority-ordered send queue with claimed sends and an age limit; endpoints and functions for the person's list, unread count, marking read and preferences; managers-only access to everyone's notices; retention.

Tested: 22 integration tests on a real MongoDB in memory, with the endpoints going through Payload's routing. A security read found the endpoints unreachable at their first paths and a failing notice able to roll back the caller's transaction; both are fixed. Not tested: a real site, real email, a real tenant plugin.
