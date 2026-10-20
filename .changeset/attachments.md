---
'telegram-ask': minor
---

Attachments: `attachment` on `/request`, `/request/async` and `/notify` (and on `ask_for_permission`, `ask_for_permission_in_background` and `notify_user`, `--attach` on `send`, `attachment` on `Client`) sends one file to Telegram as a document right above the message. Needs a service at least this new; clients say so if it isn't.
