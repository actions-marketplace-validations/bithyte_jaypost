---
'telegram-ask': minor
---

The service keeps a log of every question and how it ended in `audit.jsonl` next to its config, and `telegram-ask log` prints it (`--since 12h`, `--project`, `-n`, `--json`). Installs from earlier versions need `telegram-ask init` to start logging.
