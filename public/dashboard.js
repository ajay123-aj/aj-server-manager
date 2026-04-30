(() => {
  const $ = (id) => document.getElementById(id);

  let socket = null;
  let token = sessionStorage.getItem("aj_admin_token") || "";
  let selectedAgentId = null;
  const shellSessions = {};
  const isWindowsBrowser = /Windows/i.test(navigator.userAgent || "");
  let connectivityTimer = null;
  let cachedLanUrl = "";
  let monitorTimer = null;
  let activeTab = "monitor";
  const monitorHistory = { cpu: [], mem: [], disk: [] };

  $("admin-token").value = token;
  if (isWindowsBrowser && $("install-shell")) {
    $("install-shell").value = "powershell";
  }

  function api(path, opts = {}) {
    const headers = {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    return fetch(path, { ...opts, headers }).then(async (r) => {
      const txt = await r.text();
      let data;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = { raw: txt };
      }
      if (!r.ok) throw new Error(data?.error || r.statusText);
      return data;
    });
  }

  function setAuthStatus(msg, isErr) {
    const el = $("auth-status");
    el.textContent = msg;
    el.className = `status ${isErr ? "error" : ""}`;
  }

  function showMain() {
    $("auth-section").classList.toggle("hidden", true);
    $("main-section").classList.toggle("hidden", false);
  }

  $("btn-connect").onclick = async () => {
    token = $("admin-token").value.trim();
    sessionStorage.setItem("aj_admin_token", token);
    setAuthStatus("Connecting…");

    try {
      await api("/api/agents");
    } catch (e) {
      setAuthStatus(e.message || String(e), true);
      return;
    }

    setAuthStatus("Connected.");

    try {
      if (socket) socket.disconnect();

      socket = io({
        auth: { role: "dashboard", token },
        transports: ["websocket", "polling"],
      });

      socket.on("agents:list", (agents) => {
        renderAgents(agents);
      });

      socket.on("dashboard:command_result", (msg) => {
        handleCommandResult(msg);
      });

      socket.on("dashboard:shell_out", handleShellOut);
      socket.on("dashboard:telemetry", handleTelemetry);

      socket.on("connect_error", (err) =>
        console.error("[dashboard]", err.message)
      );
      showMain();
      await initAgentServerUrl();
      await refreshAgents();
    } catch (e) {
      setAuthStatus(e.message || String(e), true);
    }
  };

  function baseUrl() {
    return `${window.location.origin.replace(/\/$/, "")}`;
  }

  function pickLanUrlFromServerInfo(serverInfo) {
    const port = serverInfo?.port || new URL(baseUrl()).port || "3847";
    const ips = Array.isArray(serverInfo?.lanIps) ? serverInfo.lanIps : [];
    const ip = ips.find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
    if (!ip) return "";
    return `http://${ip}:${port}`;
  }

  function isLocalhostUrl(urlText) {
    try {
      const u = new URL(urlText);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  async function initAgentServerUrl() {
    const savedAgentUrl = sessionStorage.getItem("aj_agent_server_url");
    const b = baseUrl();
    try {
      const info = await api("/api/server-info");
      const lanUrl = pickLanUrlFromServerInfo(info);
      if (lanUrl) cachedLanUrl = lanUrl;

      if (savedAgentUrl && !isLocalhostUrl(savedAgentUrl)) {
        $("agent-server-url").value = savedAgentUrl;
        refreshInstallSnippet();
        return;
      }

      const parsed = new URL(b);
      const isLocal =
        parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (!isLocal) {
        $("agent-server-url").value = b;
        refreshInstallSnippet();
        return;
      }
      $("agent-server-url").value = lanUrl || b;
      if (lanUrl) sessionStorage.setItem("aj_agent_server_url", lanUrl);
    } catch {
      if (savedAgentUrl) {
        $("agent-server-url").value = savedAgentUrl;
      } else {
        $("agent-server-url").value = b;
      }
    }
    refreshInstallSnippet();
  }

  function normalizedAgentServerUrl() {
    let raw = ($("agent-server-url") && $("agent-server-url").value.trim()) || "";
    if (!raw) raw = sessionStorage.getItem("aj_agent_server_url") || "";
    if (!raw) raw = baseUrl();
    if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`.replace(/\/$/, "");
    } catch {
      return baseUrl();
    }
  }

  function bestAgentServerUrl() {
    const selected = normalizedAgentServerUrl();
    if (isLocalhostUrl(selected) && cachedLanUrl) return cachedLanUrl;
    return selected;
  }

  function updateLocalhostWarning() {
    const el = $("localhost-warning");
    if (!el) return;
    try {
      const u = new URL(normalizedAgentServerUrl());
      const bad = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (bad) {
        el.textContent =
          cachedLanUrl
            ? `Other PCs cannot reach localhost. Using detected LAN URL in copied commands: ${cachedLanUrl}`
            : "Other PCs cannot reach this dashboard at localhost. Enter this machine's LAN IP (example http://192.168.1.10:3847) in \"Agent connects to\" above, then copy the command again.";
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    } catch {
      el.classList.add("hidden");
    }
  }

  function currentPairingKeyFallback() {
    const keyLine = $("key-output").textContent || "";
    const match = keyLine.match(/Pairing key:\s*([a-z0-9]+)/i);
    return match?.[1] || "YOUR_PAIRING_KEY";
  }

  function refreshInstallSnippet() {
    $("install-snippet").textContent = buildInstallSnippet(currentPairingKeyFallback());
    $("connectivity-snippet").textContent = buildConnectivitySnippet();
    updateLocalhostWarning();
  }

  async function updateConnectivityStatus() {
    const el = $("connectivity-live-status");
    if (!el) return;
    const server = bestAgentServerUrl();
    try {
      const r = await fetch(`${server}/api/health`, { method: "GET" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data?.ok) {
        el.textContent = `Server reachable: ${server}`;
        el.className = "hint hint-compact status ok";
        return;
      }
      throw new Error("Bad response");
    } catch (_) {
      el.textContent = `Server unreachable from this browser: ${server}`;
      el.className = "hint hint-compact status error";
    }
  }

  function startConnectivityTimer() {
    if (connectivityTimer) clearInterval(connectivityTimer);
    updateConnectivityStatus();
    connectivityTimer = setInterval(updateConnectivityStatus, 8000);
  }

  function buildConnectivitySnippet() {
    const server = bestAgentServerUrl();
    return [
      `# Linux/macOS connectivity test (run on agent PC)`,
      `curl -v "${server}/api/health"`,
      ``,
      `# Windows firewall open (run on dashboard PC PowerShell as Admin)`,
      `netsh advfirewall firewall add rule name="AJ Dashboard 3847" dir=in action=allow protocol=TCP localport=3847`,
    ].join("\n");
  }

  function buildInstallSnippet(key = "YOUR_PAIRING_KEY") {
    const server = bestAgentServerUrl();
    const mode = $("install-mode")?.value || "node";
    const shell = $("install-shell")?.value || "bash";
    const asService = true;
    const autoClose = true;
    const repo = "https://github.com/ajay123-aj/aj-server-manager.git";

    if (shell === "powershell") {
      const psClone =
        `Set-Location $env:USERPROFILE; if (Test-Path .\\aj-server-manager\\.git) { git -C .\\aj-server-manager pull } else { git clone "${repo}" aj-server-manager }; Set-Location .\\aj-server-manager;`;
      if (mode === "docker") {
        const cmd = `${psClone} docker run --rm -it -v "${"$PWD.Path"}:/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
        return autoClose ? `${cmd}; exit` : cmd;
      }
      if (asService) {
        const cmd = `${psClone} $node=(Get-Command node).Path; $script=(Resolve-Path .\\src\\agent-cli.js).Path; $args="\`"$script\`" --server \`"${server}\`" --key \`"${key}\`""; schtasks /Create /TN "AJAgentUserTask" /SC ONLOGON /TR "\`"$node\`" $args" /F /RL LIMITED | Out-Null; Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList $args`;
        return autoClose ? `${cmd}; exit` : cmd;
      }
      const cmd = `${psClone} node .\\src\\agent-cli.js --server "${server}" --key "${key}"`;
      return autoClose ? `${cmd}; exit` : cmd;
    }

    if (shell === "cmd") {
      const winClone =
        `cd /d %USERPROFILE% && (if exist aj-server-manager\\.git (git -C aj-server-manager pull) else (git clone "${repo}" aj-server-manager)) && cd aj-server-manager &&`;
      if (mode === "docker") {
        const cmd = `${winClone} docker run --rm -it -v "%cd%:/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
        return autoClose ? `${cmd} && exit` : cmd;
      }
      if (asService) {
        const cmd = `${winClone} powershell -NoProfile -Command "$n='AJAgentService'; $bin='\"' + (Get-Command node).Path + '\" \"' + (Resolve-Path .\\src\\agent-cli.js) + '\" --server ${server} --key ${key}'; if (-not (Get-Service -Name $n -ErrorAction SilentlyContinue)) { New-Service -Name $n -BinaryPathName $bin -DisplayName 'AJ Agent Service' -StartupType Automatic }; Start-Service -Name $n; Get-Service -Name $n | Select Name,Status,StartType"`;
        return autoClose ? `${cmd} && exit` : cmd;
      }
      const cmd = `${winClone} node .\\src\\agent-cli.js --server "${server}" --key "${key}"`;
      return autoClose ? `${cmd} && exit` : cmd;
    }

    const posixClone =
      `(git -C ~/aj-server-manager pull || git clone "${repo}" ~/aj-server-manager) && cd ~/aj-server-manager &&`;
    if (mode === "docker") {
      return `${posixClone} docker run --rm -it -v "$(pwd):/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
    }
    if (asService) {
      return `${posixClone} (command -v node >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y nodejs npm)); sudo bash -lc 'cat >/etc/systemd/system/aj-agent.service <<EOF
[Unit]
Description=AJ Agent Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node) $(pwd)/src/agent-cli.js --server "${server}" --key "${key}"
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now aj-agent.service && systemctl status aj-agent.service --no-pager --lines=5'`;
    }
    return `${posixClone} (command -v node >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y nodejs npm)); node ./src/agent-cli.js --server "${server}" --key "${key}"`;
  }

  function renderAgents(agents) {
    const tb = $("agents-body");
    tb.innerHTML = "";
    agents.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(a.hostname)}</td>
        <td>${escapeHtml(a.platform)} ${escapeHtml(a.arch || "")}</td>
        <td>${a.online ? '<span class="pill ok">Online</span>' : '<span class="pill off">Offline</span>'}</td>
        <td>
          <button type="button" class="btn-ghost btn-open">Open</button>
          <button type="button" class="btn-ghost btn-remove">Remove</button>
        </td>`;
      tr.querySelector(".btn-open").onclick = () => openDetail(a);
      tr.querySelector(".btn-remove").onclick = () => removeComputer(a);
      tb.appendChild(tr);
    });
  }

  async function removeComputer(agent) {
    const ok = confirm(
      `Remove computer "${agent.hostname}" from dashboard?\nThis removes it from list and disconnects it.`
    );
    if (!ok) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      if (selectedAgentId === agent.id) {
        $("detail-panel").classList.toggle("hidden", true);
        stopMonitorTimer();
        selectedAgentId = null;
      }
      await refreshAgents();
      $("key-output").textContent = `Removed computer: ${agent.hostname}`;
    } catch (e) {
      $("key-output").textContent = `Remove failed: ${e.message || e}`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshAgents() {
    try {
      const data = await api("/api/agents");
      renderAgents(data.agents);
    } catch (e) {
      console.error(e);
    }
  }

  function openDetail(agent) {
    selectedAgentId = agent.id;
    $("detail-panel").classList.toggle("hidden", false);
    $("detail-title").textContent = `${agent.hostname} (${agent.platform})`;
    monitorHistory.cpu = [];
    monitorHistory.mem = [];
    monitorHistory.disk = [];
    $("metric-cpu").textContent = "-";
    $("metric-mem").textContent = "-";
    $("metric-disk").textContent = "-";
    $("metric-uptime").textContent = "-";
    $("metric-hostname").textContent = "";
    $("metrics-out").textContent = "";
    $("services-out").textContent = "";
    $("exec-out").textContent = "";
    $("shell-out").value = "";
    activateTab("monitor");
    if (agent.online) {
      requestMonitorSample();
      startMonitorTimer();
    } else {
      $("metrics-out").textContent = "Agent offline.";
      $("monitor-live-status").textContent = "Agent offline";
    }
  }

  $("btn-close-detail").onclick = () => {
    $("detail-panel").classList.toggle("hidden", true);
    stopMonitorTimer();
    selectedAgentId = null;
  };

  function activateTab(name) {
    activeTab = name;
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    document.querySelectorAll("[data-panel]").forEach((p) =>
      p.classList.toggle("hidden", p.dataset.panel !== name)
    );
    if (name === "monitor" && selectedAgentId) {
      requestMonitorSample();
      startMonitorTimer();
    } else {
      stopMonitorTimer();
    }
  }

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => activateTab(t.dataset.tab))
  );

  $("btn-gen-key").onclick = async () => {
    $("key-output").textContent = "";
    try {
      const label = $("key-label").value.trim();
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ multiUse: false, label }),
      });
      $("key-output").textContent = `Pairing key: ${res.key}\n(One-time key)`;
      refreshInstallSnippet();
    } catch (e) {
      $("key-output").textContent =
        String(e.message || e) +
        '\nEnsure ADMIN_TOKEN matches this server\'s ".env".';
    }
  };

  $("btn-gen-copy-install").onclick = async () => {
    $("key-output").textContent = "";
    try {
      const label = $("key-label").value.trim();
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ multiUse: false, label }),
      });
      $("key-output").textContent = `Pairing key: ${res.key}\n(One-time key)`;
      refreshInstallSnippet();
      await navigator.clipboard.writeText($("install-snippet").textContent.trim());
      $("key-output").textContent += "\nInstall command copied.";
    } catch (e) {
      $("key-output").textContent =
        String(e.message || e) +
        '\nEnsure ADMIN_TOKEN matches this server\'s ".env".';
    }
  };

  $("btn-copy-install").onclick = async () => {
    const cmd = $("install-snippet").textContent.trim();
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      $("key-output").textContent = "Install command copied.";
    } catch (e) {
      $("key-output").textContent = "Copy failed. Select and copy manually.";
    }
  };

  $("btn-copy-check-linux").onclick = async () => {
    const server = normalizedAgentServerUrl();
    const cmd = `curl -v "${server}/api/health"`;
    try {
      await navigator.clipboard.writeText(cmd);
      $("key-output").textContent = "Linux connectivity command copied.";
    } catch {
      $("key-output").textContent = "Copy failed. Select and copy manually.";
    }
  };

  $("btn-copy-check-windows").onclick = async () => {
    const cmd =
      'netsh advfirewall firewall add rule name="AJ Dashboard 3847" dir=in action=allow protocol=TCP localport=3847';
    try {
      await navigator.clipboard.writeText(cmd);
      $("key-output").textContent = "Windows firewall command copied.";
    } catch {
      $("key-output").textContent = "Copy failed. Select and copy manually.";
    }
  };

  $("install-mode").onchange = () => refreshInstallSnippet();
  $("install-shell").onchange = () => refreshInstallSnippet();

  $("agent-server-url").addEventListener("input", () => {
    const v = $("agent-server-url").value.trim();
    if (v) sessionStorage.setItem("aj_agent_server_url", v);
    refreshInstallSnippet();
    updateConnectivityStatus();
  });

  function sendCommand(agentId, type, payload, cb) {
    if (!socket) return;
    const commandId =
      crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    socket.timeout(15000).emit(
      "dashboard:command",
      { agentId, commandId, type, payload },
      (ack) => {
        if (!ack || ack.ok !== true) {
          pending.delete(commandId);
          const err = ack?.error || "No response from agent";
          if (type === "metrics") {
            $("monitor-live-status").textContent = `Monitor error: ${err}`;
            $("metrics-out").textContent = `Monitor error: ${err}`;
          } else if (type === "list_services") {
            $("services-out").textContent = `Error: ${err}`;
          } else if (type === "exec") {
            $("exec-out").textContent = `Error: ${err}`;
          }
        }
        cb?.(commandId, ack);
      }
    );

    pending.set(commandId, { type, agentId });
    return commandId;
  }

  const pending = new Map();

  function stopMonitorTimer() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function startMonitorTimer() {
    stopMonitorTimer();
    if (!selectedAgentId || activeTab !== "monitor") return;
    $("monitor-live-status").textContent = "Live refresh every 4s";
    monitorTimer = setInterval(() => {
      requestMonitorSample();
    }, 4000);
  }

  function requestMonitorSample() {
    if (!selectedAgentId || !socket) return;
    sendCommand(selectedAgentId, "metrics", {});
  }

  function pushMetric(history, value, max = 36) {
    history.push(Number(value) || 0);
    if (history.length > max) history.shift();
  }

  function drawSparkline(canvasId, values, stroke = "#3d8bfd") {
    const c = $(canvasId);
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(139,155,180,0.4)";
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    if (!values.length) return;
    const max = 100;
    const stepX = values.length > 1 ? w / (values.length - 1) : w;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = i * stepX;
      const y = h - (Math.min(Math.max(v, 0), max) / max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function fmtPct(v) {
    return `${(Number(v) || 0).toFixed(1)}%`;
  }

  function fmtBytes(n) {
    const b = Number(n) || 0;
    const gb = b / (1024 ** 3);
    return `${gb.toFixed(1)} GB`;
  }

  function fmtUptime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  function renderMonitor(data) {
    const cpuPct = Number(data?.currentLoad?.currentLoad || 0);
    const memTotal = Number(data?.mem?.total || 0);
    const memUsed = Number(data?.mem?.active || data?.mem?.used || 0);
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    const fs = Array.isArray(data?.fsSizes) ? data.fsSizes : [];
    const diskPct = fs.length ? Number(fs[0]?.use || 0) : 0;
    const diskUsed = fs.length ? Number(fs[0]?.used || 0) : 0;
    const diskSize = fs.length ? Number(fs[0]?.size || 0) : 0;
    const upSec = Number(data?.uptime?.uptime || data?.uptime || 0);
    const host = data?.hostname || data?.staticData?.osInfo?.hostname || "";

    pushMetric(monitorHistory.cpu, cpuPct);
    pushMetric(monitorHistory.mem, memPct);
    pushMetric(monitorHistory.disk, diskPct);

    $("metric-cpu").textContent = fmtPct(cpuPct);
    $("metric-mem").textContent = `${fmtPct(memPct)} (${fmtBytes(memUsed)} / ${fmtBytes(memTotal)})`;
    $("metric-disk").textContent = `${fmtPct(diskPct)} (${fmtBytes(diskUsed)} / ${fmtBytes(diskSize)})`;
    $("metric-uptime").textContent = fmtUptime(upSec);
    $("metric-hostname").textContent = host ? `Host: ${host}` : "";
    $("monitor-live-status").textContent = `Updated ${new Date().toLocaleTimeString()}`;

    drawSparkline("chart-cpu", monitorHistory.cpu, "#3d8bfd");
    drawSparkline("chart-mem", monitorHistory.mem, "#3dcc85");
    drawSparkline("chart-disk", monitorHistory.disk, "#e6b35a");

    $("metrics-out").textContent = JSON.stringify(data, null, 2);
  }

  function handleTelemetry(body) {
    if (!body || !selectedAgentId) return;
    if (body.agentId !== selectedAgentId) return;
    if (activeTab !== "monitor") return;
    renderMonitor(body);
  }

  function handleCommandResult(msg) {
    const {
      commandId,
      type,
      stdout,
      stderr,
      exitCode,
      data,
      error,
      timedOut,
      agentId,
    } =
      msg || {};
    if (selectedAgentId && agentId && agentId !== selectedAgentId) return;
    const pend = pending.get(commandId);

    const text = [];

    const tabFor = pend?.type || type;

    if (tabFor === "metrics") {
      if (typeof data !== "undefined") renderMonitor(data);
      else $("metrics-out").textContent = error || "?";
      pending.delete(commandId);
      return;
    }
    if (tabFor === "list_services") {
      if (error) $("services-out").textContent = error;
      else
        $("services-out").textContent = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n\n");
      pending.delete(commandId);
      return;
    }
    if (
      tabFor === "service_install" ||
      tabFor === "service_start" ||
      tabFor === "service_stop" ||
      tabFor === "service_remove" ||
      tabFor === "agent_connect" ||
      tabFor === "agent_disconnect"
    ) {
      const parts = [];
      if (typeof exitCode !== "undefined") parts.push(`exit: ${exitCode}`);
      if (error) parts.push(`Error: ${error}`);
      if (stdout) parts.push(`[stdout]\n${stdout}`);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      $("services-out").textContent = parts.join("\n\n");
      pending.delete(commandId);
      return;
    }
    if (tabFor === "exec") {
      const parts = [];
      if (typeof exitCode !== "undefined") parts.push(`exit: ${exitCode}`);
      if (timedOut) parts.push("TIMED OUT");
      if (error) parts.push(error);
      if (stdout) parts.push(`[stdout]\n${stdout}`);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      $("exec-out").textContent = parts.join("\n\n");
      pending.delete(commandId);
      return;
    }

    pending.delete(commandId);
  }

  function handleShellOut(body) {
    if (!selectedAgentId || body.agentId !== selectedAgentId) return;
    const ta = $("shell-out");
    if (body.kind === "exit") {
      ta.value += `\n--- shell exited (${body.code ?? "?"}) ---\n`;
      return;
    }
    ta.value += body.data ?? "";
    ta.scrollTop = ta.scrollHeight;
  }

  $("btn-refresh-metrics").onclick = () => {
    if (!selectedAgentId || !socket) return;
    requestMonitorSample();
  };

  $("btn-refresh-services").onclick = () => {
    if (!selectedAgentId || !socket) return;
    $("services-out").textContent = "Loading…";
    sendCommand(selectedAgentId, "list_services", {});
  };

  $("btn-agent-connect").onclick = () => {
    if (!selectedAgentId || !socket) return;
    $("services-out").textContent = "Connecting agent…";
    sendCommand(selectedAgentId, "agent_connect", { serverUrl: bestAgentServerUrl() });
  };

  $("btn-agent-disconnect").onclick = () => {
    if (!selectedAgentId || !socket) return;
    $("services-out").textContent = "Disconnecting agent…";
    sendCommand(selectedAgentId, "agent_disconnect", {});
  };


  $("btn-run-exec").onclick = () => {
    const cmd = $("exec-cmd").value;
    if (!selectedAgentId || !socket || !cmd.trim()) return;
    $("exec-out").textContent = "Running…";
    sendCommand(selectedAgentId, "exec", { command: cmd });
  };

  $("btn-shell-start").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    shellSessions[selectedAgentId] = { session: sid };
    $("shell-out").value += "\nStarting shell session…\n";
    sendCommand(selectedAgentId, "shell_start", { sessionId: sid });
  };

  $("btn-shell-stop").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    sendCommand(selectedAgentId, "shell_stop", { sessionId: sid });
    $("shell-out").value += "\nStopped shell.\n";
  };

  $("btn-shell-send").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    const line = $("shell-in").value;
    if (!line) return;
    sendCommand(selectedAgentId, "shell_input", { sessionId: sid, input: line });
    $("shell-in").value = "";
  };

  if (token) {
    $("btn-connect").click();
  }
  startConnectivityTimer();
})();
