/* Discord Rich Presence — a Bentomux plugin.
 *
 * Shows the workspace you are in, its git branch, how much is uncommitted, and
 * whether an agent is running — on your Discord profile.
 *
 * How it reaches Discord: the desktop client exposes a local IPC socket per
 * running instance, and a webview cannot open one. So the app has three
 * commands for it (`discord_set_activity`, `discord_clear_activity`,
 * `discord_status`) which this plugin calls through `ctx.app.invoke`. That
 * needs `backend.invoke` for the passthrough and `discord.write` for the two
 * writing ones; the facade throws by name if either is missing.
 *
 * Everything sent is derived from state the app already holds. Nothing is
 * fetched and no file is read: the payload is a handful of strings that are
 * already on screen.
 */

const ID = 'discord-presence.discord-rp';

/* Discord application id — the "Application ID" from the Discord Developer
   Portal, not a user id and not a bot token. It is baked in so installing
   this plugin is the whole setup: the presence shows up under the Bentomux
   application, which is what owns the logo asset below. */
const APP_ID = '1559054599837720608';

/* The application's display name, which Discord writes on the presence's
   first line and the settings form echoes back as what is being shared. */
const APP_NAME = 'Bentomux';

/* Asset key for the Bentomux logo, as uploaded under this application's
   Rich Presence assets. Discord resolves an asset key against the
   application id in the handshake, so this only resolves for APP_ID above —
   it is not a file path and nothing in the app reads an image. */
const LOGO_ASSET = 'bentomux';

const SETTINGS_KEY = 'settings';

/* Discord rate-limits presence updates and a chatty app gets dropped, so the
   coalescing window is a protocol requirement, not politeness. */
const MIN_INTERVAL_MS = 15_000;

/** "3 files changed, ↑1" — the short form Discord shows under the state. */
function changeLine(status) {
  if (!status?.isRepo) return null;
  const count = status.entries?.length ?? 0;
  if (!count) return 'clean tree';
  const parts = [`${count} file${count === 1 ? '' : 's'} changed`];
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

/**
 * One line for the agents, or null when none are running.
 *
 * This goes in `details`, not `small_text`. Discord renders three lines and
 * fills the first with the application's own name — so `details` is the
 * first line actually under our control, and it is where a status someone
 * wants at a glance belongs. `small_text` is only shown as a tooltip next to
 * the small icon, which is why a status parked there looks like nothing was
 * sent at all.
 */
function agentLine(runStates) {
  const running = Object.values(runStates).filter(s => s?.running);
  if (!running.length) return null;
  const names = [...new Set(running.map(s => s.runtime).filter(Boolean))];
  const who =
    names.length > 1
      ? `${names.length} agents`
      : (names[0] ?? `${running.length} agent${running.length === 1 ? '' : 's'}`);
  if (running.some(s => s.state === 'blocked')) return `${who} — needs you`;
  if (running.some(s => s.state === 'working')) return `${who} — working`;
  return `${who} — idle`;
}

/** @param {import('./bentomux-plugin-sdk').PluginContext} ctx */
export function activate(ctx) {
  /* Agent run states as the app reports them, keyed by pane id. Held inside
     activate rather than at module scope: a reload re-imports the module
     under a fresh URL, so a module-level map would be replaced while the old
     instance's listeners still wrote to it. */
  const runStates = {};

  let enabled = true;
  /* Whether the workspace/branch line is shared. Default on, so an install
     that predates this switch keeps showing exactly what it showed before. */
  let showWorktree = true;
  let startTime = Date.now();
  let lastSentAt = 0;
  let lastPayload = '';
  let timer = null;

  const readSettings = async () => {
    const stored = await ctx.storage.get(SETTINGS_KEY);
    return {
      enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : true,
      showWorktree:
        typeof stored?.showWorktree === 'boolean' ? stored.showWorktree : true,
    };
  };

  /* Both flags live in one stored object, so a write must carry both or the
     one it omits is lost. */
  const writeSettings = () => ctx.storage.set(SETTINGS_KEY, { enabled, showWorktree });

  /** The workspace the presence describes, or null when none is open. */
  async function activeWorkspace() {
    const state = await ctx.app.getState().catch(() => null);
    return state?.workspaces?.find(w => w.id === state.activeWorkspaceId) ?? null;
  }

  /* ---------------- sending ---------------- */

  async function send() {
    lastSentAt = Date.now();
    if (!enabled) return;

    /* The workspace and its git status only feed the state line, so when that
       line is hidden there is nothing to read them for. */
    const workspace = showWorktree ? await activeWorkspace() : null;
    const git =
      showWorktree && workspace
        ? await ctx.app.gitStatus(workspace.id).catch(() => null)
        : null;

    const agents = agentLine(runStates);
    const activity = {
      /* Discord writes the application's own name on the first line, so
         `details` is the first line actually under our control — and an
         agent status is the one thing worth reading without expanding the
         profile. */
      details: agents ?? 'Bentomux',
      /* one line under that: where you are, and how dirty it is. When an
         agent is running its status is already on the line above, so the
         change count is the only thing left to say. Left off entirely when
         the user has turned off sharing the worktree — the presence then
         carries no workspace or branch name. */
      state: showWorktree
        ? [
            [workspace?.name ?? 'no workspace', git?.branch].filter(Boolean).join(' · '),
            agents ? (changeLine(git) ?? null) : null,
          ].filter(Boolean).join(' — ')
        : undefined,
      largeImage: LOGO_ASSET,
      /* Discord renders `start_timestamp` next to the small icon, and that
         icon only appears when `small_image` is set to something distinct
         from the large one. No second asset is uploaded, so the timer is
         sent and simply has nowhere to draw — adding one means uploading a
         second asset in the portal and naming it here. */
      startTimestamp: startTime,
    };

    const payload = JSON.stringify(activity);
    /* An unchanged activity is discarded by Discord anyway, and sending it
       spends the update rate limit, so a no-change tick never hits the wire. */
    if (payload === lastPayload) return;
    try {
      await ctx.app.invoke('discord_set_activity', { appId: APP_ID, activity });
      lastPayload = payload;
    } catch (e) {
      /* Discord restarted, or its endpoint moved. Forget the cached payload
         so the next tick retries instead of skipping as a no-op. */
      lastPayload = '';
      ctx.log('discord_set_activity failed:', String(e));
    }
  }

  /* A branch switch and an agent state change land within milliseconds of
     each other; sending both would spend two of the rate limit's slots. */
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSentAt)));
  }

  async function clear() {
    try {
      await ctx.app.invoke('discord_clear_activity', { appId: APP_ID });
    } catch {
      /* Discord is not running, so there was nothing on screen to clear */
    }
  }

  async function applyEnabled() {
    if (enabled) {
      startTime = Date.now();
      lastPayload = '';
      await send();
      return;
    }
    await clear();
  }

  /* ---------------- settings ---------------- */

  /* The application id and the logo are baked in, so the only things a user
     can set are whether to share at all, and whether the workspace/branch
     line goes out with it. */
  function settingsForm(repaint) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:520px';

    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;opacity:.8';

    const paintStatus = async () => {
      /* discord_status only stats the endpoint paths, so it is safe on every
         repaint and says "start Discord" rather than "the plugin broke". */
      const running = await ctx.app.invoke('discord_status').catch(() => false);
      status.textContent = !running
        ? 'Discord desktop app not detected — start it, then press Refresh.'
        : enabled
          ? `Sharing as ${APP_NAME}.`
          : 'Not sharing.';
    };

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn';
    const paintToggle = () => {
      toggle.textContent = enabled ? 'Stop sharing presence' : 'Start sharing presence';
    };
    paintToggle();
    toggle.addEventListener('click', () => void (async () => {
      enabled = !enabled;
      await writeSettings();
      paintToggle();
      paintWorktree();
      await applyEnabled();
      await paintStatus();
      repaint?.();
    })());

    /* A second switch for the line that names where you are. It is separate
       from sharing so someone who wants the agent status on their profile but
       not the name of the project they are in can have exactly that. */
    const worktree = document.createElement('button');
    worktree.type = 'button';
    worktree.className = 'btn';
    const paintWorktree = () => {
      worktree.textContent = showWorktree
        ? 'Hide workspace & branch'
        : 'Show workspace & branch';
      worktree.disabled = !enabled;
    };
    paintWorktree();
    worktree.addEventListener('click', () => void (async () => {
      showWorktree = !showWorktree;
      await writeSettings();
      paintWorktree();
      /* Resend immediately so the change lands now, not on the next heartbeat. */
      lastSentAt = 0;
      lastPayload = '';
      await send();
      await paintStatus();
      repaint?.();
    })());

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn';
    refresh.textContent = 'Refresh now';
    refresh.addEventListener('click', () => void (async () => {
      lastSentAt = 0;
      lastPayload = '';
      await send();
      await paintStatus();
    })());

    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:.7;font-size:12px;line-height:1.5';
    hint.textContent =
      'Rich Presence comes from the Discord desktop app. Discord in a browser ' +
      'has no way to receive it, so nothing appears there.';

    wrap.append(status, hint, toggle, worktree, refresh);
    void paintStatus();
    return wrap;
  }

  /* ---------------- wiring ---------------- */

  ctx.app.onBranch(() => schedule());
  ctx.app.onRuntimeStatus(statuses => {
    for (const [paneId, status] of Object.entries(statuses ?? {})) {
      runStates[paneId] = status;
    }
    for (const paneId of Object.keys(runStates)) {
      if (!(paneId in (statuses ?? {}))) delete runStates[paneId];
    }
    schedule();
  });
  ctx.events.on('workspace:changed', () => schedule());
  ctx.events.on('tab:activated', () => schedule());

  /* A service starts at boot, once the window is interactive, which is what a
     presence needs: it has no click to wait for. It sends once, then
     heartbeats so a presence Discord silently dropped comes back. */
  ctx.ui.service(`${ID}.service`, async signal => {
    ({ enabled, showWorktree } = await readSettings());
    if (enabled) await send();

    while (!signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 60_000));
      if (signal.aborted) break;
      schedule();
    }

    /* Discord removes a presence when its socket closes, and dropping the
       connection is what makes that happen — so a disabled plugin never
       leaves a presence pinned to a project nobody is in. */
    if (timer !== null) clearTimeout(timer);
    await clear();
  });

  ctx.ui.command(`${ID}.toggle`, async () => {
    ({ enabled, showWorktree } = await readSettings());
    enabled = !enabled;
    await writeSettings();
    await applyEnabled();
    ctx.log(enabled ? 'presence on' : 'presence off');
  });

  ctx.ui.command(`${ID}.refresh`, async () => {
    ({ enabled, showWorktree } = await readSettings());
    lastSentAt = 0;
    lastPayload = '';
    await send();
    ctx.log('presence refreshed');
  });

  ctx.ui.settingsSection(`${ID}.settings`, paint => {
    const host = document.createElement('div');
    void readSettings().then(stored => {
      enabled = stored.enabled;
      showWorktree = stored.showWorktree;
      host.append(settingsForm(paint));
    });
    return host;
  });
}

export function deactivate() {}