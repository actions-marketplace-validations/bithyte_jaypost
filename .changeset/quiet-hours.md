---
'telegram-ask': minor
---

Quiet hours and mute. `/quiet 23:00-08:00` and `/mute 2h` (with `/unmute`) make notifications arrive silently; approvals still ping. A notification sent while quiet is deleted 8 hours after the quiet period ends. `init` now sets `TZ` for container installs so the window uses your local time. Existing container installs stay on UTC until `init` is re-run. When quiet runs past 47h, the notification isn't auto-deleted.
