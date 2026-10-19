---
'telegram-ask': minor
---

Questions can now wait up to 24 h (`timeout` max 86400, default still 300). Behavior change: a `timeout` above 300, say 900, used to be clamped to 300 and now waits the full time. The Claude Code hook `timeout` setting must be at least `--timeout` + 60.

New endpoints for callers that can't hold a connection open: `POST /request/async` returns `202` once the message is sent, `GET /request/{id}` reads the state (with `?wait=` to long-poll), and `DELETE /request/{id}` cancels. A restart drops background questions; the next start expires their messages.

The MCP server has two new tools: `ask_for_permission_in_background` asks and returns a `request_id` at once, and `wait_for_answer` collects the answer (waiting until it settles by default, or `wait_seconds` at most). Closing the agent session cancels the background questions it hasn't seen answered.
