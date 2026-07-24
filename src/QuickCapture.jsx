import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseTaskInput, formatParsePreview } from "./parseTaskInput";
import "./QuickCapture.css";

function QuickCapture() {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState("");
  const inputRef = useRef(null);
  const parsed = useMemo(() => parseTaskInput(title), [title]);
  const preview = formatParsePreview(parsed);

  function focusInput() {
    setTitle("");
    setHint("");
    setSaving(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  useEffect(() => {
    focusInput();
    const unlistenOpened = listen("quick-capture-opened", () => {
      focusInput();
    });
    return () => {
      unlistenOpened.then((fn) => fn());
    };
  }, []);

  async function hideWindow() {
    const win = getCurrentWindow();
    await win.hide();
  }

  async function saveTask() {
    const parsedNow = parseTaskInput(title);
    if (!parsedNow.title || saving) return;
    setSaving(true);
    try {
      await invoke("create_task", {
        title: parsedNow.title,
        description: null,
        dueDate: parsedNow.dueDate,
        priority: parsedNow.priority,
        projectId: null,
        tags: parsedNow.tags.length ? parsedNow.tags : null,
      });
      await emit("tasks-changed");
      setTitle("");
      await hideWindow();
    } catch (err) {
      setHint(String(err));
      setSaving(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTask();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideWindow();
    }
  }

  return (
    <div className="qc-root">
      <div className="qc-bar">
        <span className="qc-label">收集</span>
        <input
          ref={inputRef}
          className="qc-input"
          placeholder="明天交报告 #工作 !高 · Enter 保存 · Esc 关闭"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
          autoFocus
        />
      </div>
      {preview && <div className="qc-preview">将识别：{preview}</div>}
      {hint && <div className="qc-hint">{hint}</div>}
    </div>
  );
}

export default QuickCapture;
