import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Encryption.css";

/** 启动时输入密码解锁加密数据库 */
export function UnlockScreen({ onUnlocked }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleUnlock(e) {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      await invoke("unlock_database", { password });
      onUnlocked();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={handleUnlock}>
        <h1 className="unlock-title">LocalFlow</h1>
        <p className="unlock-desc">数据库已加密，请输入密码后继续</p>
        <input
          className="unlock-input"
          type="password"
          placeholder="数据库密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          disabled={busy}
        />
        {error && <p className="unlock-error">{error}</p>}
        <button className="unlock-btn" type="submit" disabled={busy || !password}>
          {busy ? "解锁中…" : "解锁"}
        </button>
        <p className="unlock-hint">密码不会上传；忘记密码将无法打开已有数据</p>
      </form>
    </div>
  );
}

/** 设置里开启 / 关闭 / 改密 的小面板 */
export function EncryptionSettings({ status, onStatusChange }) {
  const [mode, setMode] = useState(null); // enable | disable | change | null
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setMode(null);
    setPassword("");
    setPassword2("");
    setOldPassword("");
    setError("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      let next;
      if (mode === "enable") {
        if (password !== password2) throw new Error("两次密码不一致");
        next = await invoke("enable_encryption", { password });
      } else if (mode === "disable") {
        next = await invoke("disable_encryption", { password });
      } else if (mode === "change") {
        if (password !== password2) throw new Error("两次新密码不一致");
        next = await invoke("change_encryption_password", {
          oldPassword,
          newPassword: password,
        });
      }
      if (next) onStatusChange(next);
      reset();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="enc-settings">
      <div className="setting-row">
        <span>数据库加密</span>
        <span className={`enc-badge ${status.enabled ? "on" : ""}`}>
          {status.enabled ? "已开启" : "未开启"}
        </span>
      </div>

      {!mode && (
        <div className="enc-actions">
          {!status.enabled ? (
            <button
              type="button"
              className="data-btn"
              onClick={() => setMode("enable")}
            >
              开启加密…
            </button>
          ) : (
            <>
              <button
                type="button"
                className="data-btn"
                onClick={() => setMode("change")}
              >
                修改密码…
              </button>
              <button
                type="button"
                className="data-btn"
                onClick={() => setMode("disable")}
              >
                关闭加密…
              </button>
            </>
          )}
        </div>
      )}

      {mode && (
        <form className="enc-form" onSubmit={handleSubmit}>
          {mode === "change" && (
            <input
              className="enc-input"
              type="password"
              placeholder="当前密码"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoFocus
            />
          )}
          <input
            className="enc-input"
            type="password"
            placeholder={mode === "change" ? "新密码（至少6位）" : "密码（至少6位）"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={mode !== "change"}
          />
          {(mode === "enable" || mode === "change") && (
            <input
              className="enc-input"
              type="password"
              placeholder="再输入一次"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
          )}
          {mode === "disable" && (
            <p className="enc-warn">关闭后数据库变为明文，请确认本机安全</p>
          )}
          {mode === "enable" && (
            <p className="enc-warn">开启后每次启动需输入密码；请务必记住密码</p>
          )}
          {error && <p className="unlock-error">{error}</p>}
          <div className="enc-form-actions">
            <button type="button" className="data-btn" onClick={reset} disabled={busy}>
              取消
            </button>
            <button type="submit" className="data-btn enc-submit" disabled={busy}>
              {busy ? "处理中…" : "确认"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
