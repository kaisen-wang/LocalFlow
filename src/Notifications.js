// 通知模块：到期提醒 / 专注结束 / 里程碑进度 / 每日摘要。
// 全部可分别在设置面板里关闭；开关与时间偏好存 localStorage。

const KEY = "localflow-notif";

export const PREFS_DEFAULTS = {
  master: true,       // 总开关
  due: true,          // 快要超时提醒
  pomo: true,         // 专注结束提醒
  progress: false,     // 任务完成进度提醒（默认关，避免打扰）
  summary: false,      // 每日摘要（默认关）
  summaryTime: "09:00",
};

let granted = false;
const lastNotified = new Map(); // 每日/每次去重

export function getNotifPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === "object") return { ...PREFS_DEFAULTS, ...raw };
  } catch {
    /* ignore */
  }
  return { ...PREFS_DEFAULTS };
}

export function saveNotifPrefs(prefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export async function ensureGranted() {
  if (typeof window.Notification === "undefined") {
    granted = false;
    return false;
  }
  if (window.Notification.permission === "denied") {
    granted = false;
    return false;
  }
  if (window.Notification.permission === "granted") {
    granted = true;
    return true;
  }
  try {
    const p = await window.Notification.requestPermission();
    granted = p === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

export function canNotify() {
  return (
    typeof window.Notification !== "undefined" &&
    window.Notification.permission === "granted"
  );
}

// 打开系统通知设置页（Windows/macOS 支持完整；Linux 尽力而为）
export async function openNotificationSettings() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  let url = null;
  if (ua.includes("Windows")) {
    url = "ms-settings:notifications";
  } else if (ua.includes("Mac")) {
    url = "x-apple.systempreferences:com.apple.preference.notifications";
  } else if (ua.includes("Linux")) {
    url = "gnome-control-center:notifications";
  }
  if (!url) return false;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

function show(title, body) {
  if (!canNotify()) return;
  try {
    // eslint-disable-next-line no-new
    new window.Notification(title, { body, tag: `localflow-${Date.now()}` });
  } catch {
    /* 某些 webview 不支持带选项的构造，静默忽略 */
  }
}

function localYMD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayKey() {
  return localYMD();
}

// 快要超时：当天到期 / 已超时，每个任务每天只推一次
export function checkDueReminders(tasks, prefs) {
  if (!prefs || !prefs.master || !prefs.due || !canNotify()) return;
  const today = dayKey();
  for (const t of tasks) {
    if (t.status === "done" || !t.due_date) continue;
    const due = t.due_date.slice(0, 10);
    if (due === today) {
      const k = `due:${t.id}:${today}`;
      if (!lastNotified.has(k)) {
        lastNotified.set(k, true);
        show("今日截止", `「${t.title}」今天到截止日期`);
      }
    } else if (due < today) {
      const k = `overdue:${t.id}:${today}`;
      if (!lastNotified.has(k)) {
        lastNotified.set(k, true);
        show("任务已超时", `「${t.title}」已过截止日期`);
      }
    }
  }
  trim();
}

// 里程碑进度：任务完成
export function notifyTaskCompleted(title) {
  if (title) show("任务完成", `「${title}」已完成`);
}

// 专注结束
export function notifyPomodoroDone(taskTitle) {
  show("专注结束", taskTitle ? `「${taskTitle}」专注已结束` : "专注已结束");
}

// 每日摘要：在设定时间推送今日截止/超时概览，一天一次
export function checkDailySummary(tasks, prefs) {
  if (!prefs || !prefs.master || !prefs.summary || !canNotify()) return;
  const now = new Date();
  const time = prefs.summaryTime || "09:00";
  const [h, m] = time.split(":").map(Number);
  if (now.getHours() !== h || now.getMinutes() !== m) return;
  const k = `summary:${dayKey()}`;
  if (lastNotified.has(k)) return;
  const due = tasks.filter(
    (t) => t.status !== "done" && t.due_date && t.due_date.slice(0, 10) === dayKey(),
  ).length;
  const overdue = tasks.filter(
    (t) => t.status !== "done" && t.due_date && t.due_date.slice(0, 10) < dayKey(),
  ).length;
  if (due || overdue) {
    const parts = [];
    if (due) parts.push(`今天截止 ${due} 项`);
    if (overdue) parts.push(`已超时 ${overdue} 项`);
    lastNotified.set(k, true);
    show("今日代办摘要", parts.join("，"));
  }
  trim();
}

function trim() {
  // 防止长会话内存无界增长
  if (lastNotified.size > 400) {
    lastNotified.clear();
  }
}