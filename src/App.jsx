import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";

import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { parseTaskInput, formatParsePreview } from "./parseTaskInput";
import { renderMarkdown } from "./renderMarkdown";
import { playCompleteSound } from "./feedback";
import {
  PomodoroFocus,
  PomodoroMiniBar,
  POMODORO_SECONDS,
  getPomodoroRemaining,
  playPomodoroChime,
  formatTimer,
} from "./Pomodoro";
import KanbanBoard from "./Kanban";
import { UnlockScreen, EncryptionSettings } from "./Encryption";
import Select from "./Select";
import DatePicker from "./DatePicker";
import Checkbox from "./Checkbox";
import Icon from "./Icons";
import SearchOverlay from "./Search";
import "./App.css";

const VIEWS = [
  { key: "inbox", label: "收集箱", icon: "inbox" },
  { key: "today", label: "今日", icon: "today" },
  { key: "upcoming", label: "计划", icon: "upcoming" },
  { key: "someday", label: "随时", icon: "someday" },
  { key: "board", label: "看板", icon: "board" },
];

const THEME_OPTIONS = [
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
  { key: "eyecare", label: "护眼绿" },
  { key: "paper", label: "纸张黄" },
  { key: "system", label: "跟随系统" },
];

const SHORTCUT_ROWS = [
  ["Ctrl+Shift+Space", "全局快速收集"],
  ["Ctrl+F", "全局搜索"],
  ["Ctrl+Z", "撤销上一步操作"],
  ["Ctrl+1 … 5", "切换 收集箱 / 今日 / 计划 / 随时 / 看板"],
  ["j / ↓", "下一项任务"],
  ["k / ↑", "上一项任务"],
  ["Enter", "打开选中任务详情"],
  ["x / Space", "完成 / 取消完成"],
  ["n", "聚焦新建任务"],
  ["p", "开始番茄钟"],
  ["Delete", "删除选中任务"],
  ["Esc", "关闭详情 / 关闭帮助"],
  ["?", "显示 / 隐藏快捷键"],
];

const PRIORITY_LABELS = { high: "高", medium: "中", low: "低" };
const PRIORITY_COLORS = { high: "#e74c3c", medium: "#f39c12", low: "#7f8c8d" };
const PROJECT_COLORS = ["#4A90D9", "#E67E22", "#27AE60", "#8E44AD", "#E74C3C", "#16A085"];
const REPEAT_OPTIONS = [
  { value: "", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "yearly", label: "每年" },
];

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day}`;
}

function formatGroupLabel(ymd) {
  if (!ymd || ymd === "无日期") return "无日期";
  const d = new Date(`${ymd}T00:00:00`);
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`;
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) < today;
}

function toDateInputValue(dateStr) {
  if (!dateStr) return "";
  return dateStr.slice(0, 10);
}

function getStoredThemePref() {
  const saved = localStorage.getItem("localflow-theme");
  if (THEME_OPTIONS.some((t) => t.key === saved)) return saved;
  return "system";
}

function resolveTheme(pref) {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

function getStoredSoundEnabled() {
  const saved = localStorage.getItem("localflow-sound");
  if (saved === "0") return false;
  return true;
}

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function groupTasksByDue(tasks) {
  const groups = [];
  let current = null;
  for (const task of tasks) {
    const key = task.due_date ? task.due_date.slice(0, 10) : "无日期";
    if (!current || current.key !== key) {
      current = { key, label: formatGroupLabel(key), tasks: [] };
      groups.push(current);
    }
    current.tasks.push(task);
  }
  return groups;
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [tags, setTags] = useState([]);
  const [currentView, setCurrentView] = useState("inbox");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [themePref, setThemePref] = useState(getStoredThemePref);
  const [soundEnabled, setSoundEnabled] = useState(getStoredSoundEnabled);
  const [autostartOn, setAutostartOn] = useState(false);
  const [completingId, setCompletingId] = useState(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [subtasks, setSubtasks] = useState([]);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [descPreview, setDescPreview] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [pomo, setPomo] = useState(null);
  const [pomoTick, setPomoTick] = useState(0);
  const [dataMessage, setDataMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importPath, setImportPath] = useState(null);
  const [importPassword, setImportPassword] = useState("");
  const [importPasswordError, setImportPasswordError] = useState("");
  const [encStatus, setEncStatus] = useState(null); // null = 检查中
  const [bootReady, setBootReady] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const toastTimer = useRef(null);
  const taskInputRef = useRef(null);

  function notify(msg) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  }

  const selectedTask = tasks.find((t) => t.id === selectedId) || null;
  const pomoRemaining = useMemo(
    () => getPomodoroRemaining(pomo),
    [pomo, pomoTick],
  );
  const projectIdFromView = currentView.startsWith("project:")
    ? currentView.slice("project:".length)
    : null;
  const tagIdFromView = currentView.startsWith("tag:")
    ? currentView.slice("tag:".length)
    : null;
  const isContextualView = !!(projectIdFromView || tagIdFromView);
  // 用 Map 快速按 id 取项目/标签，避免渲染时线性 find
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const activeTasks = tasks.filter((t) => t.status !== "done");
  const doneTasks = tasks.filter((t) => t.status === "done");

  const parsedInput = useMemo(
    () => parseTaskInput(newTaskTitle),
    [newTaskTitle],
  );
  const parsePreview = formatParsePreview(parsedInput);

  const loadTasks = useCallback(async () => {
    const filter = currentView === "all" ? null : currentView;
    const data = await invoke("get_tasks", { filter });
    setTasks(data);
  }, [currentView]);

  const loadProjects = useCallback(async () => {
    const data = await invoke("get_projects");
    setProjects(data);
  }, []);

  const loadTags = useCallback(async () => {
    const data = await invoke("get_tags");
    setTags(data);
  }, []);

  const loadSubtasks = useCallback(async (taskId) => {
    if (!taskId) {
      setSubtasks([]);
      return;
    }
    const data = await invoke("get_subtasks", { taskId });
    setSubtasks(data);
  }, []);

  const loadAttachments = useCallback(async (taskId) => {
    if (!taskId) {
      setAttachments([]);
      return;
    }
    const data = await invoke("get_attachments", { taskId });
    setAttachments(data);
  }, []);

  useEffect(() => {
    const applied = resolveTheme(themePref);
    document.documentElement.setAttribute("data-theme", applied);
    localStorage.setItem("localflow-theme", themePref);
  }, [themePref]);

  // 「跟随系统」时监听系统主题变化
  useEffect(() => {
    if (themePref !== "system") return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.setAttribute(
        "data-theme",
        mq.matches ? "dark" : "light",
      );
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themePref]);

  useEffect(() => {
    localStorage.setItem("localflow-sound", soundEnabled ? "1" : "0");
  }, [soundEnabled]);

  useEffect(() => {
    isAutostartEnabled()
      .then(setAutostartOn)
      .catch(() => setAutostartOn(false));
  }, []);

  // 启动：检查是否需要解锁
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke("get_encryption_status");
        if (cancelled) return;
        setEncStatus(status);
        if (!status.enabled || status.unlocked) {
          setBootReady(true);
        }
      } catch {
        if (!cancelled) {
          setEncStatus({ enabled: false, unlocked: true });
          setBootReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
  }, []);

  useEffect(() => {
    if (!bootReady) return;
    loadTasks();
  }, [bootReady, loadTasks]);

  useEffect(() => {
    if (!bootReady) return;
    loadProjects();
  }, [bootReady, loadProjects]);

  useEffect(() => {
    if (!bootReady) return;
    loadTags();
  }, [bootReady, loadTags]);

  useEffect(() => {
    loadSubtasks(selectedId);
    loadAttachments(selectedId);
    setDescPreview(false);
    setNewSubtaskTitle("");
  }, [selectedId, loadSubtasks, loadAttachments]);

  // 番茄钟滴答：用 endsAt 算剩余，避免后台节流导致漂移
  useEffect(() => {
    if (!pomo || pomo.phase === "paused" || pomo.phase === "done") return undefined;
    const id = setInterval(() => {
      const left = getPomodoroRemaining(pomo);
      if (left <= 0) {
        setPomo((prev) =>
          prev && prev.phase === "running"
            ? { ...prev, phase: "done", focus: true }
            : prev,
        );
        playPomodoroChime();
      }
      setPomoTick((n) => n + 1);
    }, 250);
    return () => clearInterval(id);
  }, [pomo]);

  useEffect(() => {
    if (!pomo || pomo.phase === "done") {
      if (!pomo) document.title = "LocalFlow";
      return;
    }
    const left = getPomodoroRemaining(pomo);
    document.title = `${formatTimer(left)} · LocalFlow`;
    return () => {
      document.title = "LocalFlow";
    };
  }, [pomo, pomoTick]);

  useEffect(() => {
    const unlisten = listen("tasks-changed", () => {
      loadTasks();
      loadTags();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadTasks, loadTags]);

  useEffect(() => {
    setSelectedId(null);
  }, [currentView]);

  useEffect(() => {
    if (selectedId && !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [tasks, selectedId]);

  // 键盘优先：列表导航、视图切换、完成等（输入框内不抢键）
  useEffect(() => {
    function moveSelection(delta) {
      if (!tasks.length) return;
      const idx = tasks.findIndex((t) => t.id === selectedId);
      let next = idx < 0 ? (delta > 0 ? 0 : tasks.length - 1) : idx + delta;
      next = Math.max(0, Math.min(tasks.length - 1, next));
      setSelectedId(tasks[next].id);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (multiSelect) {
          setMultiSelect(false);
          setSelectedIds(new Set());
          return;
        }
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        if (selectedId && !isTypingTarget(e.target)) {
          setSelectedId(null);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (
        (e.key === "?" || (e.key === "/" && e.shiftKey)) &&
        !isTypingTarget(e.target) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      if (isTypingTarget(e.target)) return;
      if (pomo?.focus) return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const viewMap = {
          "1": "inbox",
          "2": "today",
          "3": "upcoming",
          "4": "someday",
          "5": "board",
        };
        if (viewMap[e.key]) {
          e.preventDefault();
          switchView(viewMap[e.key]);
          return;
        }
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        // 详情已随 selectedId 打开；再按 Enter 保持选中即可
        return;
      }
      if ((e.key === "x" || e.key === " ") && selectedId) {
        e.preventDefault();
        handleToggleTask(selectedId);
        return;
      }
      if (e.key === "n" || e.key === "c") {
        e.preventDefault();
        taskInputRef.current?.focus();
        return;
      }
      if (e.key === "p") {
        e.preventDefault();
        startPomodoro(selectedTask);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        if (window.confirm("删除该任务？")) {
          handleDeleteTask(selectedId);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers use latest via closure refresh
  }, [tasks, selectedId, showShortcuts, pomo, selectedTask, soundEnabled, multiSelect, searchOpen]);

  async function handleCreateTask() {
    const parsed = parseTaskInput(newTaskTitle);
    if (!parsed.title) return;
    const created = await invoke("create_task", {
      title: parsed.title,
      description: null,
      dueDate: parsed.dueDate,
      priority: parsed.priority,
      projectId: projectIdFromView,
      tags: parsed.tags.length ? parsed.tags : null,
    });
    setNewTaskTitle("");
    await loadTasks();
    await loadTags();
    setSelectedId(created.id);
  }

  async function handleToggleTask(id, e) {
    e?.stopPropagation();
    const task = tasks.find((t) => t.id === id);
    const willComplete = task && task.status !== "done";
    await invoke("toggle_task", { id });
    if (willComplete) {
      if (soundEnabled) playCompleteSound();
      setCompletingId(id);
      window.setTimeout(() => {
        setCompletingId((cur) => (cur === id ? null : cur));
      }, 520);
    }
    loadTasks();
  }

  async function handleAutostartToggle(next) {
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
      setAutostartOn(next);
    } catch (err) {
      setDataMessage(`开机自启设置失败：${err}`);
    }
  }

  async function handleDeleteTask(id, e) {
    e?.stopPropagation();
    await invoke("delete_task", { id });
    if (selectedId === id) setSelectedId(null);
    loadTasks();
  }

  async function patchTask(id, fields) {
    const updated = await invoke("update_task", { id, ...fields });
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    if (
      fields.projectId !== undefined ||
      fields.dueDate !== undefined ||
      fields.status !== undefined
    ) {
      await loadTasks();
    }
  }

  async function moveTaskStatus(id, status) {
    await patchTask(id, { status });
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const color = PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
    const created = await invoke("create_project", { name, color });
    setNewProjectName("");
    setAddingProject(false);
    await loadProjects();
    switchView(`project:${created.id}`);
  }

  async function handleRenameProject(id) {
    const name = editingProjectName.trim();
    if (!name) {
      setEditingProjectId(null);
      return;
    }
    await invoke("update_project", { id, name });
    setEditingProjectId(null);
    await loadProjects();
  }

  async function handleDeleteProject(id, e) {
    e?.stopPropagation();
    if (!window.confirm("删除该项目？任务会回到收集箱。")) return;
    await invoke("delete_project", { id });
    if (currentView === `project:${id}`) switchView("inbox");
    await loadProjects();
    await loadTasks();
  }

  async function handleDeleteTag(id, e) {
    e?.stopPropagation();
    if (!window.confirm("删除该标签？任务上的关联也会去掉。")) return;
    await invoke("delete_tag", { id });
    if (currentView === `tag:${id}`) switchView("inbox");
    await loadTags();
    await loadTasks();
  }

  async function handleAttachTag() {
    if (!selectedTask) return;
    const name = newTagName.trim().replace(/^#/, "");
    if (!name) return;
    const updated = await invoke("attach_tag_by_name", {
      taskId: selectedTask.id,
      name,
    });
    setNewTagName("");
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    await loadTags();
  }

  async function handleRemoveTag(tagName) {
    if (!selectedTask) return;
    const tag = tags.find((t) => t.name === tagName);
    if (!tag) return;
    const updated = await invoke("remove_task_tag", {
      taskId: selectedTask.id,
      tagId: tag.id,
    });
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    if (tagIdFromView === tag.id) {
      await loadTasks();
    }
  }

  async function handleCreateSubtask() {
    if (!selectedTask) return;
    const title = newSubtaskTitle.trim();
    if (!title) return;
    const created = await invoke("create_subtask", {
      taskId: selectedTask.id,
      title,
    });
    setNewSubtaskTitle("");
    setSubtasks((prev) => [...prev, created]);
  }

  async function handleToggleSubtask(id) {
    const updated = await invoke("toggle_subtask", { id });
    setSubtasks((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }

  async function handleDeleteSubtask(id) {
    await invoke("delete_subtask", { id });
    setSubtasks((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleAddAttachment() {
    if (!selectedTask) return;
    const selected = await open({ multiple: false });
    if (!selected) return;
    const created = await invoke("add_attachment", {
      taskId: selectedTask.id,
      filePath: selected,
    });
    setAttachments((prev) => [...prev, created]);
  }

  async function handleDeleteAttachment(attachmentId) {
    await invoke("delete_attachment", { attachmentId });
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function startPomodoro(task) {
    if (pomo && pomo.phase !== "done") {
      if (!window.confirm("已有番茄钟在进行，要重新开始吗？")) return;
    }
    const target = task || selectedTask;
    if (target && target.status !== "done") {
      await patchTask(target.id, { status: "doing" });
    }
    setPomo({
      taskId: target?.id || null,
      taskTitle: target?.title || "自由专注",
      endsAt: Date.now() + POMODORO_SECONDS * 1000,
      pausedRemaining: null,
      phase: "running",
      focus: true,
    });
  }

  function pausePomodoro() {
    setPomo((prev) => {
      if (!prev || prev.phase !== "running") return prev;
      return {
        ...prev,
        phase: "paused",
        pausedRemaining: getPomodoroRemaining(prev),
      };
    });
  }

  function resumePomodoro() {
    setPomo((prev) => {
      if (!prev || prev.phase !== "paused") return prev;
      return {
        ...prev,
        phase: "running",
        endsAt: Date.now() + prev.pausedRemaining * 1000,
        pausedRemaining: null,
      };
    });
  }

  function stopPomodoro() {
    setPomo(null);
  }

  async function completeTaskFromPomo() {
    if (pomo?.taskId) {
      await patchTask(pomo.taskId, { status: "done" });
      if (soundEnabled) playCompleteSound();
      setCompletingId(pomo.taskId);
      window.setTimeout(() => setCompletingId(null), 520);
    }
    setPomo(null);
  }

  async function handleBackupNow() {
    setBackupBusy(true);
    setDataMessage("");
    try {
      const info = await invoke("backup_now");
      setDataMessage(`已备份（保留近7份）`);
      console.info("backup:", info.path);
    } catch (err) {
      setDataMessage(`备份失败：${err}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleBackupToDir() {
    setBackupBusy(true);
    setDataMessage("");
    try {
      const dir = await open({ directory: true, multiple: false });
      if (!dir) {
        setBackupBusy(false);
        return;
      }
      const info = await invoke("backup_to_dir", { dir });
      setDataMessage(`已备份到所选文件夹`);
      console.info("backup:", info.path);
    } catch (err) {
      setDataMessage(`备份失败：${err}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function reloadAllData() {
    await Promise.all([loadTasks(), loadProjects(), loadTags()]);
    setSelectedId(null);
  }

  function openTaskFromSearch(task) {
    setSearchOpen(false);
    if (task.project_id) switchView(`project:${task.project_id}`);
    else switchView("inbox");
    setSelectedId(task.id);
  }

  async function handleUndo() {
    try {
      const applied = await invoke("undo_last");
      await reloadAllData();
      notify(applied ? "已撤销" : "没有可撤销的操作");
    } catch (err) {
      notify(`撤销失败：${err}`);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function batchToggle() {
    for (const id of selectedIds) {
      await invoke("toggle_task", { id });
    }
    setSelectedIds(new Set());
    await loadTasks();
  }

  async function batchSetField(fields) {
    await invoke("batch_update_tasks", { ids: [...selectedIds], ...fields });
    setSelectedIds(new Set());
    await reloadAllData();
  }

  async function batchDelete() {
    if (!window.confirm(`删除选中的 ${selectedIds.size} 个任务？`)) return;
    await invoke("batch_delete_tasks", { ids: [...selectedIds] });
    setSelectedIds(new Set());
    await reloadAllData();
  }

  async function batchAddTag(name) {
    const trimmed = name.trim().replace(/^#/, "");
    if (!trimmed) return;
    for (const id of selectedIds) {
      await invoke("attach_tag_by_name", { taskId: id, name: trimmed });
    }
    setSelectedIds(new Set());
    await reloadAllData();
  }

  async function runImport(path, password) {
    await invoke("import_backup", { path, password });
    await reloadAllData();
  }

  async function handleImportBackup() {
    setDataMessage("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "备份文件", extensions: ["db"] }],
    });
    if (!selected) return;
    const ok = await confirm(
      "导入将用备份文件替换当前所有数据，且无法撤销（导入前会自动生成一份当前数据备份）。确定继续吗？",
      { title: "导入备份数据", kind: "warning" },
    );
    if (!ok) return;
    setImportBusy(true);
    try {
      await runImport(selected, undefined);
      setDataMessage("导入成功");
    } catch (err) {
      const msg = String(err);
      if (msg.includes("BACKUP_ENCRYPTED")) {
        setImportPath(selected);
        setImportPassword("");
        setImportPasswordError("");
      } else {
        setDataMessage(`导入失败：${msg}`);
      }
    } finally {
      setImportBusy(false);
    }
  }

  async function handleImportSubmitPassword() {
    if (!importPath) return;
    setImportBusy(true);
    setImportPasswordError("");
    try {
      await runImport(importPath, importPassword);
      setImportPath(null);
      setImportPassword("");
      setDataMessage("导入成功");
    } catch (err) {
      const msg = String(err);
      if (msg.includes("BACKUP_PASSWORD_WRONG")) {
        setImportPasswordError("备份密码错误，请重试");
      } else {
        setImportPath(null);
        setImportPassword("");
        setDataMessage(`导入失败：${msg}`);
      }
    } finally {
      setImportBusy(false);
    }
  }

  async function handleExport(format) {
    setDataMessage("");
    try {
      const filters =
        format === "json"
          ? [{ name: "JSON", extensions: ["json"] }]
          : format === "csv"
            ? [{ name: "CSV", extensions: ["csv"] }]
            : [{ name: "Markdown", extensions: ["md"] }];
      const defaultPath =
        format === "json"
          ? "localflow-export.json"
          : format === "csv"
            ? "localflow-export.csv"
            : "localflow-export.md";
      const path = await save({ filters, defaultPath });
      if (!path) return;
      const content = await invoke("build_export", { format });
      await invoke("write_text_file", { path, content });
      setDataMessage(`已导出 ${format.toUpperCase()}`);
    } catch (err) {
      setDataMessage(`导出失败：${err}`);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      handleCreateTask();
    }
  }

  function viewTitle() {
    const view = VIEWS.find((v) => v.key === currentView);
    if (view) return view.label;
    if (projectIdFromView) {
      return projectById.get(projectIdFromView)?.name || "项目";
    }
    if (tagIdFromView) {
      const name = tagById.get(tagIdFromView)?.name;
      return name ? `#${name}` : "标签";
    }
    return "任务";
  }

  const createPlaceholder = projectIdFromView
    ? `添加到「${projectById.get(projectIdFromView)?.name || "项目"}」，可用 明天 #标签 !高`
    : "例：明天下午交报告 #工作 !高";

  function switchView(next) {
    startTransition(() => setCurrentView(next));
  }

  function renderTaskItem(task) {
    const isSelected = selectedIds.has(task.id);
    return (
      <div
        key={task.id}
        className={`task-item ${selectedId === task.id ? "selected" : ""} ${isSelected ? "multi-selected" : ""} ${completingId === task.id ? "completing" : ""}`}
        onClick={() => {
          if (multiSelect) {
            toggleSelect(task.id);
          } else {
            setSelectedId(task.id);
          }
        }}
      >
        {multiSelect && (
          <span className="multi-select-dot" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        )}
        <Checkbox
          variant="round"
          checked={task.status === "done"}
          ariaLabel={task.status === "done" ? "标为未完成" : "标为完成"}
          stopPropagation
          onChange={(_, e) => handleToggleTask(task.id, e)}
        />
        <div className="task-content">
          <span className={`task-title ${task.status === "done" ? "done" : ""}`}>
            {task.title}
          </span>
          <div className="task-meta">
            {task.due_date && (
              <span
                className={`task-due ${isOverdue(task.due_date) ? "overdue" : ""}`}
              >
                {formatDate(task.due_date)}
              </span>
            )}
            {task.project_id && (
              <span className="task-project">
                {projectById.get(task.project_id)?.name || ""}
              </span>
            )}
            {task.status === "doing" && (
              <span className="task-status-doing">进行中</span>
            )}
            {task.status === "done" && task.completed_at && (
              <span className="task-completed-at">
                完成于 {formatDate(task.completed_at)}
              </span>
            )}
            {(task.tags || []).map((name) => (
              <span key={name} className="task-tag">
                #{name}
              </span>
            ))}
          </div>
        </div>
        <span
          className="task-priority"
          style={{ color: PRIORITY_COLORS[task.priority] || "#999" }}
        >
          {PRIORITY_LABELS[task.priority] || ""}
        </span>
        <button
          className="task-delete icon-btn danger"
          onClick={(e) => handleDeleteTask(task.id, e)}
          aria-label="删除任务"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    );
  }

  const upcomingGroups =
    currentView === "upcoming" ? groupTasksByDue(tasks) : null;

  if (encStatus === null) {
    return (
      <div className="unlock-screen">
        <p className="unlock-desc">正在启动…</p>
      </div>
    );
  }

  if (encStatus.enabled && !bootReady) {
    return (
      <UnlockScreen
        onUnlocked={() => {
          setEncStatus({ enabled: true, unlocked: true });
          setBootReady(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      <div
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={async () => {
          await getCurrentWindow().toggleMaximize();
          setMaximized(await getCurrentWindow().isMaximized());
        }}
      >
        <div className="titlebar-title">
          <span className="titlebar-logo">LocalFlow</span>
          <button
            className="titlebar-btn"
            onClick={() => setSearchOpen(true)}
            title="全局搜索 (Ctrl+F)"
            aria-label="全局搜索"
          >
            <Icon name="search" size={13} />
          </button>
          <button
            className="titlebar-btn"
            onClick={handleUndo}
            title="撤销 (Ctrl+Z)"
            aria-label="撤销"
          >
            <Icon name="undo" size={13} />
          </button>
          <button
            className="titlebar-btn"
            onClick={() => setShowShortcuts(true)}
            title="快捷键 (?)"
            aria-label="快捷键帮助"
          >
            <Icon name="help" size={13} />
          </button>
        </div>
        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            onClick={() => getCurrentWindow().minimize()}
            aria-label="最小化"
          >
            <Icon name="minimize" size={12} />
          </button>
          <button
            className="titlebar-btn"
            onClick={async () => {
              await getCurrentWindow().toggleMaximize();
              setMaximized(!maximized);
            }}
            aria-label={maximized ? "最大化" : "还原"}
          >
            <Icon name={maximized ? "restore" : "maximize"} size={12} />
          </button>
          <button
            className="titlebar-btn titlebar-close"
            onClick={() => getCurrentWindow().hide()}
            aria-label="关闭"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>
      <div className="app-body">
      <aside className="sidebar">
        <nav className="nav">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`nav-item ${currentView === v.key ? "active" : ""}`}
              onClick={() => switchView(v.key)}
            >
              <span className="nav-icon">
                <Icon name={v.icon} size={16} />
              </span>
              <span>{v.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <div className="sidebar-section-title">项目</div>
            <button
              className="section-add icon-btn"
              onClick={() => setAddingProject((v) => !v)}
              title="新建项目"
              aria-label="新建项目"
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          {addingProject && (
            <div className="project-add-row">
              <input
                className="project-add-input"
                placeholder="项目名称"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateProject();
                  if (e.key === "Escape") {
                    setAddingProject(false);
                    setNewProjectName("");
                  }
                }}
                autoFocus
              />
            </div>
          )}
          {projects.map((p) =>
            editingProjectId === p.id ? (
              <div key={p.id} className="project-add-row">
                <input
                  className="project-add-input"
                  value={editingProjectName}
                  onChange={(e) => setEditingProjectName(e.target.value)}
                  onBlur={() => handleRenameProject(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameProject(p.id);
                    if (e.key === "Escape") setEditingProjectId(null);
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <div
                key={p.id}
                className={`nav-item project-row ${currentView === `project:${p.id}` ? "active" : ""}`}
                onClick={() => switchView(`project:${p.id}`)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingProjectId(p.id);
                  setEditingProjectName(p.name);
                }}
                title="双击重命名"
              >
                <span
                  className="project-dot"
                  style={{ backgroundColor: p.color || "#666" }}
                />
                <span className="project-name">{p.name}</span>
                <button
                  className="project-delete icon-btn danger"
                  onClick={(e) => handleDeleteProject(p.id, e)}
                  title="删除项目"
                  aria-label="删除项目"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ),
          )}
        </div>

        {tags.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-title">标签</div>
            {tags.map((t) => (
              <div
                key={t.id}
                className={`nav-item project-row ${currentView === `tag:${t.id}` ? "active" : ""}`}
                onClick={() => switchView(`tag:${t.id}`)}
              >
                <span className="nav-icon">
                  <Icon name="tag" size={14} />
                </span>
                <span className="project-name">{t.name}</span>
                <button
                  className="project-delete icon-btn danger"
                  onClick={(e) => handleDeleteTag(t.id, e)}
                  title="删除标签"
                  aria-label="删除标签"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="sidebar-section sidebar-data sidebar-settings">
          <div className="sidebar-section-title">设置</div>
          <label className="setting-row">
            <span>主题</span>
            <Select
              className="compact"
              ariaLabel="主题"
              value={themePref}
              options={THEME_OPTIONS.map((t) => ({
                value: t.key,
                label: t.label,
              }))}
              onChange={setThemePref}
            />
          </label>
          <label className="setting-row">
            <span>开机自启</span>
            <Checkbox
              variant="square"
              checked={autostartOn}
              ariaLabel="开机自启"
              onChange={(next) => handleAutostartToggle(next)}
            />
          </label>
          <label className="setting-row">
            <span>完成音效</span>
            <Checkbox
              variant="square"
              checked={soundEnabled}
              ariaLabel="完成音效"
              onChange={setSoundEnabled}
            />
          </label>
          {encStatus && (
            <EncryptionSettings
              status={encStatus}
              onStatusChange={(s) => {
                setEncStatus(s);
                setDataMessage(
                  s.enabled ? "数据库加密已开启（AES-256）" : "数据库加密已关闭",
                );
              }}
            />
          )}
          <p className="setting-note">关闭窗口会藏到系统托盘，托盘右键可退出</p>
        </div>

        <div className="sidebar-section sidebar-data">
          <div className="sidebar-section-title">数据</div>
          <button
            type="button"
            className="data-btn"
            disabled={backupBusy}
            onClick={handleBackupNow}
          >
            立即备份
          </button>
          <button
            type="button"
            className="data-btn"
            disabled={backupBusy}
            onClick={handleBackupToDir}
          >
            备份到文件夹…
          </button>
          <button
            type="button"
            className="data-btn"
            disabled={importBusy}
            onClick={handleImportBackup}
          >
            导入备份数据…
          </button>
          <button
            type="button"
            className="data-btn"
            onClick={() => handleExport("markdown")}
          >
            导出 Markdown
          </button>
          <button
            type="button"
            className="data-btn"
            onClick={() => handleExport("json")}
          >
            导出 JSON
          </button>
          <button
            type="button"
            className="data-btn"
            onClick={() => handleExport("csv")}
          >
            导出 CSV
          </button>
          {dataMessage && <p className="data-msg">{dataMessage}</p>}
        </div>
      </aside>

      <main className="main">
        <div className="main-header">
          <h2 className="view-title">{viewTitle()}</h2>
          {isContextualView && doneTasks.length > 0 && (
            <button
              type="button"
              className="completed-toggle"
              onClick={() => setShowCompleted((v) => !v)}
              title={showCompleted ? "隐藏已完成任务" : "显示已完成任务"}
            >
              <Icon name="check" size={12} />
              显示已完成
              <span className={`toggle-switch ${showCompleted ? "on" : ""}`} />
            </button>
          )}
          <button
            type="button"
            className={`completed-toggle ${multiSelect ? "on" : ""}`}
            onClick={() => {
              setMultiSelect((v) => !v);
              setSelectedIds(new Set());
            }}
            title={multiSelect ? "退出多选" : "进入多选，可批量操作"}
          >
            <Icon name="select" size={12} />
            多选
          </button>
          <button
            type="button"
            className="pomo-start-btn"
            onClick={() => startPomodoro(selectedTask)}
            title="开始 25 分钟番茄钟"
          >
            <Icon name="timer" size={14} />
            番茄钟
          </button>
        </div>
        {multiSelect && (
          <div className="batch-bar">
            <span className="batch-count">已选 {selectedIds.size}</span>
            <button
              type="button"
              className="batch-btn"
              onClick={batchToggle}
              disabled={!selectedIds.size}
            >
              完成/取消
            </button>
            <button
              type="button"
              className="batch-btn"
              onClick={() => batchSetField({ priority: "high" })}
              disabled={!selectedIds.size}
            >
              高优先
            </button>
            <span className="batch-select-wrap">
              <Select
                className="compact"
                ariaLabel="批量设项目"
                placeholder="批量设项目…"
                value=""
                options={[
                  { value: "", label: "移回收集箱" },
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={(v) => batchSetField({ projectId: v })}
              />
            </span>
            <button
              type="button"
              className="batch-btn danger"
              onClick={batchDelete}
              disabled={!selectedIds.size}
            >
              删除
            </button>
          </div>
        )}
        {pomo && !pomo.focus && (
          <PomodoroMiniBar
            pomo={pomo}
            remaining={pomoRemaining}
            onOpenFocus={() => setPomo((p) => (p ? { ...p, focus: true } : p))}
            onPause={pausePomodoro}
            onResume={resumePomodoro}
            onStop={stopPomodoro}
          />
        )}
        <div className="task-input-row">
          <input
            ref={taskInputRef}
            className="task-input"
            placeholder={createPlaceholder}
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {parsePreview && (
            <div className="parse-preview">将识别：{parsePreview}</div>
          )}
        </div>

        <div className={`task-list ${currentView === "board" ? "board-mode" : ""}`}>
          {currentView === "board" ? (
            <KanbanBoard
              tasks={tasks}
              projects={projects}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMoveStatus={moveTaskStatus}
              onToggle={handleToggleTask}
            />
          ) : (
            <>
              {(isContextualView ? activeTasks.length + (showCompleted ? doneTasks.length : 0) : tasks.length) === 0 && (
                <div className="empty-state">暂无任务，在上方输入框中添加吧</div>
              )}
              {upcomingGroups
                ? upcomingGroups.map((group) => (
                    <div key={group.key} className="task-group">
                      <div className="task-group-title">{group.label}</div>
                      {group.tasks.map(renderTaskItem)}
                    </div>
                  ))
                : isContextualView
                  ? (
                    <>
                      {activeTasks.map(renderTaskItem)}
                      {showCompleted && doneTasks.length > 0 && (
                        <div className="task-group">
                          <button
                            type="button"
                            className="task-group-toggle"
                            onClick={() => setDoneCollapsed((v) => !v)}
                            aria-expanded={!doneCollapsed}
                          >
                            <Icon
                              name={doneCollapsed ? "chevronRight" : "chevronDown"}
                              size={12}
                            />
                            <span>已完成</span>
                            <span className="done-count">{doneTasks.length}</span>
                          </button>
                          {!doneCollapsed && doneTasks.map(renderTaskItem)}
                        </div>
                      )}
                    </>
                  )
                  : tasks.map(renderTaskItem)}
            </>
          )}
        </div>
      </main>

      {selectedTask && (
        <aside className="detail-panel">
          <div className="detail-header">
            <span className="detail-label">任务详情</span>
            <button
              className="detail-close icon-btn"
              onClick={() => setSelectedId(null)}
              aria-label="关闭详情"
            >
              <Icon name="close" size={14} />
            </button>
          </div>

          <label className="field">
            <span className="field-label">标题</span>
            <input
              className="field-input"
              value={selectedTask.title}
              onChange={(e) => {
                const title = e.target.value;
                setTasks((prev) =>
                  prev.map((t) =>
                    t.id === selectedTask.id ? { ...t, title } : t,
                  ),
                );
              }}
              onBlur={(e) => {
                const title = e.target.value.trim();
                if (!title) {
                  loadTasks();
                  return;
                }
                patchTask(selectedTask.id, { title });
              }}
            />
          </label>

          <div className="field">
            <div className="field-label-row">
              <span className="field-label">描述</span>
              <button
                type="button"
                className="field-toggle"
                onClick={() => setDescPreview((v) => !v)}
              >
                {descPreview ? "编辑" : "预览"}
              </button>
            </div>
            {descPreview ? (
              <div
                className="markdown-preview"
                dangerouslySetInnerHTML={{
                  __html:
                    renderMarkdown(selectedTask.description || "") ||
                    "<p class='md-empty'>暂无内容</p>",
                }}
              />
            ) : (
              <textarea
                className="field-textarea"
                rows={5}
                placeholder={"支持 Markdown：\n**粗体** *斜体* `代码`\n- 列表项"}
                value={selectedTask.description || ""}
                onChange={(e) => {
                  const description = e.target.value;
                  setTasks((prev) =>
                    prev.map((t) =>
                      t.id === selectedTask.id ? { ...t, description } : t,
                    ),
                  );
                }}
                onBlur={(e) =>
                  patchTask(selectedTask.id, { description: e.target.value })
                }
              />
            )}
          </div>

          <div className="field">
            <span className="field-label">
              子任务
              {subtasks.length > 0 && (
                <span className="subtask-progress">
                  {" "}
                  {subtasks.filter((s) => s.done).length}/{subtasks.length}
                </span>
              )}
            </span>
            <div className="subtask-list">
              {subtasks.map((s) => (
                <div key={s.id} className="subtask-item">
                  <Checkbox
                    variant="round"
                    checked={s.done}
                    ariaLabel={s.done ? "取消完成子任务" : "完成子任务"}
                    onChange={() => handleToggleSubtask(s.id)}
                  />
                  <span className={`subtask-title ${s.done ? "done" : ""}`}>
                    {s.title}
                  </span>
                  <button
                    type="button"
                    className="subtask-delete icon-btn danger"
                    onClick={() => handleDeleteSubtask(s.id)}
                    aria-label="删除子任务"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
            <input
              className="field-input"
              placeholder="添加子任务，回车确认"
              value={newSubtaskTitle}
              onChange={(e) => setNewSubtaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreateSubtask();
                }
              }}
            />
          </div>

          <div className="field">
            <span className="field-label">截止日期</span>
            <DatePicker
              value={toDateInputValue(selectedTask.due_date)}
              onChange={(dueDate) =>
                patchTask(selectedTask.id, { dueDate: dueDate || "" })
              }
            />
          </div>

          <div className="field">
            <span className="field-label">优先级</span>
            <Select
              ariaLabel="优先级"
              value={selectedTask.priority || "medium"}
              options={[
                { value: "high", label: "高", color: PRIORITY_COLORS.high },
                { value: "medium", label: "中", color: PRIORITY_COLORS.medium },
                { value: "low", label: "低", color: PRIORITY_COLORS.low },
              ]}
              onChange={(priority) =>
                patchTask(selectedTask.id, { priority })
              }
            />
          </div>

          <div className="field">
            <span className="field-label">重复</span>
            <Select
              ariaLabel="重复"
              value={selectedTask.repeat_interval || ""}
              options={REPEAT_OPTIONS}
              onChange={(interval) =>
                patchTask(selectedTask.id, { repeatInterval: interval })
              }
            />
            <p className="field-hint">设为重复后，完成任务会自动生成下一周期</p>
          </div>

          <div className="field">
            <span className="field-label">所属项目</span>
            <Select
              ariaLabel="所属项目"
              value={selectedTask.project_id || ""}
              options={[
                { value: "", label: "收集箱（无项目）" },
                ...projects.map((p) => ({
                  value: p.id,
                  label: p.name,
                  color: p.color || "#666",
                })),
              ]}
              onChange={(projectId) =>
                patchTask(selectedTask.id, { projectId })
              }
            />
          </div>

          <div className="field">
            <span className="field-label">标签</span>
            <div className="detail-tags">
              {(selectedTask.tags || []).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="detail-tag"
                  onClick={() => handleRemoveTag(name)}
                  title="点击移除"
                >
                  #{name} ×
                </button>
              ))}
            </div>
            <div className="tag-add-row">
              <input
                className="field-input"
                placeholder="输入标签名，回车添加"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAttachTag();
                  }
                }}
              />
            </div>
          </div>

          <div className="field">
            <div className="field-label-row">
              <span className="field-label">附件</span>
              <button
                type="button"
                className="field-toggle"
                onClick={handleAddAttachment}
              >
                + 添加
              </button>
            </div>
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="attachment-item"
                    onDoubleClick={() =>
                      invoke("open_attachment_file", { path: a.stored_path })
                    }
                    title="双击打开"
                  >
                    <svg
                      className="attachment-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 14.5a4 4 0 0 1-2.8-1.2 4 4 0 0 1 0-5.6L9 0.8a3 3 0 0 1 4.2 4.2l-6 6a2 2 0 0 1-2.8-2.8l5-5" />
                    </svg>
                    <span className="attachment-name">{a.file_name}</span>
                    <span className="attachment-size">
                      {formatFileSize(a.file_size)}
                    </span>
                    <button
                      type="button"
                      className="attachment-delete icon-btn danger"
                      onClick={() => handleDeleteAttachment(a.id)}
                      aria-label="删除附件"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="detail-actions">
            {selectedTask.status !== "done" && (
              <button
                className="btn-secondary"
                onClick={() => startPomodoro(selectedTask)}
              >
                开始番茄钟
              </button>
            )}
            <button
              className="btn-secondary"
              onClick={(e) => handleToggleTask(selectedTask.id, e)}
            >
              {selectedTask.status === "done" ? "标为未完成" : "标为完成"}
            </button>
            <button
              className="btn-danger"
              onClick={(e) => handleDeleteTask(selectedTask.id, e)}
            >
              删除任务
            </button>
          </div>
        </aside>
      )}
      </div>

      {pomo?.focus && (
        <PomodoroFocus
          pomo={pomo}
          remaining={pomoRemaining}
          onPause={pausePomodoro}
          onResume={resumePomodoro}
          onStop={stopPomodoro}
          onExitFocus={() =>
            setPomo((p) => (p ? { ...p, focus: false } : p))
          }
          onCompleteTask={completeTaskFromPomo}
          onDismissDone={stopPomodoro}
        />
      )}

      {showShortcuts && (
        <div
          className="shortcuts-overlay"
          onClick={() => setShowShortcuts(false)}
          role="presentation"
        >
          <div
            className="shortcuts-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="键盘快捷键"
          >
            <div className="shortcuts-header">
              <h3>键盘快捷键</h3>
              <button
                type="button"
                className="detail-close icon-btn"
                onClick={() => setShowShortcuts(false)}
                aria-label="关闭"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <ul className="shortcuts-list">
              {SHORTCUT_ROWS.map(([keys, desc]) => (
                <li key={keys}>
                  <kbd>{keys}</kbd>
                  <span>{desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {importPath && (
        <div
          className="shortcuts-overlay"
          onClick={() => !importBusy && setImportPath(null)}
          role="presentation"
        >
          <div
            className="shortcuts-panel import-password-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="输入备份密码"
          >
            <div className="shortcuts-header">
              <h3>导入备份数据</h3>
              <button
                type="button"
                className="detail-close icon-btn"
                disabled={importBusy}
                onClick={() => setImportPath(null)}
                aria-label="关闭"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <p className="import-password-desc">
              该备份文件已加密，请输入备份时的密码
            </p>
            <input
              type="password"
              className="task-input"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !importBusy) {
                  handleImportSubmitPassword();
                }
              }}
              placeholder="备份密码"
              autoFocus
            />
            {importPasswordError && (
              <p className="data-msg import-password-error">
                {importPasswordError}
              </p>
            )}
            <div className="shortcuts-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={importBusy}
                onClick={() => setImportPath(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={importBusy || !importPassword}
                onClick={handleImportSubmitPassword}
              >
                {importBusy ? "导入中…" : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenTask={openTaskFromSearch}
      />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export default App;
