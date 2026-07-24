import { useEffect } from "react";
import "./Pomodoro.css";

export const POMODORO_SECONDS = 25 * 60;

export function formatTimer(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function getPomodoroRemaining(pomo) {
  if (!pomo) return 0;
  if (pomo.phase === "paused") return pomo.pausedRemaining;
  if (pomo.phase === "done") return 0;
  return Math.max(0, Math.ceil((pomo.endsAt - Date.now()) / 1000));
}

export function playPomodoroChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.stop(ctx.currentTime + 0.8);
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // 忽略无音频环境
  }
}

/** 专注全屏层 */
export function PomodoroFocus({
  pomo,
  remaining,
  onPause,
  onResume,
  onStop,
  onExitFocus,
  onCompleteTask,
  onDismissDone,
}) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (pomo.phase === "done") onDismissDone();
        else onExitFocus();
      } else if (e.key === " " && pomo.phase !== "done") {
        e.preventDefault();
        if (pomo.phase === "paused") onResume();
        else onPause();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pomo.phase, onPause, onResume, onExitFocus, onDismissDone]);

  const progress =
    POMODORO_SECONDS === 0
      ? 0
      : ((POMODORO_SECONDS - remaining) / POMODORO_SECONDS) * 100;

  return (
    <div className="pomo-focus">
      <div className="pomo-focus-inner">
        <p className="pomo-kicker">专注模式 · 25 分钟</p>
        <h2 className="pomo-task">
          {pomo.taskTitle || "自由专注"}
        </h2>
        <div className="pomo-ring" style={{ "--pomo-progress": `${progress}%` }}>
          <div className="pomo-time">
            {pomo.phase === "done" ? "完成" : formatTimer(remaining)}
          </div>
        </div>

        {pomo.phase === "done" ? (
          <div className="pomo-actions">
            {pomo.taskId && (
              <button className="pomo-btn primary" onClick={onCompleteTask}>
                完成任务
              </button>
            )}
            <button className="pomo-btn" onClick={onDismissDone}>
              关闭
            </button>
          </div>
        ) : (
          <div className="pomo-actions">
            {pomo.phase === "paused" ? (
              <button className="pomo-btn primary" onClick={onResume}>
                继续
              </button>
            ) : (
              <button className="pomo-btn" onClick={onPause}>
                暂停
              </button>
            )}
            <button className="pomo-btn" onClick={onExitFocus}>
              退出专注界面
            </button>
            <button className="pomo-btn danger" onClick={onStop}>
              结束番茄钟
            </button>
          </div>
        )}
        <p className="pomo-hint">空格暂停/继续 · Esc 退出界面</p>
      </div>
    </div>
  );
}

/** 非专注时的迷你条 */
export function PomodoroMiniBar({
  pomo,
  remaining,
  onOpenFocus,
  onPause,
  onResume,
  onStop,
}) {
  if (!pomo || pomo.phase === "done") return null;
  return (
    <div className="pomo-mini">
      <button type="button" className="pomo-mini-main" onClick={onOpenFocus}>
        <span className="pomo-mini-time">{formatTimer(remaining)}</span>
        <span className="pomo-mini-title">
          {pomo.phase === "paused" ? "已暂停 · " : ""}
          {pomo.taskTitle || "自由专注"}
        </span>
      </button>
      <div className="pomo-mini-actions">
        {pomo.phase === "paused" ? (
          <button type="button" onClick={onResume}>
            继续
          </button>
        ) : (
          <button type="button" onClick={onPause}>
            暂停
          </button>
        )}
        <button type="button" onClick={onStop}>
          结束
        </button>
      </div>
    </div>
  );
}
