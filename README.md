# Bentomux Discord Rich Presence

Plugins for [Bentomux](https://github.com/takora-dev/bentomux), the calm
desktop for AI agent runtime workspaces.

| Plugin | What it does |
|---|---|
| [discord-presence.discord-rp](discord-presence.discord-rp/) | Puts the active workspace, git branch and agent state on your Discord profile |

## Install from Bentomux

Settings → Plugins → **Browse marketplace…**. This repository carries the
`bentomux-plugin` topic, which is how it is found there.

## Install from a release

Every plugin publishes a `.zip` whose files sit at the archive root. Download
one from the [releases page](https://github.com/farrasjibran/bentomux-discord-presence/releases)
and use Settings → Plugins → **Install from zip**.

## Publishing a new version

```bash
./publish.sh <version> <plugin-dir>
```

Bump `version` in the plugin's `plugin.json` first. The script validates the
plugin, refuses to publish a version that disagrees with the manifest, and
creates the release with the zip asset — which is what makes GitHub publish
the sha256 that Bentomux verifies a download against.

## License

MIT
