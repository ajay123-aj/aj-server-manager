#!/usr/bin/env node

const minimist = require("minimist");
const { runAgent } = require("./agent-runner");

const argv = minimist(process.argv.slice(2), {
  string: ["server", "s", "key", "k", "config"],
  alias: { s: "server", k: "key", c: "config" },
});

const serverUrl =
  argv.server ||
  argv.s ||
  process.env.AJ_SERVER_URL ||
  process.env.AJ_SERVER;
const pairingKey = argv.key || argv.k || "";

if (!serverUrl) {
  console.error(`
Usage:
  aj-agent --server http://YOUR_DASHBOARD_IP:3847 --key YOUR_PAIRING_KEY

Environment (optional):
  AJ_SERVER_URL   Base URL of the dashboard
  AJ_PAIRING_KEY  Pairing key (same as --key)

After first successful connect, credentials are saved to:
  ~/.aj-server-manager-agent.json (${require("path").join(
    require("os").homedir(),
    ".aj-server-manager-agent.json"
  )})
Next runs only need --server (same URL) or set AJ_SERVER_URL.
`);
  process.exit(1);
}

runAgent({
  serverUrl,
  pairingKey: pairingKey || undefined,
  configFile: argv.config || argv.c || undefined,
});
