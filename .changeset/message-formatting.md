---
'telegram-ask': minor
---

Message formatting. `format: "markdown"` on `/request`, `/notify`, both MCP tools, the Node `Client` and `send --format` renders code spans and fenced blocks, bold, italic, strikethrough, headings and quotes, so a command or diff shows up in monospace. Plain text stays the default and nothing changes for callers who don't send `format`. Unrecognized markup stays as typed, and if Telegram rejects the formatting the message is sent as plain text.
