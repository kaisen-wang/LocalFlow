/**
 * 解析快速输入：标题 + 日期 + 优先级 + 标签
 * 例：明天下午3点交报告 #工作 !高
 */

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" };

const PRIORITY_MAP = {
  高: "high",
  中: "medium",
  低: "low",
  high: "high",
  medium: "medium",
  low: "low",
  p1: "high",
  p2: "medium",
  p3: "low",
};

const WEEKDAY_MAP = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatYmd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** weekday: 0=周日 … 6=周六；preferNextWeek 时跳过本周 */
function nextWeekday(from, weekday, preferNextWeek) {
  const base = startOfDay(from);
  const current = base.getDay();
  let delta = (weekday - current + 7) % 7;
  if (preferNextWeek) {
    delta = delta === 0 ? 7 : delta + 7;
  }
  return addDays(base, delta);
}

/**
 * @param {string} raw
 * @returns {{ title: string, dueDate: string|null, priority: string|null, tags: string[] }}
 */
export function parseTaskInput(raw) {
  let text = (raw || "").trim();
  let dueDate = null;
  let priority = null;
  const tags = [];

  if (!text) {
    return { title: "", dueDate: null, priority: null, tags: [] };
  }

  text = text.replace(/(?:^|\s)!(高|中|低|high|medium|low|p[123])(?=\s|$)/gi, (_, p) => {
    const key = p.toLowerCase();
    priority = PRIORITY_MAP[key] || PRIORITY_MAP[p] || priority;
    return " ";
  });

  text = text.replace(/(?:^|\s)#([\u4e00-\u9fa5\w-]+)/g, (_, name) => {
    if (!tags.includes(name)) tags.push(name);
    return " ";
  });

  const today = startOfDay();

  text = text.replace(/下周([一二三四五六日天])/g, (match, w) => {
    const wd = WEEKDAY_MAP[w];
    if (wd === undefined) return match;
    dueDate = formatYmd(nextWeekday(today, wd, true));
    return " ";
  });

  text = text.replace(/(?:本周|周|星期)([一二三四五六日天])/g, (match, w) => {
    const wd = WEEKDAY_MAP[w];
    if (wd === undefined) return match;
    let d = nextWeekday(today, wd, false);
    if (d < today) d = addDays(d, 7);
    dueDate = formatYmd(d);
    return " ";
  });

  text = text.replace(/今天|今日/g, () => {
    dueDate = formatYmd(today);
    return " ";
  });
  text = text.replace(/明天|明日/g, () => {
    dueDate = formatYmd(addDays(today, 1));
    return " ";
  });
  text = text.replace(/后天/g, () => {
    dueDate = formatYmd(addDays(today, 2));
    return " ";
  });

  // 去掉残余时间短语（下午3点 等），MVP 只保留日期
  text = text.replace(
    /(?:早上|上午|中午|下午|晚上|傍晚)?\d{1,2}\s*[点时](?:\d{1,2}\s*分?)?/g,
    " ",
  );

  const title = text.replace(/\s+/g, " ").trim();
  return { title, dueDate, priority, tags };
}

/** 输入框下方预览 */
export function formatParsePreview(parsed) {
  if (!parsed?.title) return "";
  const bits = [];
  if (parsed.dueDate) bits.push(parsed.dueDate);
  if (parsed.priority) bits.push(`!${PRIORITY_LABEL[parsed.priority]}`);
  if (parsed.tags.length) bits.push(parsed.tags.map((t) => `#${t}`).join(" "));
  return bits.join(" · ");
}
