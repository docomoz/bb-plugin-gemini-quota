---
name: gemini-quota
description: Check or configure Gemini quota snapshots in BB Provider Usage.
---

Set `terminalId` with `bb plugin config gemini-quota set terminalId <term_id>`. Set `agyPath` to the absolute Antigravity CLI executable path on the terminal host when it differs from the default under the BB server account’s home directory. Provider Usage's refresh button opens a temporary terminal in the configured workspace, runs `/usage`, and closes the terminal. BB also reads the source terminal’s rendered quota screen once a minute when it is open. The panel shows percentages used, estimated reset times, and the time of the last successful snapshot. The CLI must be signed in and the quota screen must be in English. This integration was tested on Linux with Antigravity CLI 1.5.16.
