/**
 * Windows service / Scheduled Task and Linux systemd unit for the managed agent.
 * Keep install snippets (public/dashboard.js) in sync with these values.
 */
module.exports = {
  /** Windows SCM service short name */
  WIN_SERVICE_NAME: "aj-server-manager",
  /** Windows Task Scheduler task name (logon bootstrap) */
  WIN_TASK_NAME: "aj-server-manager",
  WIN_SERVICE_DISPLAY_NAME: "AJ Server Manager Agent",
  /** systemd unit filename */
  LINUX_SYSTEMD_UNIT: "aj-server-manager.service",
};
