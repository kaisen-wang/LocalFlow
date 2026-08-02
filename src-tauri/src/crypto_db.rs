//! SQLCipher（AES-256）数据库加密：元数据、开库、明文↔密文迁移。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

pub const MIN_PASSWORD_LEN: usize = 6;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EncryptionStatus {
    pub enabled: bool,
    pub unlocked: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct EncryptionMeta {
    pub enabled: bool,
}

pub struct DbState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub unlocked: AtomicBool,
    pub encrypted: AtomicBool,
    /// 仅存于内存，用于改密/关闭加密；从不写入磁盘
    pub session_key: Mutex<Option<String>>,
}

pub struct DbConnGuard<'a>(MutexGuard<'a, Connection>);

impl std::ops::Deref for DbConnGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0
    }
}

impl DbState {
    pub fn lock_conn(&self) -> Result<DbConnGuard<'_>, String> {
        if !self.unlocked.load(Ordering::SeqCst) {
            return Err("数据库未解锁，请先输入密码".into());
        }
        let guard = self.db.lock().map_err(|e| e.to_string())?;
        Ok(DbConnGuard(guard))
    }

    pub fn status(&self) -> EncryptionStatus {
        EncryptionStatus {
            enabled: self.encrypted.load(Ordering::SeqCst),
            unlocked: self.unlocked.load(Ordering::SeqCst),
        }
    }
}

pub fn db_file(data_dir: &Path) -> PathBuf {
    data_dir.join("localflow.db")
}

fn meta_file(data_dir: &Path) -> PathBuf {
    data_dir.join("encryption.json")
}

pub fn read_encryption_meta(data_dir: &Path) -> EncryptionMeta {
    let path = meta_file(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return EncryptionMeta::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn write_encryption_meta(data_dir: &Path, enabled: bool) -> Result<(), String> {
    let path = meta_file(data_dir);
    let meta = EncryptionMeta { enabled };
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!("密码至少 {MIN_PASSWORD_LEN} 个字符"));
    }
    Ok(())
}

fn escape_sql_literal(s: &str) -> String {
    s.replace('\'', "''")
}

/// 把当前连接内容导出到目标库（可带/不带密钥）
pub fn sqlcipher_export_to(conn: &Connection, dest: &Path, dest_key: &str) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| e.to_string())?;
    }
    let dest_lit = escape_sql_literal(&dest.to_string_lossy());
    let key_lit = escape_sql_literal(dest_key);
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{dest_lit}' AS exported KEY '{key_lit}';
         SELECT sqlcipher_export('exported');
         DETACH DATABASE exported;"
    ))
    .map_err(|e| format!("导出加密数据库失败: {e}"))?;
    Ok(())
}

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            due_date TEXT,
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'todo',
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            is_inbox INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_tags (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS subtasks (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_inbox ON tasks(is_inbox);
        CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(sort_order);
        CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
        CREATE TABLE IF NOT EXISTS task_attachments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
    ",
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE tasks SET is_inbox = 1 WHERE project_id IS NULL AND is_inbox = 0",
        [],
    )
    .ok();

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "completed_at") {
        conn.execute("ALTER TABLE tasks ADD COLUMN completed_at TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn open_plain_db(data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = db_file(data_dir);
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    Ok(conn)
}

pub fn open_encrypted_db(data_dir: &Path, password: &str) -> Result<Connection, String> {
    let path = db_file(data_dir);
    if !path.exists() {
        return Err("数据库文件不存在".into());
    }
    let conn = open_encrypted_at(&path, password)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// 用密钥打开任意路径的 SQLCipher 加密库（不补全 schema）
pub fn open_encrypted_at(path: &Path, password: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "key", password)
        .map_err(|e| format!("设置密钥失败: {e}"))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|_| "密码错误，或数据库已损坏".to_string())?;
    Ok(conn)
}

/// 打开任意路径的明文库（不补全 schema）
pub fn open_plain_at(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|_| "不是有效的数据库文件".to_string())?;
    Ok(conn)
}

pub fn ensure_default_project(conn: &Connection) -> Result<(), String> {
    let project_count: i32 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap_or(0);
    if project_count == 0 {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO projects (id, name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![id, "默认项目", "#4A90D9", now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 关闭当前连接占用后，用新文件替换并重新打开
pub fn swap_db_file(
    state: &DbState,
    new_file: &Path,
    encrypted: bool,
    password: Option<&str>,
) -> Result<(), String> {
    let final_path = db_file(&state.data_dir);
    {
        let mut guard = state.db.lock().map_err(|e| e.to_string())?;
        // 释放对 localflow.db 的占用
        *guard = Connection::open_in_memory().map_err(|e| e.to_string())?;
    }

    if final_path.exists() {
        let bak = state.data_dir.join("localflow.db.bak_swap");
        let _ = std::fs::remove_file(&bak);
        std::fs::rename(&final_path, &bak).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(new_file, &final_path) {
            let _ = std::fs::rename(&bak, &final_path);
            return Err(e.to_string());
        }
        let _ = std::fs::remove_file(&bak);
    } else {
        std::fs::rename(new_file, &final_path).map_err(|e| e.to_string())?;
    }

    let conn = if encrypted {
        let pw = password.ok_or_else(|| "缺少密码".to_string())?;
        open_encrypted_db(&state.data_dir, pw)?
    } else {
        open_plain_db(&state.data_dir)?
    };

    {
        let mut guard = state.db.lock().map_err(|e| e.to_string())?;
        *guard = conn;
    }
    state.encrypted.store(encrypted, Ordering::SeqCst);
    state.unlocked.store(true, Ordering::SeqCst);
    {
        let mut key = state.session_key.lock().map_err(|e| e.to_string())?;
        *key = if encrypted {
            password.map(|s| s.to_string())
        } else {
            None
        };
    }
    write_encryption_meta(&state.data_dir, encrypted)?;
    Ok(())
}

pub fn migrate_to_encrypted(state: &DbState, password: &str) -> Result<(), String> {
    validate_password(password)?;
    if state.encrypted.load(Ordering::SeqCst) {
        return Err("数据库已经加密".into());
    }
    if !state.unlocked.load(Ordering::SeqCst) {
        return Err("数据库未解锁".into());
    }

    let tmp = state.data_dir.join("localflow.db.enc_tmp");
    {
        let guard = state.lock_conn()?;
        sqlcipher_export_to(&guard, &tmp, password)?;
    }
    swap_db_file(state, &tmp, true, Some(password))?;
    ensure_default_project(&*state.lock_conn()?)?;
    Ok(())
}

pub fn migrate_to_plain(state: &DbState, password: &str) -> Result<(), String> {
    if !state.encrypted.load(Ordering::SeqCst) {
        return Err("数据库未加密".into());
    }
    if !state.unlocked.load(Ordering::SeqCst) {
        return Err("请先解锁数据库".into());
    }

    {
        let key = state.session_key.lock().map_err(|e| e.to_string())?;
        if key.as_deref() != Some(password) {
            return Err("密码错误".into());
        }
    }

    let tmp = state.data_dir.join("localflow.db.plain_tmp");
    {
        let guard = state.lock_conn()?;
        sqlcipher_export_to(&guard, &tmp, "")?;
    }
    swap_db_file(state, &tmp, false, None)?;
    ensure_default_project(&*state.lock_conn()?)?;
    Ok(())
}

pub fn rekey_database(state: &DbState, old_password: &str, new_password: &str) -> Result<(), String> {
    validate_password(new_password)?;
    if !state.encrypted.load(Ordering::SeqCst) {
        return Err("数据库未加密".into());
    }
    if !state.unlocked.load(Ordering::SeqCst) {
        return Err("请先解锁数据库".into());
    }

    {
        let key = state.session_key.lock().map_err(|e| e.to_string())?;
        if key.as_deref() != Some(old_password) {
            return Err("当前密码不正确".into());
        }
    }

    {
        let guard = state.lock_conn()?;
        guard
            .pragma_update(None, "rekey", new_password)
            .map_err(|e| format!("修改密码失败: {e}"))?;
    }

    let mut key = state.session_key.lock().map_err(|e| e.to_string())?;
    *key = Some(new_password.to_string());
    Ok(())
}

pub fn unlock_into_state(state: &DbState, password: &str) -> Result<(), String> {
    if !state.encrypted.load(Ordering::SeqCst) {
        return Err("数据库未启用加密".into());
    }
    if state.unlocked.load(Ordering::SeqCst) {
        return Ok(());
    }
    let conn = open_encrypted_db(&state.data_dir, password)?;
    ensure_default_project(&conn)?;
    {
        let mut guard = state.db.lock().map_err(|e| e.to_string())?;
        *guard = conn;
    }
    {
        let mut key = state.session_key.lock().map_err(|e| e.to_string())?;
        *key = Some(password.to_string());
    }
    state.unlocked.store(true, Ordering::SeqCst);
    Ok(())
}

/// 从备份文件恢复数据：保持当前加密模式，替换整个数据库。
/// password 用于打开加密备份（当前会话密钥会优先尝试）。
/// 返回 Err("BACKUP_ENCRYPTED") 表示需要用户提供备份密码；
/// 返回 Err("BACKUP_PASSWORD_WRONG") 表示提供的密码不正确。
pub fn restore_from_backup(
    state: &DbState,
    src: &Path,
    password: Option<&str>,
) -> Result<(), String> {
    let current_encrypted = state.encrypted.load(Ordering::SeqCst);
    let current_key = {
        let key = state.session_key.lock().map_err(|e| e.to_string())?;
        key.clone()
    };

    // 明文探测：加密库用明文连接读不到 sqlite_master
    let is_plain = Connection::open(src)
        .ok()
        .map(|conn| {
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_ok()
        })
        .unwrap_or(false);

    // 解析备份密钥
    let backup_key: Option<String> = if is_plain {
        None
    } else {
        let mut found: Option<String> = None;
        let candidates = current_key
            .clone()
            .into_iter()
            .chain(password.map(|s| s.to_string()));
        for candidate in candidates {
            if open_encrypted_at(src, &candidate).is_ok() {
                found = Some(candidate);
                break;
            }
        }
        match found {
            Some(k) => Some(k),
            None => {
                return Err(if password.is_some() {
                    "BACKUP_PASSWORD_WRONG"
                } else {
                    "BACKUP_ENCRYPTED"
                }
                .into())
            }
        }
    };

    // 打开备份源并补全结构（新列等）
    let src_conn = match &backup_key {
        Some(k) => open_encrypted_at(src, k)?,
        None => open_plain_at(src)?,
    };
    ensure_schema(&src_conn)?;

    // 转换到当前加密格式的临时文件
    let tmp = state.data_dir.join("localflow.import_tmp.db");
    let _ = std::fs::remove_file(&tmp);
    let target_key = if current_encrypted {
        current_key.as_deref().unwrap_or("")
    } else {
        ""
    };
    sqlcipher_export_to(&src_conn, &tmp, target_key)?;

    // 校验临时文件可正常打开
    if current_encrypted {
        let pw = current_key.as_deref().ok_or("缺少密钥")?;
        open_encrypted_at(&tmp, pw)
            .map_err(|e| format!("备份转换失败: {e}"))?;
    } else {
        open_plain_at(&tmp).map_err(|e| format!("备份转换失败: {e}"))?;
    }

    let swap_result = swap_db_file(state, &tmp, current_encrypted, current_key.as_deref());
    if swap_result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    swap_result?;

    let guard = state.lock_conn()?;
    ensure_default_project(&guard)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("localflow_ut_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fresh_state(app_dir: &Path, encrypted: bool) -> DbState {
        let conn = if encrypted {
            let c = Connection::open(db_file(app_dir)).unwrap();
            c.pragma_update(None, "key", "testpass123").unwrap();
            c.execute_batch(
                "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'todo', project_id TEXT, is_inbox INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);",
            )
            .unwrap();
            c
        } else {
            open_plain_db(app_dir).unwrap()
        };
        DbState {
            db: Mutex::new(conn),
            data_dir: app_dir.to_path_buf(),
            unlocked: AtomicBool::new(true),
            encrypted: AtomicBool::new(encrypted),
            session_key: Mutex::new(if encrypted {
                Some("testpass123".to_string())
            } else {
                None
            }),
        }
    }

    fn make_backup_file(dir: &Path, name: &str, encrypted: bool) -> PathBuf {
        let path = dir.join(name);
        let conn = Connection::open(&path).unwrap();
        if encrypted {
            conn.pragma_update(None, "key", "backuppass123").unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'todo', project_id TEXT, is_inbox INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
             INSERT INTO tasks (id, title) VALUES ('t1', '导入任务');",
        )
        .unwrap();
        drop(conn);
        path
    }

    fn task_count(state: &DbState) -> i64 {
        state
            .lock_conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn restore_plain_backup_into_plain_app() {
        let app_dir = temp_dir("app_plain");
        let src_dir = temp_dir("src_plain");
        let state = fresh_state(&app_dir, false);
        assert_eq!(task_count(&state), 0);

        let src = make_backup_file(&src_dir, "backup.db", false);
        restore_from_backup(&state, &src, None).unwrap();

        assert_eq!(task_count(&state), 1);
        assert!(!app_dir.join("localflow.import_tmp.db").exists());
        assert!(!state.encrypted.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&app_dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn restore_encrypted_backup_requires_password() {
        let app_dir = temp_dir("app_enc_req");
        let src_dir = temp_dir("src_enc");
        let state = fresh_state(&app_dir, false);
        let src = make_backup_file(&src_dir, "backup.db", true);

        let err = restore_from_backup(&state, &src, None).unwrap_err();
        assert_eq!(err, "BACKUP_ENCRYPTED");
        assert_eq!(task_count(&state), 0);

        restore_from_backup(&state, &src, Some("wrongpass")).unwrap_err();
        assert_eq!(task_count(&state), 0);

        restore_from_backup(&state, &src, Some("backuppass123")).unwrap();
        assert_eq!(task_count(&state), 1);
        assert!(!state.encrypted.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&app_dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn restore_plain_backup_into_encrypted_app() {
        let app_dir = temp_dir("app_enc_target");
        let src_dir = temp_dir("src_plain2");
        let state = fresh_state(&app_dir, true);
        let src = make_backup_file(&src_dir, "backup.db", false);

        restore_from_backup(&state, &src, None).unwrap();

        assert_eq!(task_count(&state), 1);
        assert!(state.encrypted.load(Ordering::SeqCst));
        // 目标库仍应为加密库：用明文无法读取
        let plain_ok = Connection::open(db_file(&app_dir))
            .and_then(|c| c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)))
            .is_ok();
        assert!(!plain_ok);
        let _ = std::fs::remove_dir_all(&app_dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }
}
