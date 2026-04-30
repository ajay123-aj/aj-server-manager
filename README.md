# AJ Server Manager

A minimal **local / LAN** toolkit: one **Node dashboard** runs on your main PC or server, lightweight **agents** run on each computer you manage. Pair machines with keys, then from the dashboard you can inspect metrics, list services, run commands, or open an interactive shell on each paired PC.

**Security:** Intended for trusted networks only. Dashboard and pairing keys must be guarded like admin credentials; remote execution is powerful — set a strong `ADMIN_TOKEN` before exposing the server beyond your LAN.

---

## Prerequisites

- [Node.js 18+](https://nodejs.org/) on **every** PC (dashboard and agents).

---

## 1 — Run the dashboard (control PC)

Clone or copy this folder to your control machine, then:

```bash
cd aj-server-manager
copy .env.example .env   # Windows
# Edit .env: set ADMIN_TOKEN (strong random string) and optional PORT

npm install
npm start
```

Open a browser at `http://localhost:3847` (replace host/port if you changed `PORT`). Enter the **Admin token** matching `ADMIN_TOKEN` in `.env` (leave blank only for quick lab use with no HTTP auth).

Generate a pairing key (**Multi-use** is recommended if you enroll many PCs). Copy the suggested install command snippet from the dashboard.

---

## 2 — Install agent on each computer (managed PCs)

**One-time pairing:** each managed PC runs the agent once with your server URL and the pairing key. After success, credentials are saved to `%USERPROFILE%\.aj-server-manager-agent.json` (Windows) / `~/.aj-server-manager-agent.json` (Linux/macOS).

From the repo folder:

```powershell
# Windows PowerShell — replace URL and KEY
npm install
$env:AJ_SERVER="http://192.168.1.10:3847"
node .\src\agent-cli.js --server $env:AJ_SERVER --key YOUR_PAIRING_KEY
```

Later restarts reconnect automatically:

```powershell
node .\src\agent-cli.js --server "http://192.168.1.10:3847"
```

**Global install from this repo (optional):**

```bash
npm install -g .
aj-agent --server http://YOUR_HOST:3847 --key YOUR_PAIRING_KEY
```

---

## Firewall

Allow inbound TCP on the dashboard **PORT** from your LAN so agents can connect.

---

## What the dashboard supports

| Action | Behavior |
|--------|----------|
| **Manage keys** | One-time keys or multi-use enrollment keys |
| **Monitor** | CPU load, RAM, disks, uptime (via [`systeminformation`](https://systeminformation.io/)) |
| **Services** | Windows: PowerShell service list JSON; Linux: `systemctl` text when available |
| **Run command** | Executes one shell line on the agent (timeouts apply) |
| **Shell** | Persistent PowerShell/bash session streamed to the browser |

Pairing keys and agent identities are persisted under `data/store.json` next to the server.

---

## Project layout

- `src/server.js` — HTTP API + Socket.io hub for dashboard and agents  
- `src/agent-cli.js` / `src/agent-runner.js` — CLI agent (`aj-agent`)  
- `public/` — dashboard UI  

---

## License

MIT
