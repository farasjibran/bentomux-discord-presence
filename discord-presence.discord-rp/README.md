# Discord Rich Presence for Bentomux

Show the workspace you have open, its git branch, how much is uncommitted, and
whether an agent is running — on your Discord profile.

```
Bentomux
claude — working
Bentomux-v2 · feat/plugin — 2 files changed ↑2
```

## Install

**Bentomux → Settings → Plugins → Browse marketplace… → Discord Rich Presence**
→ Install.

Or install from a release: download `discord-presence.discord-rp-1.1.0.zip`
from the [releases page](https://github.com/farrasjibran/bentomux-discord-presence/releases)
and use **Install from zip**.

It works out of the box: the presence appears as **Bentomux** with the Bentomux
logo, as soon as the Discord desktop app is running.

Two switches live in **Settings → Discord Presence**:

- **Stop sharing presence** — pauses the presence entirely.
- **Hide workspace & branch** — keeps the presence (agent status included) but
  drops the line that names the workspace and branch, for when you would rather
  not show where you are working.

## What it sends

Discord renders three lines. It fills the first from the application's own
name, so the plugin only fills the other two:

| Line | Field | Contents |
|---|---|---|
| 1 | — | `Bentomux`, written by Discord from the application name |
| 2 | `details` | Agent status (`claude — working`, `2 agents — needs you`), or `Bentomux` when no agent is running |
| 3 | `state` | Workspace · branch, plus the change count while an agent is running. Omitted when **Hide workspace & branch** is on. |

The logo comes from the Rich Presence asset uploaded to the Discord Developer
Portal (`large_image`).

Nothing is fetched over the network and no file is read: the payload is
assembled from state the app already holds.

### About the session timer

`start_timestamp` is sent, but Discord draws it next to the **small icon**, and
that icon is only drawn when `small_image` differs from `large_image`. Only one
asset is uploaded so far, so the timer has nowhere to appear. To show it,
upload a second asset in the portal and name it as `smallImage` — the place
for that is `send()` in `index.js`.

## Discord desktop app only

Rich Presence exists only in the desktop app. Discord in a browser has no IPC
socket, so nothing can deliver an activity to it. If Discord is only open in a
browser, this plugin shows nothing — and no plugin can.

## Permissions

| Permission | Why |
|---|---|
| `app.read` | Read the active workspace (`getState`) and agent state (`onRuntimeStatus`, `onBranch`) |
| `git.read` | `gitStatus` for the branch and the change count |
| `storage` | Store the two flags: sharing, and whether to include the workspace line |
| `backend.invoke` | The generic path to a backend command |
| `discord.write` | **`discord_set_activity` / `discord_clear_activity`** — the only permission here that writes anything |

`discord.write` is not granted automatically to a plugin that merely holds
`backend.invoke`; the facade throws a named error if the permission was not
declared.

Permissions are a contract, not a sandbox: plugin code runs inside Bentomux and
shares its JavaScript realm.

## Requirements

This plugin needs a Bentomux build that carries the Discord IPC commands. They
are not in every release — check the app's version against
[docs/PLUGIN_PLATFORM.md](https://github.com/takora-dev/bentomux). Without them
the plugin activates and sends nothing; Settings shows the failure reason.

Updates are throttled to 15 seconds. Discord rate-limits presence updates and
rejects an app that sends too often.

The presence disappears when Discord is closed and returns on the next
heartbeat.

## How it reaches Discord

The Discord desktop client exposes a local IPC socket per running instance —
`$XDG_RUNTIME_DIR`/`$TMPDIR`/`discord-ipc-N` on macOS and Linux,
`\\.\pipe\discord-ipc-N` on Windows. A webview cannot open one, so the app
carries three backend commands for it (`discord_set_activity`,
`discord_clear_activity`, `discord_status`), and this plugin is a thin layer
over those.

That is also why this cannot be a frontend-only plugin: the transport is a
socket, not an HTTP endpoint.

## License

MIT