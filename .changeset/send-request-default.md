---
'telegram-ask': minor
---

`send request` takes `-d, --default <label>` in place of `--timeout-option`, and adds it as the last button unless an `-o` already names it, so `-o Approve -d Decline` is enough. Breaking: scripts using `--timeout-option` need to switch to `-d`.
