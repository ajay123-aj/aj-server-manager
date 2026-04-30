(() => {
  const $ = (id) => document.getElementById(id);

  let socket = null;
  let token = sessionStorage.getItem("aj_admin_token") || "";
  let selectedAgentId = null;
  const shellSessions = {};
  const isWindowsBrowser = /Windows/i.test(navigator.userAgent || "");
  let connectivityTimer = null;

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

  async function initAgentServerUrl() {
    const savedAgentUrl = sessionStorage.getItem("aj_agent_server_url");
    if (savedAgentUrl) {
      $("agent-server-url").value = savedAgentUrl;
      refreshInstallSnippet();
      return;
    }

    const b = baseUrl();
    try {
      const parsed = new URL(b);
      const isLocal =
        parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (!isLocal) {
        $("agent-server-url").value = b;
        refreshInstallSnippet();
        return;
      }
      const info = await api("/api/server-info");
      const lanUrl = pickLanUrlFromServerInfo(info);
      $("agent-server-url").value = lanUrl || b;
      if (lanUrl) sessionStorage.setItem("aj_agent_server_url", lanUrl);
    } catch {
      $("agent-server-url").value = b;
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

  function updateLocalhostWarning() {
    const el = $("localhost-warning");
    if (!el) return;
    try {
      const u = new URL(normalizedAgentServerUrl());
      const bad = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (bad) {
        el.textContent =
          "Other PCs cannot reach this dashboard at localhost. Enter this machine's LAN IP (example http://192.168.1.10:3847) in \"Agent connects to\" above, then copy the command again.";
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
    const server = normalizedAgentServerUrl();
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
    const server = normalizedAgentServerUrl();
    return [
      `# Linux/macOS connectivity test (run on agent PC)`,
      `curl -v "${server}/api/health"`,
      ``,
      `# Windows firewall open (run on dashboard PC PowerShell as Admin)`,
      `netsh advfirewall firewall add rule name="AJ Dashboard 3847" dir=in action=allow protocol=TCP localport=3847`,
    ].join("\n");
  }

  function buildInstallSnippet(key = "YOUR_PAIRING_KEY") {
    const server = normalizedAgentServerUrl();
    const mode = $("install-mode")?.value || "node";
    const shell = $("install-shell")?.value || "bash";
    const repo = "https://github.com/ajay123-aj/aj-server-manager.git";

    if (shell === "powershell") {
      const psClone =
        `Set-Location $env:USERPROFILE; if (Test-Path .\\aj-server-manager\\.git) { git -C .\\aj-server-manager pull } else { git clone "${repo}" aj-server-manager }; Set-Location .\\aj-server-manager;`;
      if (mode === "docker") {
        return `${psClone} docker run --rm -it -v "${"$PWD.Path"}:/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
      }
      return `${psClone} node .\\src\\agent-cli.js --server "${server}" --key "${key}"`;
    }

    if (shell === "cmd") {
      const winClone =
        `cd /d %USERPROFILE% && (git -C aj-server-manager pull || git clone "${repo}" aj-server-manager) && cd aj-server-manager &&`;
      if (mode === "docker") {
        return `${winClone} docker run --rm -it -v "%cd%:/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
      }
      return `${winClone} node .\\src\\agent-cli.js --server "${server}" --key "${key}"`;
    }

    const posixClone =
      `(git -C ~/aj-server-manager pull || git clone "${repo}" ~/aj-server-manager) && cd ~/aj-server-manager &&`;
    if (mode === "docker") {
      return `${posixClone} docker run --rm -it -v "$(pwd):/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
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
        <td><button type="button" class="btn-ghost btn-open">Open</button></td>`;
      tr.querySelector(".btn-open").onclick = () => openDetail(a);
      tb.appendChild(tr);
    });
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
    $("metrics-out").textContent = "";
    $("services-out").textContent = "";
    $("exec-out").textContent = "";
    $("shell-out").value = "";
    activateTab("monitor");
    if (agent.online) sendCommand(agent.id, "metrics", {});
    else $("metrics-out").textContent = agent.online ? "" : "Agent offline.";
  }

  $("btn-close-detail").onclick = () => {
    $("detail-panel").classList.toggle("hidden", true);
    selectedAgentId = null;
  };

  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    document.querySelectorAll("[data-panel]").forEach((p) =>
      p.classList.toggle("hidden", p.dataset.panel !== name)
    );
  }

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => activateTab(t.dataset.tab))
  );

  $("btn-gen-key").onclick = async () => {
    $("key-output").textContent = "";
    try {
      const multiUse = $("key-multi-use").checked;
      const label = $("key-label").value.trim();
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ multiUse, label }),
      });
      $("key-output").textContent = `Pairing key: ${res.key}\n(Multi-use: ${!!res.multiUse})`;
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
      const multiUse = $("key-multi-use").checked;
      const label = $("key-label").value.trim();
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ multiUse, label }),
      });
      $("key-output").textContent = `Pairing key: ${res.key}\n(Multi-use: ${!!res.multiUse})`;
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
      (ack) => cb?.(commandId, ack)
    );

    pending.set(commandId, { type, agentId });
    return commandId;
  }

  const pending = new Map();

  function handleCommandResult(msg) {
    const { commandId, type, stdout, stderr, exitCode, data, error, timedOut } =
      msg || {};
    const pend = pending.get(commandId);

    const text = [];

    const tabFor = pend?.type || type;

    if (tabFor === "metrics") {
      $("metrics-out").textContent =
        typeof data !== "undefined" ? JSON.stringify(data, null, 2) : error || "?";
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
    sendCommand(selectedAgentId, "metrics", {});
  };

  $("btn-refresh-services").onclick = () => {
    if (!selectedAgentId || !socket) return;
    $("services-out").textContent = "Loading…";
    sendCommand(selectedAgentId, "list_services", {});
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
