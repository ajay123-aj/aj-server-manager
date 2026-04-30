(() => {
  const $ = (id) => document.getElementById(id);

  let socket = null;
  const pageParams = new URLSearchParams(window.location.search);
  let token = sessionStorage.getItem("aj_admin_token") || "";
  if (!token) {
    const tokenFromQuery = pageParams.get("token") || "";
    if (tokenFromQuery) {
      token = tokenFromQuery;
      sessionStorage.setItem("aj_admin_token", token);
    }
  }
  let selectedAgentId = null;
  const shellSessions = {};
  const isWindowsBrowser = /Windows/i.test(navigator.userAgent || "");
  let connectivityTimer = null;
  let cachedLanUrl = "";
  let monitorTimer = null;
  let activeTab = "monitor";
  const monitorHistory = { cpu: [], mem: [], disk: [] };
  let pendingConnectLabel = "";
  let pendingConnectTimer = null;
  /** Rows in table last time we rendered (used after Add Computer pairing). */
  let lastAgentsListCount = 0;
  /** Snapshot of lastAgentsListCount when a pairing key was generated; -1 = no wait. */
  let pendingAgentsBaseline = -1;

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

  /** http:// LAN often rejects navigator.clipboard; textarea + execCommand runs in the same user gesture. */
  async function copyToClipboard(text) {
    const payload = String(text ?? "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-3000px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, payload.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function setAuthStatus(msg, isErr) {
    const el = $("auth-status");
    el.textContent = msg;
    el.className = `status ${isErr ? "error" : ""}`;
  }

  function showMain() {
    $("auth-section").classList.toggle("hidden", true);
    $("main-section").classList.toggle("hidden", false);
    $("add-computer-panel").classList.toggle("hidden", true);
  }

  function computersHint(msg) {
    const el = $("computers-hint");
    if (el) el.textContent = msg || "";
  }

  function finishPendingEnrollment(msg) {
    if (pendingConnectTimer) {
      clearInterval(pendingConnectTimer);
      pendingConnectTimer = null;
    }
    pendingAgentsBaseline = -1;
    pendingConnectLabel = "";
    $("add-computer-panel").classList.add("hidden");
    if (msg) computersHint(msg);
    focusComputersSection();
  }

  async function startPendingEnrollmentPoll(labelSnapshot) {
    pendingConnectLabel = labelSnapshot || "";
    try {
      await refreshAgents();
    } catch (_) {
      /* refreshAgents surfaces errors in computersHint */
    }
    pendingAgentsBaseline = lastAgentsListCount;
    if (pendingConnectTimer) clearInterval(pendingConnectTimer);
    pendingConnectTimer = setInterval(() => refreshAgents(), 2500);
    computersHint(
      "Waiting for that PC to run the copied command… The Computers table below updates when it connects."
    );
  }

  function focusComputersSection() {
    const el = document.getElementById("computers");
    requestAnimationFrame(() => {
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function stripTokenFromUrlPreserveHash() {
    try {
      const u = new URL(window.location.href);
      if (!u.searchParams.has("token")) return;
      u.searchParams.delete("token");
      const qs = u.searchParams.toString();
      window.history.replaceState({}, "", `${u.pathname}${qs ? `?${qs}` : ""}${u.hash}`);
    } catch {
      /* ignore */
    }
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
      stripTokenFromUrlPreserveHash();
      await initAgentServerUrl();
      await refreshAgents();
      if (window.location.hash === "#computers") {
        focusComputersSection();
      }
    } catch (e) {
      setAuthStatus(e.message || String(e), true);
    }
  };

  window.addEventListener("hashchange", () => {
    if (
      window.location.hash === "#computers" &&
      socket &&
      !$("main-section").classList.contains("hidden")
    ) {
      focusComputersSection();
    }
  });

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
      `# Linux/macOS (run on agent PC)`,
      `curl -fsS "${server}/api/health"`,
      ``,
      `# Windows — use curl.exe or irm (plain "curl" in PowerShell runs Invoke-WebRequest and may prompt)`,
      `curl.exe -fsS "${server}/api/health"`,
      `irm "${server}/api/health"`,
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

    function escapePsSq(s) {
      return String(s).replace(/'/g, "''");
    }

    /** After cwd is the repo root: npm, one-time pairing, log-on task (no pairing key in the task). */
    function windowsAgentBootstrapFromRepoDir(srvRaw, pairingKeyRaw) {
      const srv = escapePsSq(srvRaw);
      const pairKey = escapePsSq(pairingKeyRaw);
      return `$mgr=(Get-Location).Path; Set-Location $mgr; Write-Host 'npm install via cmd.exe (avoids npm.ps1 / execution policy)...' -ForegroundColor Cyan; cmd.exe /d /s /c npm install; if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed.' -ForegroundColor Red; exit 1 }; $srv='${srv}'; $pairkey='${pairKey}'; $bLog=(Join-Path $env:USERPROFILE '.aj-server-manager-agent-boot.log'); Write-Host ('Log: ' + $bLog) -ForegroundColor Gray; $health=($srv.TrimEnd('/')) + '/api/health'; try { Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 12 | Out-Null } catch { Write-Host 'Cannot reach dashboard (HTTP). Fix this first:' -ForegroundColor Red; Write-Host $health; Write-Host 'On the dashboard PC (Windows) open PowerShell as Administrator and run:' -ForegroundColor Yellow; Write-Host 'netsh advfirewall firewall add rule name="AJ Dashboard 3847" dir=in action=allow protocol=TCP localport=3847' -ForegroundColor Yellow; Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }; $node=(Get-Command node).Source; $script=(Resolve-Path (Join-Path $mgr 'src/agent-cli.js')).Path; Write-Host 'STEP 1 — Pairing (expect Enrollment OK; one reconnect line mid-way is OK)...' -ForegroundColor Cyan; & $node $script @('--server',$srv,'--key',$pairkey,'--pair-once'); if ($LASTEXITCODE -ne 0) { Write-Host 'Pairing failed — fix errors above, or delete .aj-server-manager-agent.json under your profile and ask the dashboard for a new key.' -ForegroundColor Red; exit 1 }; $cfgAgent=Join-Path $env:USERPROFILE '.aj-server-manager-agent.json'; $until=[datetime]::UtcNow.AddSeconds(25); while (-not (Test-Path -LiteralPath $cfgAgent) -and ([datetime]::UtcNow -lt $until)) { Start-Sleep -Milliseconds 350 }; if (-not (Test-Path -LiteralPath $cfgAgent)) { Write-Host 'Credential file not found after STEP 1 (waited 25s). Check antivirus blocking profile writes, or retry pairing.' -ForegroundColor Red; exit 1 }; Write-Host 'STEP 2 — Background agent + log-on task (no pairing key in task)...' -ForegroundColor Green; if ($env:AJ_PAIRING_KEY) { Write-Host 'Clearing AJ_PAIRING_KEY for this session so the background agent uses saved credentials from pairing (env key no longer forces re-pair).' -ForegroundColor DarkYellow; Remove-Item env:AJ_PAIRING_KEY -ErrorAction SilentlyContinue }; $proc = Start-Process -PassThru -WindowStyle Hidden -FilePath $node -WorkingDirectory $mgr -ArgumentList @($script,'--server',$srv); Start-Sleep -Seconds 4; if ($proc.HasExited) { Write-Host ('Background agent exited early (code '+$proc.ExitCode+'). If it keeps happening, remove user/system env AJ_PAIRING_KEY or run in a visible console: & $node $script --server $srv') -ForegroundColor Red }; try { $who=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $argLine=('"{0}" --server "{1}"' -f $script,$srv); $stAction=New-ScheduledTaskAction -Execute $node -WorkingDirectory $mgr -Argument $argLine; $stTrigger=New-ScheduledTaskTrigger -AtLogOn -User $who; $stPrincipal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited; $null = Register-ScheduledTask -TaskName 'aj-server-manager' -Action $stAction -Trigger $stTrigger -Principal $stPrincipal -Force } catch { Write-Host ('Log-on task not registered: {0}. Fix: open PowerShell as Administrator and run this script again, or run Register-ScheduledTask manually.' -f $_.Exception.Message) -ForegroundColor DarkYellow }; Write-Host 'Done. Refresh Computers on the dashboard.' -ForegroundColor Gray`;
    }

    if (shell === "powershell") {
      const psClone =
        `Set-Location $env:USERPROFILE; if (Test-Path .\\aj-server-manager\\.git) { git -C .\\aj-server-manager pull } else { git clone "${repo}" aj-server-manager }; Set-Location .\\aj-server-manager;`;
      if (mode === "docker") {
        const cmd = `${psClone} docker run --rm -it -v "${"$PWD.Path"}:/app" -w /app node:20 sh -lc "node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
        return autoClose ? `${cmd}; exit` : cmd;
      }
      if (asService) {
        const cmd = `${psClone} ${windowsAgentBootstrapFromRepoDir(server, key)}`;
        return autoClose ? `${cmd}; Start-Sleep -Seconds 6; exit` : cmd;
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
        const quoted =
          "'" +
          `${windowsAgentBootstrapFromRepoDir(server, key)}`.replace(/'/g, "''") +
          "'";
        const cmd = `${winClone} powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${quoted}`;
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
      return `${posixClone} (command -v node >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y nodejs npm)); npm install; node ./src/agent-cli.js --server "${server}" --key "${key}" >/tmp/aj-server-manager-pair.log 2>&1 & i=0; while [ \$i -lt 120 ] && ! [ -f \$HOME/.aj-server-manager-agent.json ]; do sleep 1; i=\$((i+1)); done; sudo bash -lc 'cat >/etc/systemd/system/aj-server-manager.service <<EOF
[Unit]
Description=AJ Server Manager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node) $(pwd)/src/agent-cli.js --server "${server}"
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now aj-server-manager.service && systemctl status aj-server-manager.service --no-pager --lines=5'`;
    }
    return `${posixClone} (command -v node >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y nodejs npm)); node ./src/agent-cli.js --server "${server}" --key "${key}"`;
  }

  async function editAgentLabel(agent) {
    computersHint("");
    const cur = (agent.label && String(agent.label).trim()) || "";
    const v = prompt(
      `Dashboard label for this computer (required):\nHostname: ${agent.hostname}`,
      cur || ""
    );
    if (v === null) return;
    const label = v.trim();
    if (!label) {
      computersHint("Label cannot be empty.");
      return;
    }
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
      computersHint(`Label saved: ${label}`);
      await refreshAgents();
    } catch (e) {
      computersHint(`Label save failed: ${e.message || e}`);
    }
  }

  function rowAgentConnect(agent) {
    computersHint("");
    if (!socket) {
      computersHint("Dashboard is not connected. Reconnect using “Connect dashboard”.");
      return;
    }
    if (!agent.online) {
      computersHint(
        "This PC shows Offline — the dashboard cannot reach that computer until the agent process is running there. On Linux start: sudo systemctl start aj-server-manager.service (or rerun the install one-liner). Use Connect again after it is online."
      );
      return;
    }
    computersHint(`Connecting agent service on ${agent.hostname}…`);
    sendCommand(agent.id, "agent_connect", { serverUrl: bestAgentServerUrl() }, (_, ack) => {
      computersHint(
        ack?.ok
          ? `Connect sent to ${agent.hostname}. Starts systemd/task on that PC — status updates in a few seconds.`
          : `Connect failed: ${ack?.error || "unknown"}`
      );
    });
  }

  function rowAgentDisconnect(agent) {
    computersHint("");
    if (!socket) {
      computersHint("Dashboard is not connected. Reconnect using “Connect dashboard”.");
      return;
    }
    if (!agent.online) {
      computersHint(
        "Offline: disconnect only works while the agent is connected. If the agent is stopped on the PC, it is already disconnected from this dashboard."
      );
      return;
    }
    computersHint(`Stopping agent service on ${agent.hostname}…`);
    sendCommand(agent.id, "agent_disconnect", {}, (_, ack) => {
      computersHint(
        ack?.ok
          ? `Disconnect sent to ${agent.hostname} — agent service/task will stop on that PC.`
          : `Disconnect failed: ${ack?.error || "unknown"}`
      );
    });
  }

  function renderAgents(agents) {
    const list = Array.isArray(agents) ? agents : [];
    const tb = $("agents-body");
    tb.innerHTML = "";
    let matchedPending = null;
    list.forEach((a) => {
      const lab = (a.label && String(a.label).trim()) || "";
      if (pendingConnectLabel && lab === pendingConnectLabel) matchedPending = a;
    });
    list.forEach((a) => {
      const labelText =
        (a.label && String(a.label).trim()) ? a.label.trim() : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div class="cell-stack"><span>${escapeHtml(labelText)}</span><button type="button" class="btn-ghost btn-edit-label">Set label</button></div></td>
        <td>${escapeHtml(a.hostname)}</td>
        <td>${escapeHtml(a.platform)} ${escapeHtml(a.arch || "")}</td>
        <td>${a.online ? '<span class="pill ok">Online</span>' : '<span class="pill off">Offline</span>'}</td>
        <td><div class="cell-actions">
          <button type="button" class="btn-ghost btn-open">Open</button>
          <button type="button" class="btn-ghost btn-connect-pc">Connect</button>
          <button type="button" class="btn-ghost btn-disconnect-pc">Disconnect</button>
          <button type="button" class="btn-ghost btn-remove">Remove</button>
        </div></td>`;
      tr.querySelector(".btn-open").onclick = () => openDetail(a);
      tr.querySelector(".btn-edit-label").onclick = () => editAgentLabel(a);
      tr.querySelector(".btn-connect-pc").onclick = () => rowAgentConnect(a);
      tr.querySelector(".btn-disconnect-pc").onclick = () => rowAgentDisconnect(a);
      tr.querySelector(".btn-remove").onclick = () => removeComputer(a);
      tb.appendChild(tr);
    });
    if (matchedPending) {
      $("key-output").textContent =
        `Computer connected.\nPairing label: ${matchedPending.label}\nHostname: ${matchedPending.hostname}`;
    }

    lastAgentsListCount = list.length;
    if (
      pendingConnectTimer != null &&
      pendingAgentsBaseline >= 0 &&
      list.length > pendingAgentsBaseline
    ) {
      finishPendingEnrollment(
        `New computer in list (${list.length} total). It appears below — scroll down if needed.`
      );
    }
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
      computersHint(`Could not load computers list: ${e.message || e}`);
    }
  }

  function openDetail(agent) {
    const url = new URL("computer.html", window.location.href);
    url.searchParams.set("agentId", agent.id);
    if (token) url.searchParams.set("token", token);
    window.location.href = url.toString();
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
      if (!label) {
        $("key-output").textContent = "Label is required.";
        return;
      }
      const mu = $("key-multi-use")?.checked ?? true;
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ label, multiUse: mu }),
      });
      const mt = res.multiUse
        ? "(Multi-use: reuse this key until you revoke/regenerate)"
        : "(Single-use: key works for exactly one enrollment)";
      $("key-output").textContent = `Pairing key: ${res.key}\nLabel: ${res.label || ""}\n${mt}`;
      $("key-output").textContent +=
        "\n\nRun the command on the other PC. Waiting for connection… Close this popup any time.";
      await startPendingEnrollmentPoll(label);
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
      if (!label) {
        $("key-output").textContent = "Label is required.";
        return;
      }
      const mu = $("key-multi-use")?.checked ?? true;
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ label, multiUse: mu }),
      });
      const mt = res.multiUse
        ? "(Multi-use: reuse this key until you revoke/regenerate)"
        : "(Single-use: key works for exactly one enrollment)";
      $("key-output").textContent = `Pairing key: ${res.key}\nLabel: ${res.label || ""}\n${mt}`;
      $("key-output").textContent +=
        "\n\nRun the command on the other PC. Waiting for connection… Close this popup any time.";
      await startPendingEnrollmentPoll(label);
      refreshInstallSnippet();
      const snippet = $("install-snippet").textContent.trim();
      const copied = await copyToClipboard(snippet);
      $("key-output").textContent += copied
        ? "\nInstall command copied to clipboard."
        : "\nCopy failed — select the command in the box below (Ctrl+A, Ctrl+C). On http:// LAN, browsers may block auto-copy.";
    } catch (e) {
      $("key-output").textContent =
        String(e.message || e) +
        '\nEnsure ADMIN_TOKEN matches this server\'s ".env".';
    }
  };

  $("btn-copy-install").onclick = async () => {
    const cmd = $("install-snippet").textContent.trim();
    if (!cmd) return;
    const ok = await copyToClipboard(cmd);
    $("key-output").textContent = ok
      ? "Install command copied."
      : "Copy failed — select the command manually (LAN http:// often blocks clipboard).";
  };

  $("btn-copy-check-linux").onclick = async () => {
    const server = normalizedAgentServerUrl();
    const cmd = `curl.exe -fsS "${server}/api/health"`;
    const ok = await copyToClipboard(cmd);
    $("key-output").textContent = ok
      ? "Connectivity command copied."
      : "Copy failed — type or select from connectivity box.";
  };

  $("btn-copy-check-windows").onclick = async () => {
    const cmd =
      'netsh advfirewall firewall add rule name="AJ Dashboard 3847" dir=in action=allow protocol=TCP localport=3847';
    const ok = await copyToClipboard(cmd);
    $("key-output").textContent = ok
      ? "Windows firewall command copied."
      : "Copy failed — select from connectivity box.";
  };

  $("btn-open-add-computer").onclick = () => {
    $("add-computer-panel").classList.remove("hidden");
    $("key-label").focus?.();
  };

  $("btn-close-add-computer").onclick = () => {
    $("add-computer-panel").classList.add("hidden");
    if (pendingConnectTimer) {
      computersHint(
        "Waiting for new PC… The Computers list below refreshes automatically when it connects."
      );
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
