# groundcontrol — full setup runbook

Everything needed to take a Mac from zero to a 24/7 agent server. Steps are
in dependency order; each block is copy-pasteable. Placeholders like
`/Volumes/YourDrive` and `your-machine.your-tailnet.ts.net` are yours to
substitute.

## 1. Homebrew tooling

```sh
brew install node gh colima docker
gh auth login          # host-side GitHub auth — used to push branches + open PRs
colima start           # Docker runtime (no Docker Desktop needed)
brew services start colima   # restart colima automatically at boot
```

Verify: `node --version` (need >= 20.12), `gh auth status`, `docker ps`.

## 1b. This repo

```sh
git clone https://github.com/sinameraji/groundcontrol && cd groundcontrol
npm install
cp .env.example .env                                  # fill in as the next steps produce values
cp config/agents.example.json config/agents.json      # edit to taste
```

Every step below drops a value into `.env` — keep it open.

## 2. hotcell

```sh
npm i -g hotcell
hotcell start                # starts the daemon on 127.0.0.1:4750
hotcell keys add openrouter  # paste your OpenRouter API key
```

The key is stored in the macOS keychain and used only by hotcell's egress
gateway — sandboxes receive a short-lived `hc-…` token, never the real key.

Optional hardening: set an API key on the daemon and put the same value in
`HOTCELL_API_KEY` in `.env`, so only authenticated local clients can create
sandboxes. See `hotcell start --help`.

## 3. Discord applications (one per agent)

Each agent is its own bot identity. For **each** agent in
`config/agents.json` (the example ships `scout` and `codey`):

1. Go to <https://discord.com/developers/applications> → **New Application**,
   name it after the agent.
2. **Bot** tab → under *Privileged Gateway Intents* enable
   **MESSAGE CONTENT INTENT** (required to read `@mention` text).
3. **Bot** tab → **Reset Token** → copy it into `.env` as the variable named
   by that agent's `tokenEnv` (e.g. `DISCORD_TOKEN_CODEY=...`).
4. **OAuth2 → URL Generator**: scopes **bot** + **applications.commands**;
   bot permissions **View Channels**, **Send Messages**,
   **Create Public Threads**, **Send Messages in Threads**,
   **Read Message History**, **Embed Links**, **Attach Files**.
   Open the generated URL and invite the bot to your private server.

Then, once:

5. In the Discord client: **Settings → Advanced → Developer Mode** on.
   Right-click yourself → **Copy User ID** → `OWNER_DISCORD_USER_ID` in
   `.env`. Only this user can command the agents.
6. Right-click your server icon → **Copy Server ID** → `DISCORD_GUILD_ID`
   in `.env` (guild-scoped slash commands register instantly).
7. Register the slash commands:

```sh
npm run register
```

## 4. Tailscale (private artifact links)

1. Install Tailscale (`brew install --cask tailscale` or the App Store app),
   then `tailscale up` and make sure **MagicDNS** is enabled in the admin
   console.
2. Front the built-in file server (loopback-only on port 4760) with a
   tailnet-private HTTPS URL:

```sh
tailscale serve --bg http://127.0.0.1:4760
```

3. It prints an `https://your-machine.your-tailnet.ts.net/` URL — put that
   in `.env` as `PUBLIC_BASE_URL` (no trailing slash).

By design these links resolve only for devices on your tailnet. Do **not**
use `tailscale funnel` — that would make artifacts public.

## 5. External drive for mission artifacts

```sh
mkdir -p /Volumes/YourDrive/groundcontrol/missions
```

Set in `.env`:

```
ARTIFACTS_ROOT=/Volumes/YourDrive/groundcontrol/missions
```

APFS is recommended for the drive (fast, snapshot-friendly). Optionally
exclude the folder from Spotlight indexing (System Settings → Siri &
Spotlight → Spotlight Privacy) so mission dumps don't churn the indexer.

## 6. Keep-awake and battery

```sh
sudo pmset -c sleep 0       # never system-sleep on AC power
sudo pmset -c disksleep 0   # keep the external drive spinning
```

- `displaysleep` can stay on — the screen sleeping is fine.
- Keep the **lid open** on a hard, ventilated surface.
- Enable **Optimized Battery Charging** (System Settings → Battery), or use
  an 80% charge limiter such as AlDente, since the machine lives on AC.

Reassurance for the worried: Apple Silicon throttles itself long before heat
is a problem, the LLM runs on OpenRouter's servers (not this Mac), and
hotcell's admission control refuses new sandboxes rather than oversubscribe
memory. This is a light workload with occasional Docker bursts.

## 7. launchd (run at login, restart on crash)

```sh
npm run build
ops/install.sh
```

The installer renders the three plists in `ops/` with your real paths,
copies them to `~/Library/LaunchAgents/`, and (re)starts them:

| Label | What | Schedule |
|---|---|---|
| `com.groundcontrol.hotcelld` | hotcell daemon | always on, restarts on crash |
| `com.groundcontrol.orchestrator` | the bots + engine + file server | always on, restarts on crash |
| `com.groundcontrol.janitor` | docker prune + artifact pruning | Sundays 04:30 |

Logs land in `~/Library/Logs/groundcontrol/`:

```sh
tail -f ~/Library/Logs/groundcontrol/orchestrator.log
```

Cheatsheet (labels as in the table above):

```sh
# restart a service now
launchctl kickstart -k gui/$(id -u)/com.groundcontrol.orchestrator
# stop + unload a service
launchctl bootout gui/$(id -u)/com.groundcontrol.orchestrator
# load it again
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.groundcontrol.orchestrator.plist
# inspect state
launchctl print gui/$(id -u)/com.groundcontrol.orchestrator
```

Updating to a new version:

```sh
cd /path/to/groundcontrol
git pull
npm install
npm run build
launchctl kickstart -k gui/$(id -u)/com.groundcontrol.orchestrator
```

(Re-running `ops/install.sh` is also safe — it is idempotent and re-renders
the plists, which you need if the repo or node paths changed.)
