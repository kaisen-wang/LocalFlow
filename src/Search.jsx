import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icons";
import "./Search.css";

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function SearchOverlay({ open, onClose, onOpenTask }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    requestAnimationFrame(() => inputRef.current?.focus());
    // 关闭时清理
    return () => clearTimeout(timer.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    clearTimeout(timer.current);
    if (!q) {
      setResults([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        const data = await invoke("search_tasks", { query: q });
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 180);
  }, [query, open]);

  if (!open) return null;

  function openFirst() {
    if (results.length) onOpenTask(results[0]);
  }

  return (
    <div
      className="search-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="search-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="全局搜索"
      >
        <div className="search-input-row">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索任务标题 / 描述 / 标签… 按 Enter 打开第一条，Esc 关闭"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openFirst();
              if (e.key === "Escape") onClose();
            }}
          />
          <button
            type="button"
            className="detail-close icon-btn"
            onClick={onClose}
            aria-label="关闭搜索"
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className="search-results">
          {busy && <p className="search-status">搜索中…</p>}
          {!busy && query.trim() !== "" && results.length === 0 && (
            <p className="search-status">无匹配结果</p>
          )}
          {!busy && results.map((task) => (
            <button
              key={task.id}
              type="button"
              className="search-result"
              onClick={() => onOpenTask(task)}
            >
              <span className={`search-result-title ${task.status === "done" ? "done" : ""}`}>
                {task.title}
              </span>
              <span className="search-result-meta">
                {task.due_date && (
                  <span className={`search-result-date ${task.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10) && task.status !== "done" ? "overdue" : ""}`}>
                    {formatDate(task.due_date)}
                  </span>
                )}
                {task.status === "done" && <span className="search-status-done">已完成</span>}
                {(task.tags || []).map((name) => (
                  <span key={name} className="task-tag">#{name}</span>
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}