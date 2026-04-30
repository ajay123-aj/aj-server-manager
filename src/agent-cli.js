#!/usr/bin/env node

const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");

function parseArgs(raw) {
  const out = { _: [] };
  for (let i = 0; i < raw.length; i += 1) {
    const a = raw[i];
    if (a === "--server" || a === "-s") out.server = raw[++i];
    else if (a === "--key" || a === "-k") out.key = raw[++i];
    else if (a === "--config" || a === "-c") out.config = raw[++i];
    else if (a === "--pair-once") out.pairOnce = true;
    else out._.push(a);
  }
  return out;
}

function ensureDependenciesInstalled() {
  try {
    require.resolve("socket.io-client");
    require.resolve("systeminformation");
    return;
  } catch (_) {
    // Fall through and auto-install.
  }

  console.log("[agent] Missing dependencies detected. Running npm install...");
  const cwd = path.join(__dirname, "..");
  const attempts =
    process.platform === "win32"
      ? [
          { cmd: "npm.cmd", args: ["install"] },
          { cmd: "npm.exe", args: ["install"] },
          // Works even when npm is available only via shell shim.
          { cmd: "cmd.exe", args: ["/d", "/s", "/c", "npm install"] },
          { cmd: "powershell.exe", args: ["-NoProfile", "-Command", "npm install"] },
        ]
      : [{ cmd: "npm", args: ["install"] }];

  for (const a of attempts) {
    const result = spawnSync(a.cmd, a.args, {
      stdio: "inherit",
      cwd,
      env: process.env,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return;
  }

  console.error(
    "[agent] Auto install failed. Install Node.js LTS (includes npm), then run: npm install"
  );
  process.exit(1);
}

const argv = parseArgs(process.argv.slice(2));

const serverUrl =
  argv.server ||
  process.env.AJ_SERVER_URL ||
  process.env.AJ_SERVER;
const pairingKey = argv.key || "";

if (!serverUrl) {
  console.error(`
Usage:
  aj-agent --server http://YOUR_DASHBOARD_IP:3847 --key YOUR_PAIRING_KEY
  aj-agent --server URL --key KEY --pair-once   # enroll then exit 0 (for install scripts)

Environment (optional):
  AJ_SERVER_URL   Base URL of the dashboard
  AJ_PAIRING_KEY  Pairing key (same as --key)

After first successful connect, credentials are saved to:
  ~/.aj-server-manager-agent.json (${path.join(
    os.homedir(),
    ".aj-server-manager-agent.json"
  )})
Next runs only need --server (same URL) or set AJ_SERVER_URL.
`);
  process.exit(1);
}

ensureDependenciesInstalled();
const { runAgent } = require("./agent-runner");

runAgent({
  serverUrl,
  pairingKey: pairingKey || undefined,
  configFile: argv.config || undefined,
  exitAfterReady: Boolean(argv.pairOnce),
}).catch((e) => {
  console.error("[agent] fatal:", e && e.stack ? e.stack : e);
  process.exit(1);
});
