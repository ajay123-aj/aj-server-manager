const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const si = require("systeminformation");

const EXEC_TIMEOUT_MS = 120000;
const shells = new Map();

function configPath(custom) {
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".aj-server-manager-agent.json");
}

function loadConfig(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function listServicesScript() {
  if (process.platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Service | Select-Object Name,Status,StartType | ConvertTo-Json -Compress -Depth 3",
      ],
    };
  }
  return {
    cmd: "sh",
    args: [
      "-c",
      "(command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null) || (echo 'systemctl not available — install or use Exec tab instead.'; exit 0)",
    ],
  };
}

function runExec(command, cwd) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        code: null,
        stdout: out,
        stderr: err + "\n[timeout]",
        timedOut: true,
      });
    }, EXEC_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut: false });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: err + `\n${e.message}`, timedOut: false });
    });
  });
}

async function gatherMetrics() {
  const [staticData, currentLoad, mem, fsSizes, uptime] = await Promise.all([
    si.getStaticData(),
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.time(),
  ]);
  return {
    staticData: {
      system: staticData.system,
      osInfo: staticData.osInfo,
      cpu: staticData.cpu,
    },
    currentLoad,
    mem,
    fsSizes: fsSizes.slice(0, 8),
    uptime,
    hostname: os.hostname(),
  };
}

function startShell(socket, sessionId) {
  if (shells.has(sessionId)) return;
  const isWin = process.platform === "win32";
  const child = isWin
    ? spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
        windowsHide: true,
        env: process.env,
      })
    : spawn("/bin/bash", ["-l"], {
        env: process.env,
      });
  shells.set(sessionId, { child, socket });
  child.stdout.on("data", (d) => {
    socket.emit("agent:shell_out", { sessionId, kind: "stdout", data: d.toString() });
  });
  child.stderr.on("data", (d) => {
    socket.emit("agent:shell_out", { sessionId, kind: "stderr", data: d.toString() });
  });
  child.on("close", (code) => {
    shells.delete(sessionId);
    socket.emit("agent:shell_out", { sessionId, kind: "exit", code });
  });
  child.stdin?.write(
    isWin
      ? "Write-Host 'Remote shell ready. Type commands and press Enter.'\r\n"
      : "echo Remote shell ready.\n"
  );
}

function stopShell(sessionId) {
  const rec = shells.get(sessionId);
  if (rec) {
    try {
      rec.child.kill("SIGTERM");
    } catch (_) {}
    shells.delete(sessionId);
  }
}

async function handleCommand(socket, msg) {
  const { commandId, type, payload } = msg || {};
  const reply = (result) =>
    socket.emit("agent:command_result", {
      commandId,
      agentId: socket.agentIdStored,
      type,
      ok: result.ok !== false,
      ...result,
    });

  try {
    if (type === "metrics") {
      const data = await gatherMetrics();
      reply({ data });
      return;
    }
    if (type === "list_services") {
      const scr = listServicesScript();
      const proc = spawn(scr.cmd, scr.args, { windowsHide: true });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => {
        out += d.toString();
      });
      proc.stderr.on("data", (d) => {
        err += d.toString();
      });
      proc.on("close", (code) => {
        reply({
          stdout: out,
          stderr: err,
          exitCode: code,
        });
      });
      proc.on("error", (e) => reply({ ok: false, error: e.message }));
      return;
    }
    if (type === "exec") {
      const cmd = payload?.command;
      if (!cmd || typeof cmd !== "string")
        return reply({ ok: false, error: "payload.command required" });
      const r = await runExec(cmd, payload.cwd);
      reply({
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.code,
        timedOut: r.timedOut,
      });
      return;
    }
    if (type === "shell_start") {
      const sessionId = payload?.sessionId || "default";
      startShell(socket, sessionId);
      reply({ data: { sessionId } });
      return;
    }
    if (type === "shell_input") {
      const sessionId = payload?.sessionId || "default";
      const input = payload?.input;
      const rec = shells.get(sessionId);
      if (!rec?.child?.stdin) return reply({ ok: false, error: "No shell session" });
      rec.child.stdin.write(input.endsWith("\n") ? input : input + "\n");
      reply({ ok: true });
      return;
    }
    if (type === "shell_stop") {
      const sessionId = payload?.sessionId || "default";
      stopShell(sessionId);
      reply({ ok: true });
      return;
    }
    reply({ ok: false, error: `Unknown command type: ${type}` });
  } catch (e) {
    reply({ ok: false, error: e.message || String(e) });
  }
}

function runAgent({ serverUrl, pairingKey, reconnect, configFile }) {
  const cfgPath = configPath(configFile);
  let pair = pairingKey;
  let reconnectId = reconnect?.agentId;
  let reconnectSecret = reconnect?.secret;

  if ((!pair || pair === "env") && process.env.AJ_PAIRING_KEY) {
    pair = process.env.AJ_PAIRING_KEY;
  }

  const existing = loadConfig(cfgPath);
  if (existing?.serverUrl && existing?.agentId && existing?.secret && !pair) {
    try {
      const u = new URL(serverUrl);
      const su = new URL(existing.serverUrl);
      if (u.origin === su.origin) {
        reconnectId = existing.agentId;
        reconnectSecret = existing.secret;
      }
    } catch (_) {}
  }

  if (!pair && !(reconnectId && reconnectSecret)) {
    console.error(
      "Pairing required: missing key. Run with --key <pairing-key> once, or delete config to re-enroll."
    );
    process.exit(1);
  }

  const authBase = {
    role: "agent",
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
    platform: os.platform(),
    arch: os.arch(),
    version: process.version,
  };

  const auth =
    reconnectId && reconnectSecret && !pair
      ? { ...authBase, reconnectAgentId: reconnectId, reconnectSecret }
      : { ...authBase, pairingKey: pair };

  const normalized = serverUrl.replace(/\/$/, "");
  const socket = io(normalized, {
    path: "/socket.io/",
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    auth,
  });

  socket.on("connect", () => {
    console.log("[agent] connected");
  });

  socket.on("agent:registered", (body) => {
    const { agentId, secret } = body || {};
    socket.agentIdStored = agentId;
    if (!agentId || !secret) return;
    console.log("[agent] paired; switching to persisted credentials:", agentId);
    saveConfig(cfgPath, { serverUrl: normalized, agentId, secret });
    socket.auth = {
      role: "agent",
      reconnectAgentId: agentId,
      reconnectSecret: secret,
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      platform: os.platform(),
      arch: os.arch(),
      version: process.version,
    };
    socket.disconnect().connect();
  });

  socket.on("agent:ready", (body) => {
    const { agentId } = body || {};
    socket.agentIdStored = agentId;
    console.log("[agent] online as", agentId);
  });

  socket.on("agent:error", (e) => {
    console.error("[agent] error:", e?.error || e);
  });

  socket.on("agent:command", (msg) => {
    handleCommand(socket, msg);
  });

  socket.on("disconnect", (reason) => {
    console.log("[agent] disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.error("[agent] connect_error:", err.message);
  });
}

module.exports = { runAgent, configPath };
