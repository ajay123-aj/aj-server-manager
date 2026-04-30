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
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["install"], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    console.error(
      "[agent] Auto install failed. Please install Node/npm and run: npm install"
    );
    process.exit(result.status || 1);
  }
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
});
