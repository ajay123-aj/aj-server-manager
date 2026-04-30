const os = require("os");
const fs = require("fs");
const {
  WIN_SERVICE_NAME,
  WIN_TASK_NAME,
  WIN_SERVICE_DISPLAY_NAME,
  LINUX_SYSTEMD_UNIT,
} = require("./service-names");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const si = require("systeminformation");

const EXEC_TIMEOUT_MS = 120000;
const shells = new Map();

function appendBootLog(line) {
  try {
    const p = path.join(os.homedir(), ".aj-server-manager-agent-boot.log");
    fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

function isLocalhostHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function withTimeout(ms, promiseFactory) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promiseFactory()
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(t);
        resolve(null);
      });
  });
}

function httpGetJson(urlString, timeoutMs = 900) {
  return withTimeout(timeoutMs, () => {
    return new Promise((resolve, reject) => {
      const u = new URL(urlString);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(
        urlString,
        { timeout: timeoutMs, headers: { "User-Agent": "aj-agent-discovery" } },
        (res) => {
          let buf = "";
          res.on("data", (d) => (buf += d.toString()));
          res.on("end", () => {
            if (res.statusCode !== 200) return reject(new Error("non-200"));
            try {
              resolve(JSON.parse(buf));
            } catch {
              reject(new Error("bad-json"));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", reject);
    });
  });
}

async function discoverDashboardUrlFromLocalhost(serverUrl) {
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return serverUrl;
  }
  if (!isLocalhostHost(parsed.hostname)) return serverUrl;

  const nets = os.networkInterfaces();
  const prefixes = new Set();
  for (const n of Object.values(nets)) {
    for (const row of n || []) {
      if (
        row &&
        row.family === "IPv4" &&
        !row.internal &&
        typeof row.address === "string"
      ) {
        const parts = row.address.split(".");
        if (parts.length === 4) prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }
  if (prefixes.size === 0) return serverUrl;

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const scheme = parsed.protocol || "http:";
  const candidates = [];
  for (const p of prefixes) {
    for (let i = 1; i <= 254; i += 1) {
      candidates.push(`${scheme}//${p}.${i}:${port}`);
    }
  }

  // Scan in bounded batches to avoid overwhelming low-power devices.
  const batchSize = 36;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const checks = batch.map(async (base) => {
      const r = await httpGetJson(`${base}/api/health`, 700);
      if (r && r.ok === true && r.name === "aj-server-manager") return base;
      return null;
    });
    const results = await Promise.all(checks);
    const found = results.find(Boolean);
    if (found) return found;
  }

  return serverUrl;
}

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

async function handleServiceControl(type, payload, socket) {
  const serviceName = payload?.serviceName || WIN_SERVICE_NAME;
  const taskName = payload?.taskName || WIN_TASK_NAME;
  const serverUrl = payload?.serverUrl || socket.serverUrlUsed;
  const scriptPath = path.join(__dirname, "agent-cli.js");
  const nodePath = process.execPath;

  if (!serverUrl && type === "service_install") {
    return { ok: false, error: "serverUrl is required for service_install" };
  }

  if (process.platform === "win32") {
    const esc = (s) => String(s).replace(/'/g, "''");
    const binPath = `"${nodePath}" "${scriptPath}" --server "${serverUrl || socket.serverUrlUsed}"`;

    if (type === "service_install") {
      const ps = [
        `$name='${esc(serviceName)}'`,
        `$bin='${esc(binPath)}'`,
        `if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) { New-Service -Name $name -BinaryPathName $bin -DisplayName '${esc(WIN_SERVICE_DISPLAY_NAME)}' -StartupType Automatic }`,
        `Start-Service -Name $name -ErrorAction SilentlyContinue`,
        `Get-Service -Name $name | Select-Object Name,Status,StartType | ConvertTo-Json -Compress`,
      ].join("; ");
      const r = await runExec(`powershell -NoProfile -Command "${ps}"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "agent_connect") {
      const ps = [
        `$name='${esc(serviceName)}'`,
        `$task='${esc(taskName)}'`,
        `$node='${esc(nodePath)}'`,
        `$script='${esc(scriptPath)}'`,
        `$srv='${esc(serverUrl || socket.serverUrlUsed)}'`,
        `if (Get-Service -Name $name -ErrorAction SilentlyContinue) { Start-Service -Name $name -ErrorAction SilentlyContinue; Get-Service -Name $name | Select-Object Name,Status,StartType | ConvertTo-Json -Compress; exit }`,
        `$args='\"' + $script + '\" --server \"' + $srv + '\"'`,
        `schtasks /Create /TN $task /SC ONLOGON /TR ('\"' + $node + '\" ' + $args) /F /RL LIMITED | Out-Null`,
        `Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList $args`,
        `Write-Output ('started user task ' + $task)`,
      ].join("; ");
      const r = await runExec(`powershell -NoProfile -Command "${ps}"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "agent_disconnect") {
      const ps = [
        `$name='${esc(serviceName)}'`,
        `$task='${esc(taskName)}'`,
        `if (Get-Service -Name $name -ErrorAction SilentlyContinue) { Stop-Service -Name $name -ErrorAction SilentlyContinue }`,
        `schtasks /End /TN $task 2>$null | Out-Null`,
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'agent-cli\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        `Write-Output 'agent disconnected'`,
      ].join("; ");
      const r = await runExec(`powershell -NoProfile -Command "${ps}"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_start") {
      const r = await runExec(`powershell -NoProfile -Command "Start-Service -Name '${serviceName}' -ErrorAction Stop; Get-Service -Name '${serviceName}' | Select-Object Name,Status | ConvertTo-Json -Compress"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_stop") {
      const r = await runExec(`powershell -NoProfile -Command "Stop-Service -Name '${serviceName}' -ErrorAction Stop; Get-Service -Name '${serviceName}' | Select-Object Name,Status | ConvertTo-Json -Compress"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_remove") {
      const r = await runExec(`powershell -NoProfile -Command "if (Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue) { Stop-Service -Name '${serviceName}' -ErrorAction SilentlyContinue; sc.exe delete '${serviceName}' | Out-Null; Write-Output 'removed' } else { Write-Output 'not-found' }"`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
  } else {
    const unit = LINUX_SYSTEMD_UNIT;
    const unitContent = `[Unit]
Description=AJ Server Manager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} --server ${serverUrl}
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
`;
    if (type === "service_install") {
      const cmd = `printf '%s' "${unitContent.replace(/"/g, '\\"')}" | sudo tee /etc/systemd/system/${unit} >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable --now ${unit} && sudo systemctl status ${unit} --no-pager --lines=10`;
      const r = await runExec(cmd);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_start") {
      const r = await runExec(`sudo systemctl start ${unit} && sudo systemctl status ${unit} --no-pager --lines=10`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_stop") {
      // systemctl status returns 3 for inactive units; after stop that is normal, not an error.
      const r = await runExec(
        `sudo systemctl stop ${unit}; ret=$?; sudo systemctl status ${unit} --no-pager --lines=10 || true; exit $ret`
      );
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "service_remove") {
      const r = await runExec(`sudo systemctl disable --now ${unit} 2>/dev/null; sudo rm -f /etc/systemd/system/${unit}; sudo systemctl daemon-reload; echo removed`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "agent_connect") {
      const r = await runExec(`sudo systemctl start ${unit} && sudo systemctl status ${unit} --no-pager --lines=5`);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
    if (type === "agent_disconnect") {
      const r = await runExec(
        `sudo systemctl stop ${unit}; ret=$?; sudo systemctl status ${unit} --no-pager --lines=5 || true; exit $ret`
      );
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    }
  }

  return { ok: false, error: `Unsupported service control type: ${type}` };
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

async function gatherTelemetryLite() {
  const [currentLoad, mem, fsSizes, uptime] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.time(),
  ]);
  return {
    currentLoad: { currentLoad: Number(currentLoad?.currentLoad || 0) },
    mem: {
      total: Number(mem?.total || 0),
      used: Number(mem?.used || 0),
      active: Number(mem?.active || mem?.used || 0),
    },
    fsSizes: Array.isArray(fsSizes) ? fsSizes.slice(0, 1) : [],
    uptime,
    hostname: os.hostname(),
    lite: true,
    ts: Date.now(),
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
    if (
      type === "service_install" ||
      type === "service_start" ||
      type === "service_stop" ||
      type === "service_remove" ||
      type === "agent_connect" ||
      type === "agent_disconnect"
    ) {
      const res = await handleServiceControl(type, payload || {}, socket);
      reply(res);
      return;
    }
    reply({ ok: false, error: `Unknown command type: ${type}` });
  } catch (e) {
    reply({ ok: false, error: e.message || String(e) });
  }
}

async function runAgent({
  serverUrl,
  pairingKey,
  reconnect,
  configFile,
  exitAfterReady = false,
}) {
  const cfgPath = configPath(configFile);
  let pair = pairingKey;
  let reconnectId = reconnect?.agentId;
  let reconnectSecret = reconnect?.secret;

  if ((!pair || pair === "env") && process.env.AJ_PAIRING_KEY) {
    pair = process.env.AJ_PAIRING_KEY;
  }

  const pairingRequested = !!(pair && String(pair).trim());

  const existing = loadConfig(cfgPath);
  if (
    existing?.serverUrl &&
    existing?.agentId &&
    existing?.secret &&
    !pairingRequested
  ) {
    try {
      const u = new URL(serverUrl);
      const su = new URL(existing.serverUrl);
      if (u.origin === su.origin) {
        reconnectId = existing.agentId;
        reconnectSecret = existing.secret;
        pair = undefined;
      }
    } catch (_) {}
  }

  if (!pair && !(reconnectId && reconnectSecret)) {
    appendBootLog(
      "exit: pairing required — no saved credentials and no --key; run installer with a pairing key."
    );
    console.error(
      "Pairing required: missing key. Run with --key <pairing-key> once, or delete config to re-enroll."
    );
    process.exit(1);
  }

  appendBootLog(
    `connecting pairingRequested=${pairingRequested} reconnect=${Boolean(
      reconnectId && reconnectSecret && !pair
    )} url=${serverUrl} cfg=${cfgPath}`
  );

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

  const discovered = await discoverDashboardUrlFromLocalhost(serverUrl);
  const normalized = discovered.replace(/\/$/, "");
  if (discovered !== serverUrl) {
    console.log(`[agent] auto-detected dashboard URL: ${normalized}`);
  }
  const socket = io(normalized, {
    path: "/socket.io/",
    transports: ["websocket", "polling"],
    reconnection: exitAfterReady ? false : true,
    reconnectionAttempts: exitAfterReady ? 0 : Infinity,
    reconnectionDelay: 3000,
    auth,
  });
  socket.serverUrlUsed = normalized;
  if (reconnectId && reconnectSecret && !pair) {
    socket.agentIdStored = reconnectId;
  }

  /** One-shot pairing / verify: exit after first stable session so install scripts show success in-console. */
  let enrollWatchTimer = null;
  let enrollTerminal = false;
  function clearEnrollWatch() {
    if (enrollWatchTimer) {
      clearTimeout(enrollWatchTimer);
      enrollWatchTimer = null;
    }
  }
  function finishEnrollOk() {
    if (!exitAfterReady || enrollTerminal) return;
    enrollTerminal = true;
    clearEnrollWatch();
    appendBootLog("pair-once: success, exiting");
    console.log("[agent] Enrollment OK — this window can close. Long-running agent will use saved credentials.");
    try {
      socket.disconnect();
    } catch (_) {}
    process.exit(0);
  }
  function finishEnrollFail() {
    if (!exitAfterReady || enrollTerminal) return;
    enrollTerminal = true;
    clearEnrollWatch();
    appendBootLog("pair-once: failed");
    try {
      socket.disconnect();
    } catch (_) {}
    process.exit(1);
  }
  if (exitAfterReady) {
    enrollWatchTimer = setTimeout(() => {
      if (enrollTerminal) return;
      console.error(
        "[agent] --pair-once timed out (120s). Check dashboard URL, TCP 3847 firewall on dashboard PC, and pairing key."
      );
      appendBootLog("pair-once: timeout");
      enrollTerminal = true;
      try {
        socket.disconnect();
      } catch (_) {}
      process.exit(1);
    }, 120000);
  }

  let telemetryTimer = null;
  async function startTelemetryLoop() {
    if (telemetryTimer) clearInterval(telemetryTimer);
    const send = async () => {
      if (!socket.connected) return;
      try {
        const payload = await gatherTelemetryLite();
        socket.emit("agent:telemetry", payload);
      } catch (_) {}
    };
    await send();
    telemetryTimer = setInterval(send, 2000);
  }

  socket.on("connect", () => {
    appendBootLog(`socket connected url=${normalized}`);
    console.log("[agent] connected");
    startTelemetryLoop();
  });

  socket.on("agent:registered", (body) => {
    const { agentId, secret } = body || {};
    socket.agentIdStored = agentId;
    if (!agentId || !secret) return;
    appendBootLog(`paired ok agentId=${agentId}`);
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
    appendBootLog(`online agentId=${agentId}`);
    console.log("[agent] online as", agentId);
    if (exitAfterReady) finishEnrollOk();
  });

  socket.on("agent:error", (e) => {
    const msg = e?.error || e;
    appendBootLog(`agent:error ${String(msg)}`);
    console.error("[agent] error:", msg);
    if (exitAfterReady) {
      if (
        String(msg).includes("Invalid reconnect credentials") ||
        String(msg).includes("Pairing key already used")
      ) {
        console.error(
          `[agent] If you reinstalled the dashboard or removed this PC, delete ${cfgPath} and enroll again with a fresh pairing key.`
        );
      }
      finishEnrollFail();
      return;
    }
    if (
      String(msg).includes("Invalid reconnect credentials") ||
      String(msg).includes("Pairing key already used")
    ) {
      console.error(
        `[agent] If you reinstalled the dashboard or removed this PC, delete ${cfgPath} and enroll again with a fresh pairing key.`
      );
    }
  });

  socket.on("agent:command", (msg) => {
    handleCommand(socket, msg);
  });

  socket.on("disconnect", (reason) => {
    appendBootLog(`disconnect ${String(reason)}`);
    console.log("[agent] disconnected:", reason);
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  });

  socket.on("connect_error", (err) => {
    const m = err?.message || String(err);
    appendBootLog(`connect_error ${m} url=${normalized}`);
    console.error("[agent] connect_error:", m);
    try {
      const u = new URL(normalized.replace(/\/$/, ""));
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        console.error(
          "[agent] Hint: This URL points at *this* computer. If the dashboard runs on another PC, use that PC LAN IP instead (same URL you open in browser from the remote machine)."
        );
      } else {
        console.error(
          "[agent] Hint: Open dashboard PC firewall for TCP 3847; from this PC run: curl http://DASHBOARD_IP:3847/api/health"
        );
      }
    } catch (_) {}
  });
}

module.exports = { runAgent, configPath };
