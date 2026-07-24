import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icons";
import "./DatePicker.css";

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function pad(n) {
  return String(n).padStart(2, "0");
}

function toYmd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(ymd) {
  if (!ymd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function buildCells(viewMonth) {
  const first = startOfMonth(viewMonth);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    cells.push(day);
  }
  return cells;
}

function formatDisplay(ymd) {
  const d = parseYmd(ymd);
  if (!d) return "未设置";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 自定义日历：跟主题色一致，可清空 / 跳到今天。 */
export default function DatePicker({ value = "", onChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState(null);
  const initial = parseYmd(value) || new Date();
  const [view, setView] = useState(() => startOfMonth(initial));
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const todayYmd = toYmd(new Date());
  const selectedYmd = value ? value.slice(0, 10) : "";

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPanelStyle(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 320 && rect.top > spaceBelow;
    setPanelStyle({
      position: "fixed",
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      top: openUp ? undefined : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
      zIndex: 80,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const d = parseYmd(value);
    if (d) setView(startOfMonth(d));
    function onDoc(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, value]);

  const cells = useMemo(() => buildCells(view), [view]);
  const title = `${view.getFullYear()}年${view.getMonth() + 1}月`;

  function shiftMonth(delta) {
    setView((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  return (
    <div className={`lf-date ${open ? "open" : ""} ${className}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="lf-date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selectedYmd ? "" : "lf-date-placeholder"}>
          {formatDisplay(selectedYmd)}
        </span>
        <span className="lf-date-icon" aria-hidden>
          <Icon name="calendar" size={13} />
        </span>
      </button>

      {open && panelStyle && (
        <div
          className="lf-date-panel lf-date-panel-fixed"
          role="dialog"
          aria-label="选择日期"
          style={panelStyle}
        >
          <div className="lf-date-header">
            <button
              type="button"
              className="lf-date-nav"
              onClick={() => shiftMonth(-1)}
              aria-label="上一个月"
            >
              <Icon name="chevronLeft" size={14} />
            </button>
            <span className="lf-date-title">{title}</span>
            <button
              type="button"
              className="lf-date-nav"
              onClick={() => shiftMonth(1)}
              aria-label="下一个月"
            >
              <Icon name="chevronRight" size={14} />
            </button>
          </div>

          <div className="lf-date-week">
            {WEEK_LABELS.map((w) => (
              <span key={w} className="lf-date-week-label">
                {w}
              </span>
            ))}
          </div>

          <div className="lf-date-grid">
            {cells.map((day) => {
              const ymd = toYmd(day);
              const inMonth = day.getMonth() === view.getMonth();
              const isSelected = ymd === selectedYmd;
              const isToday = ymd === todayYmd;
              return (
                <button
                  key={ymd}
                  type="button"
                  className={[
                    "lf-date-cell",
                    inMonth ? "" : "muted",
                    isSelected ? "selected" : "",
                    isToday ? "today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    onChange(ymd);
                    setOpen(false);
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div className="lf-date-footer">
            <button
              type="button"
              className="lf-date-action"
              onClick={() => {
                onChange(todayYmd);
                setOpen(false);
              }}
            >
              今天
            </button>
            <button
              type="button"
              className="lf-date-action"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
