mod crypto_db;

use crypto_db::{
    ensure_default_project, migrate_to_encrypted, migrate_to_plain, open_plain_db, rekey_database,
    read_encryption_meta, unlock_into_state, DbState, EncryptionStatus,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_tags_is_batched_across_tasks() {
        let conn = Connection::open_in_memory().unwrap();
        crypto_db::ensure_schema(&conn).unwrap();
        let db = conn;
        let t1 = create_task_raw(&db, "t1", &["工作", "紧急"]);
        let t2 = create_task_raw(&db, "t2", &["工作"]);
        let mut tasks = vec![t1.clone(), t2.clone()];
        attach_tags(&db, &mut tasks).unwrap();
        assert_eq!(tasks[0].tags, vec!["工作", "紧急"]);
        assert_eq!(tasks[1].tags, vec!["工作"]);
    }

    #[test]
    fn attach_tags_empty_is_noop() {
        let conn = Connection::open_in_memory().unwrap();
        let mut tasks: Vec<Task> = vec![];
        attach_tags(&conn, &mut tasks).unwrap();
    }

    #[test]
    fn touch_task_bumps_updated_at() {
        let conn = Connection::open_in_memory().unwrap();
        crypto_db::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks (id, title, updated_at) VALUES ('t', 'x', '2026-01-01T00:00:00')",
            [],
        )
        .unwrap();
        touch_task(&conn, "t", "2026-02-02T00:00:00").unwrap();
        let updated: String = conn
            .query_row("SELECT updated_at FROM tasks WHERE id='t'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(updated, "2026-02-02T00:00:00");
    }

    #[test]
    fn ensure_schema_records_version_and_upgrades_old_db() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟旧库：完整 tasks 结构只缺 completed_at，user_version=0
        conn.execute(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                due_date TEXT,
                priority TEXT NOT NULL DEFAULT 'medium',
                status TEXT NOT NULL DEFAULT 'todo',
                project_id TEXT,
                is_inbox INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )
        .unwrap();
        crypto_db::ensure_schema(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 2);
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(tasks)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(cols.contains(&"completed_at".to_string()), "缺列未补齐: {cols:?}");
        assert!(cols.contains(&"repeat_interval".to_string()), "重复列未补齐: {cols:?}");
        // 幂等：再跑一次不应报错，版本保持 2
        crypto_db::ensure_schema(&conn).unwrap();
        let v2: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, 2);
    }

    #[test]
    fn next_due_date_advances_by_interval() {
        assert_eq!(next_due_date("daily", "2026-01-31").as_deref(), Some("2026-02-01"));
        assert_eq!(next_due_date("weekly", "2026-07-23").as_deref(), Some("2026-07-30"));
        assert_eq!(next_due_date("monthly", "2026-01-31").as_deref(), Some("2026-02-28"));
        assert_eq!(next_due_date("yearly", "2024-02-29").as_deref(), Some("2025-02-28"));
        assert_eq!(next_due_date("unknown", "2026-01-01"), None);
        assert_eq!(next_due_date("weekly", "bad-date"), None);
    }

    #[test]
    fn search_tasks_matches_title_and_tag() {
        let conn = Connection::open_in_memory().unwrap();
        crypto_db::ensure_schema(&conn).unwrap();
        let t1 = create_task_raw(&conn, "t1", &["工作"]);
        let t2 = create_task_raw(&conn, "t2", &["个人"]);
        conn.execute("UPDATE tasks SET title = '买牛奶' WHERE id = 't1'", [])
            .unwrap();
        let db = conn;

        let empty = run_search(&db, "   ").unwrap();
        assert!(empty.is_empty());

        let mut matched = run_search(&db, "牛奶").unwrap();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].id, t1.id);

        // 标签名命中
        matched = run_search(&db, "工作").unwrap();
        assert_eq!(matched[0].id, t1.id);
        matched = run_search(&db, "个人").unwrap();
        assert_eq!(matched[0].id, t2.id);
    }

    fn run_search(db: &Connection, q: &str) -> Result<Vec<Task>, String> {
        search_tasks_impl(db, q)
    }

    fn create_task_raw(conn: &Connection, id: &str, tags: &[&str]) -> Task {
        conn.execute(
            "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, ?2, '2026-01-01', '2026-01-01')",
            rusqlite::params![id, "t"],
        )
        .unwrap();
        for name in tags {
            let tag_id: String = conn
                .query_row("SELECT id FROM tags WHERE name=?1", rusqlite::params![name], |r| {
                    r.get(0)
                })
                .unwrap_or_else(|_| {
                    let nid = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, '2026-01-01')",
                        rusqlite::params![nid, name],
                    )
                    .unwrap();
                    nid
                });
            conn.execute(
                "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![id, tag_id],
            )
            .unwrap();
        }
        fetch_task(conn, id).unwrap()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    pub priority: String,
    pub status: String,
    pub project_id: Option<String>,
    pub is_inbox: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub repeat_interval: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Subtask {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub done: bool,
    pub sort_order: i32,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskAttachment {
    pub id: String,
    pub task_id: String,
    pub file_name: String,
    pub stored_path: String,
    pub file_size: i64,
    pub created_at: String,
}

fn init_schema_and_conn(app_data_dir: &std::path::Path) -> Connection {
    open_plain_db(app_data_dir).expect("failed to open database")
}

fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn prune_backups(dir: &Path, keep: usize) -> Result<(), String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("localflow_") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();

    files.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });

    for old in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(old.path());
    }
    Ok(())
}

fn copy_db_backup(state: &DbState, dest: &Path) -> Result<(), String> {
    // 先把 WAL 内容 checkpoint 进主库文件，确保备份完整（WAL 模式下仅复制主文件可能丢失最新数据）
    {
        let db = state.lock_conn()?;
        db.execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(|e| e.to_string())?;
    }
    let src = crypto_db::db_file(&state.data_dir);
    if !src.exists() {
        return Err("database file not found".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn create_rolling_backup(state: &DbState) -> Result<String, String> {
    let dir = backups_dir(&state.data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let dest = dir.join(format!("localflow_{}.db", stamp));
    copy_db_backup(state, &dest)?;
    prune_backups(&dir, 7)?;
    Ok(dest.to_string_lossy().to_string())
}

fn has_backup_today(data_dir: &Path) -> bool {
    let dir = backups_dir(data_dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|e| {
        e.file_name()
            .to_string_lossy()
            .contains(&format!("localflow_{}", today))
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupInfo {
    pub path: String,
    pub created_at: String,
}

#[tauri::command]
fn backup_now(state: tauri::State<DbState>) -> Result<BackupInfo, String> {
    let path = create_rolling_backup(&state)?;
    Ok(BackupInfo {
        path,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

#[tauri::command]
fn backup_to_dir(dir: String, state: tauri::State<DbState>) -> Result<BackupInfo, String> {
    if dir.trim().is_empty() {
        return Err("备份目录不能为空".into());
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let dest = PathBuf::from(&dir).join(format!("localflow_{}.db", stamp));
    copy_db_backup(&state, &dest)?;
    Ok(BackupInfo {
        path: dest.to_string_lossy().to_string(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

#[tauri::command]
fn list_backups(state: tauri::State<DbState>) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&state.data_dir);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut items: Vec<BackupInfo> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !(name.starts_with("localflow_") && name.ends_with(".db")) {
                return None;
            }
            let modified = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.format("%Y-%m-%d %H:%M:%S").to_string()
                })
                .unwrap_or_default();
            Some(BackupInfo {
                path: path.to_string_lossy().to_string(),
                created_at: modified,
            })
        })
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

#[tauri::command]
fn import_backup(
    path: String,
    password: Option<String>,
    state: tauri::State<DbState>,
) -> Result<(), String> {
    let src = PathBuf::from(&path);
    if path.trim().is_empty() {
        return Err("备份路径不能为空".into());
    }
    if !src.exists() {
        return Err("备份文件不存在".into());
    }

    // 导入前先为当前数据留一份备份（安全网）
    let _ = create_rolling_backup(&state);

    crypto_db::restore_from_backup(&state, &src, password.as_deref())
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[tauri::command]
fn build_export(format: String, state: tauri::State<DbState>) -> Result<String, String> {
    let db = state.lock_conn()?;
    let mut tasks = {
        let mut stmt = db
            .prepare("SELECT * FROM tasks ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows: Vec<Task> = stmt
            .query_map([], map_task_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    attach_tags(&db, &mut tasks)?;

    let projects: Vec<Project> = {
        let mut stmt = db
            .prepare("SELECT * FROM projects ORDER BY sort_order, created_at ASC")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    let project_by_id: std::collections::HashMap<&str, &Project> =
        projects.iter().map(|p| (p.id.as_str(), p)).collect();

    let tags: Vec<Tag> = {
        let mut stmt = db
            .prepare("SELECT * FROM tags ORDER BY name ASC")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    match format.as_str() {
        "json" => {
            let payload = serde_json::json!({
                "exported_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
                "projects": projects,
                "tags": tags,
                "tasks": tasks,
            });
            serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())
        }
        "csv" => {
            let mut out = String::from(
                "id,title,status,priority,due_date,project,tags,description,created_at\n",
            );
            for task in &tasks {
                let project_name = task
                    .project_id
                    .as_ref()
                    .and_then(|pid| project_by_id.get(pid.as_str()))
                    .map(|p| p.name.as_str())
                    .unwrap_or("");
                let tag_str = task.tags.join("|");
                out.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{}\n",
                    csv_escape(&task.id),
                    csv_escape(&task.title),
                    csv_escape(&task.status),
                    csv_escape(&task.priority),
                    csv_escape(task.due_date.as_deref().unwrap_or("")),
                    csv_escape(project_name),
                    csv_escape(&tag_str),
                    csv_escape(&task.description),
                    csv_escape(&task.created_at),
                ));
            }
            Ok(out)
        }
        "markdown" => {
            let mut out = String::from("# LocalFlow Export\n\n");
            out.push_str(&format!(
                "导出时间：{}\n\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ));

            let mut unassigned: Vec<&Task> =
                tasks.iter().filter(|t| t.project_id.is_none()).collect();
            if !unassigned.is_empty() {
                out.push_str("## 收集箱 / 未归类\n\n");
                for task in unassigned.drain(..) {
                    append_task_markdown(&mut out, task);
                }
            }

            for project in &projects {
                let mut project_tasks: Vec<&Task> = tasks
                    .iter()
                    .filter(|t| t.project_id.as_deref() == Some(project.id.as_str()))
                    .collect();
                if project_tasks.is_empty() {
                    continue;
                }
                out.push_str(&format!("## {}\n\n", project.name));
                for task in project_tasks.drain(..) {
                    append_task_markdown(&mut out, task);
                }
            }
            Ok(out)
        }
        _ => Err("unsupported export format".into()),
    }
}

fn append_task_markdown(out: &mut String, task: &Task) {
    let check = if task.status == "done" { "x" } else { " " };
    out.push_str(&format!("- [{}] **{}**", check, task.title));
    if !task.priority.is_empty() {
        out.push_str(&format!(" · 优先级:{}", task.priority));
    }
    if let Some(due) = &task.due_date {
        out.push_str(&format!(" · 截止:{}", due));
    }
    if !task.tags.is_empty() {
        out.push_str(&format!(
            " · {}",
            task.tags
                .iter()
                .map(|t| format!("#{}", t))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    out.push('\n');
    if !task.description.trim().is_empty() {
        out.push_str(&format!("  {}\n", task.description.replace('\n', "\n  ")));
    }
    out.push('\n');
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径不能为空".into());
    }
    if path.len() > 4096 || content.len() > 256 * 1024 * 1024 {
        return Err("文件路径或内容超出允许范围".into());
    }
    // 防空字节导致的隐藏路径问题
    if path.contains('\0') {
        return Err("非法路径".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC 面：参数数由命令协议决定
fn create_task(
    title: String,
    description: Option<String>,
    due_date: Option<String>,
    priority: Option<String>,
    project_id: Option<String>,
    tags: Option<Vec<String>>,
    repeat_interval: Option<String>,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let priority = priority.unwrap_or_else(|| "medium".to_string());
    let description = description.unwrap_or_default();
    // 无项目归属 → 进收集箱；有项目 → 不算 inbox
    let is_inbox = project_id.is_none();
    let is_inbox_i = if is_inbox { 1 } else { 0 };

    db.execute(
        "INSERT INTO tasks (id, title, description, due_date, priority, project_id, is_inbox, repeat_interval, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        rusqlite::params![id, title, description, due_date, priority, project_id, is_inbox_i, repeat_interval, now],
    )
    .map_err(|e| e.to_string())?;

    if let Some(tag_names) = tags {
        for name in tag_names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let tag_id: String = match db.query_row(
                "SELECT id FROM tags WHERE name = ?1",
                rusqlite::params![name],
                |row| row.get(0),
            ) {
                Ok(existing) => existing,
                Err(_) => {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    db.execute(
                        "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![new_id, name, now],
                    )
                    .map_err(|e| e.to_string())?;
                    new_id
                }
            };
            db.execute(
                "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    push_undo(&undo, UndoEntry::DeleteTask { id: id.clone() });

    fetch_task(&db, &id)
}

fn map_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        due_date: row.get(3)?,
        priority: row.get(4)?,
        status: row.get(5)?,
        project_id: row.get(6)?,
        is_inbox: row.get::<_, i32>(7)? != 0,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        completed_at: row.get(11)?,
        repeat_interval: row.get(12)?,
        tags: Vec::new(),
    })
}

/// 联动刷新任务的 updated_at（标签/子任务等从属变更后调用）
fn touch_task(db: &Connection, task_id: &str, now: &str) -> Result<(), String> {
    db.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// ── 撤销（Undo）──
/// 记录最近的可逆任务操作，支持一步撤销（基于完整行快照，含标签）。
#[derive(Clone, Serialize, Deserialize)]
pub enum UndoEntry {
    /// 覆盖式还原：应用于改字段 / 完成切换等
    RestoreTask { snapshot: Task },
    /// 删除后重建：快照含任务行 + 子任务列表 + 标签
    RecreateTask {
        snapshot: Task,
        subtasks: Vec<Subtask>,
    },
    /// 撤销“新建” → 删除该任务
    DeleteTask { id: String },
}

pub struct UndoStack {
    entries: Mutex<Vec<UndoEntry>>,
}

const UNDO_CAP: usize = 100;

fn push_undo(undo: &UndoStack, entry: UndoEntry) {
    let mut entries = undo.entries.lock().unwrap();
    entries.push(entry);
    if entries.len() > UNDO_CAP {
        entries.remove(0);
    }
}

/// 应用一次撤销。返回 Ok(true) 表示有可撤销操作被应用，Ok(false) 表示栈为空。
#[tauri::command]
fn undo_last(state: tauri::State<DbState>, undo: tauri::State<UndoStack>) -> Result<bool, String> {
    let entry = undo.entries.lock().unwrap().pop();
    let Some(entry) = entry else {
        return Ok(false);
    };
    let db = state.lock_conn()?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    match entry {
        UndoEntry::RestoreTask { snapshot } => {
            db.execute(
                "UPDATE tasks SET title=?1, description=?2, due_date=?3, priority=?4, status=?5,
                 project_id=?6, is_inbox=?7, repeat_interval=?8, updated_at=?9 WHERE id=?10",
                rusqlite::params![
                    &snapshot.title,
                    &snapshot.description,
                    &snapshot.due_date,
                    &snapshot.priority,
                    &snapshot.status,
                    &snapshot.project_id,
                    snapshot.is_inbox as i32,
                    &snapshot.repeat_interval,
                    now,
                    &snapshot.id
                ],
            )
            .map_err(|e| e.to_string())?;
            link_task_tags_by_name(&db, &snapshot)?;
        }
        UndoEntry::RecreateTask { snapshot, subtasks } => {
            db.execute(
                "INSERT OR REPLACE INTO tasks (id, title, description, due_date, priority, status,
                 project_id, is_inbox, repeat_interval, created_at, updated_at, completed_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                rusqlite::params![
                    &snapshot.id,
                    &snapshot.title,
                    &snapshot.description,
                    &snapshot.due_date,
                    &snapshot.priority,
                    &snapshot.status,
                    &snapshot.project_id,
                    snapshot.is_inbox as i32,
                    &snapshot.repeat_interval,
                    &snapshot.created_at,
                    &snapshot.updated_at,
                    &snapshot.completed_at
                ],
            )
            .map_err(|e| e.to_string())?;
            for sub in subtasks {
                db.execute(
                    "INSERT INTO subtasks (id, task_id, title, done, sort_order, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![
                        sub.id,
                        sub.task_id,
                        sub.title,
                        sub.done as i32,
                        sub.sort_order,
                        sub.created_at
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            link_task_tags_by_name(&db, &snapshot)?;
        }
        UndoEntry::DeleteTask { id } => {
            let dir = attachments_dir(&state.data_dir, &id);
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            db.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

/// 按快照中的标签名重建任务标签关联。
fn link_task_tags_by_name(db: &Connection, task: &Task) -> Result<(), String> {
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    link_task_tags_with(db, &task.id, &task.tags, &now)
}

fn link_task_tags_with(db: &Connection, task_id: &str, names: &[String], now: &str) -> Result<(), String> {
    db.execute("DELETE FROM task_tags WHERE task_id = ?1", rusqlite::params![task_id])
        .map_err(|e| e.to_string())?;
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let tag_id: String = match db.query_row(
            "SELECT id FROM tags WHERE name = ?1",
            rusqlite::params![name],
            |row| row.get(0),
        ) {
            Ok(existing) => existing,
            Err(_) => {
                let new_id = uuid::Uuid::new_v4().to_string();
                db.execute(
                    "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![new_id, name, now],
                )
                .map_err(|e| e.to_string())?;
                new_id
            }
        };
        db.execute(
            "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![task_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 撤销前快照（RestoreTask）。task 需为已存在的完整 Task（含 tags）。
fn record_restore(undo: &UndoStack, task: &Task) {
    push_undo(undo, UndoEntry::RestoreTask { snapshot: task.clone() });
}

/// 撤销前快照（RecreateTask，用于删除）。task 需为已存在的完整 Task。
fn record_recreate(db: &Connection, undo: &UndoStack, task: &Task) -> Result<(), String> {
    let mut stmt = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ?1 ORDER BY sort_order ASC, created_at ASC")
        .map_err(|e| e.to_string())?;
    let subtasks = stmt
        .query_map(rusqlite::params![&task.id], map_subtask_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    push_undo(
        undo,
        UndoEntry::RecreateTask {
            snapshot: task.clone(),
            subtasks,
        },
    );
    Ok(())
}

fn load_task_tag_names(db: &Connection, task_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = db
        .prepare(
            "SELECT tags.name FROM task_tags
             JOIN tags ON tags.id = task_tags.tag_id
             WHERE task_tags.task_id = ?1
             ORDER BY tags.name ASC",
        )
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map(rusqlite::params![task_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

/// 为一批任务一次性加载标签，避免对每个任务单独查询（N+1）。
/// 空列表直接返回，不执行任何 SQL。
fn attach_tags(db: &Connection, tasks: &mut [Task]) -> Result<(), String> {
    if tasks.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT tt.task_id, tags.name FROM task_tags tt
         JOIN tags ON tags.id = tt.tag_id
         WHERE tt.task_id IN ({placeholders})
         ORDER BY tags.name ASC"
    );
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let mut tag_names: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter().copied()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows.filter_map(|r| r.ok()) {
        tag_names.entry(row.0).or_default().push(row.1);
    }
    for task in tasks.iter_mut() {
        if let Some(names) = tag_names.get(&task.id) {
            task.tags = names.clone();
        }
    }
    Ok(())
}

fn fetch_task(db: &Connection, id: &str) -> Result<Task, String> {
    let mut task = db
        .query_row(
            "SELECT * FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            map_task_row,
        )
        .map_err(|e| e.to_string())?;
    task.tags = load_task_tag_names(db, id)?;
    Ok(task)
}

/// 根据 `task.repeat_interval` 在其下一次截止日期克隆一个新的待办任务，
/// 并保持项目 / 标签 / 描述 / 优先级一致。
fn spawn_repeat_task(db: &Connection, completed: &Task, now: &str) -> Result<(), String> {
    let interval = completed.repeat_interval.as_deref().unwrap_or("");
    let base_ymd = completed.due_date.as_deref().unwrap_or(now).get(0..10).unwrap_or(&now[..10]).to_string();
    let Some(next_ymd) = next_due_date(interval, &base_ymd) else {
        return Ok(()); // 无法计算下一周期（未知间隔）
    };

    let new_id = uuid::Uuid::new_v4().to_string();
    let is_inbox_i = if completed.project_id.is_none() { 1 } else { 0 };
    db.execute(
        "INSERT INTO tasks (id, title, description, due_date, priority, project_id, is_inbox, repeat_interval, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        rusqlite::params![
            new_id,
            &completed.title,
            &completed.description,
            Some(next_ymd),
            &completed.priority,
            &completed.project_id,
            is_inbox_i,
            &completed.repeat_interval,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    // 复制标签关联
    let tag_ids: Vec<String> = {
        let mut stmt = db
            .prepare("SELECT tag_id FROM task_tags WHERE task_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![&completed.id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for tag_id in tag_ids {
        db.execute(
            "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![new_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 根据重复间隔计算下一次截止日期（YYYY-MM-DD）。无法识别时返回 None。
fn next_due_date(interval: &str, base_ymd: &str) -> Option<String> {
    let base = chrono::NaiveDate::parse_from_str(base_ymd, "%Y-%m-%d").ok()?;
    let next = match interval {
        "daily" => base.succ_opt()?,
        "weekly" => base.checked_add_days(chrono::Days::new(7))?,
        "monthly" => base.checked_add_months(chrono::Months::new(1))?,
        "yearly" => base.checked_add_months(chrono::Months::new(12))?,
        _ => return None,
    };
    Some(next.format("%Y-%m-%d").to_string())
}

/// 全局搜索：按标题 / 描述 / 标签名 模糊匹配。
#[tauri::command]
fn search_tasks(query: String, state: tauri::State<DbState>) -> Result<Vec<Task>, String> {
    let db = state.lock_conn()?;
    search_tasks_impl(&db, &query)
}

fn search_tasks_impl(db: &Connection, query: &str) -> Result<Vec<Task>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    if query.len() > 200 {
        return Err("搜索内容过长".into());
    }
    // LIKE 通配：用户可直接输入 % / _ 通配符
    let like = format!("%{}%", query);
    let mut stmt = db
        .prepare(
            "SELECT DISTINCT t.* FROM tasks t
             LEFT JOIN task_tags tt ON tt.task_id = t.id
             LEFT JOIN tags g ON g.id = tt.tag_id
             WHERE t.title LIKE ?1 ESCAPE '\\'
                OR t.description LIKE ?1 ESCAPE '\\'
                OR g.name LIKE ?1 ESCAPE '\\'
             ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.sort_order, t.created_at DESC
             LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map(rusqlite::params![like], map_task_row)
        .map_err(|e| e.to_string())?;
    let mut tasks: Vec<Task> = mapped.filter_map(|r| r.ok()).collect();
    attach_tags(db, &mut tasks)?;
    Ok(tasks)
}

#[tauri::command]
fn get_tasks(filter: Option<String>, state: tauri::State<DbState>) -> Result<Vec<Task>, String> {
    let db = state.lock_conn()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let project_id = filter
        .as_deref()
        .and_then(|f| f.strip_prefix("project:"))
        .map(|s| s.to_string());
    let tag_id = filter
        .as_deref()
        .and_then(|f| f.strip_prefix("tag:"))
        .map(|s| s.to_string());

    let (sql, param): (&str, Option<&str>) = match filter.as_deref() {
        Some("today") => (
            "SELECT * FROM tasks WHERE (due_date = ?1 OR (due_date < ?1 AND status != 'done')) AND status != 'done' ORDER BY sort_order, created_at DESC",
            Some(today.as_str()),
        ),
        Some("inbox") => (
            "SELECT * FROM tasks WHERE is_inbox = 1 AND status != 'done' ORDER BY sort_order, created_at DESC",
            None,
        ),
        Some("upcoming") => (
            "SELECT * FROM tasks WHERE due_date > ?1 AND status != 'done' ORDER BY due_date ASC, sort_order ASC",
            Some(today.as_str()),
        ),
        Some("someday") => (
            "SELECT * FROM tasks WHERE due_date IS NULL AND is_inbox = 0 AND status != 'done' ORDER BY sort_order, created_at DESC",
            None,
        ),
        Some("board") => (
            "SELECT * FROM tasks ORDER BY sort_order, created_at DESC",
            None,
        ),
        Some(f) if f.starts_with("project:") => {
            let id = project_id.as_deref().unwrap_or("");
            if id.is_empty() {
                return Err("project filter missing id".into());
            }
            (
                "SELECT * FROM tasks WHERE project_id = ?1 ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END, sort_order, created_at DESC",
                Some(id),
            )
        }
        Some(f) if f.starts_with("tag:") => {
            let id = tag_id.as_deref().unwrap_or("");
            if id.is_empty() {
                return Err("tag filter missing id".into());
            }
            (
                "SELECT t.* FROM tasks t
                 INNER JOIN task_tags tt ON tt.task_id = t.id
                 WHERE tt.tag_id = ?1
                 ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.sort_order, t.created_at DESC",
                Some(id),
            )
        }
        _ => (
            "SELECT * FROM tasks ORDER BY sort_order, created_at DESC",
            None,
        ),
    };

    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let mapped = match param {
        Some(p) => stmt.query_map(rusqlite::params![p], map_task_row),
        None => stmt.query_map([], map_task_row),
    }
    .map_err(|e| e.to_string())?;

    let mut tasks: Vec<Task> = mapped.filter_map(|r| r.ok()).collect();
    attach_tags(&db, &mut tasks)?;
    Ok(tasks)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC 面：参数数由命令协议决定
fn update_task(
    id: String,
    title: Option<String>,
    description: Option<String>,
    due_date: Option<String>,
    priority: Option<String>,
    status: Option<String>,
    project_id: Option<String>,
    repeat_interval: Option<String>,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    // 先记录旧状态，判断是否由未完成 → 完成，从而触发重复任务
    let previous: Option<Task> = fetch_task(&db, &id).ok();

    if let Some(prev) = &previous {
        record_restore(&undo, prev);
    }

    if let Some(title) = &title {
        db.execute(
            "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(description) = &description {
        db.execute(
            "UPDATE tasks SET description = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![description, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(due_date) = &due_date {
        // 空字符串表示清空截止日期
        let value = if due_date.is_empty() {
            None::<String>
        } else {
            Some(due_date.clone())
        };
        db.execute(
            "UPDATE tasks SET due_date = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![value, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(priority) = &priority {
        db.execute(
            "UPDATE tasks SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![priority, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(status) = &status {
        let completed_at = if status == "done" {
            Some(now.clone())
        } else {
            None
        };
        db.execute(
            "UPDATE tasks SET status = ?1, completed_at = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![status, completed_at, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(project_id) = &project_id {
        // 归入项目则离开收集箱；空字符串表示移回收集箱
        let (pid, is_inbox_i) = if project_id.is_empty() {
            (None::<String>, 1)
        } else {
            (Some(project_id.clone()), 0)
        };
        db.execute(
            "UPDATE tasks SET project_id = ?1, is_inbox = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![pid, is_inbox_i, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(interval) = &repeat_interval {
        let value = if interval.is_empty() {
            None::<String>
        } else {
            Some(interval.clone())
        };
        db.execute(
            "UPDATE tasks SET repeat_interval = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![value, now, id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 完成操作触发重复任务：由未完成 → 完成 且设置了重复间隔
    let completing = matches!(
        (&previous, status.as_deref()),
        (Some(p), Some("done")) if p.status != "done" && p.repeat_interval.is_some()
    );
    if completing {
        if let Some(prev) = &previous {
            spawn_repeat_task(&db, prev, &now)?;
        }
    }

    fetch_task(&db, &id)
}

#[tauri::command]
fn delete_task(
    id: String,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<(), String> {
    let db = state.lock_conn()?;
    if let Ok(task) = fetch_task(&db, &id) {
        record_recreate(&db, &undo, &task)?;
    }
    // 清理磁盘上该任务的附件文件（task_attachments 行由 FK CASCADE 删除）
    let dir = attachments_dir(&state.data_dir, &id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    db.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_task(
    id: String,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    let current_status: String = db
        .query_row(
            "SELECT status FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let prev = fetch_task(&db, &id).ok();
    if let Some(prev) = &prev {
        record_restore(&undo, prev);
    }
    let new_status = if current_status == "done" {
        "todo"
    } else {
        "done"
    };
    let completed_at = if new_status == "done" {
        Some(now.clone())
    } else {
        None
    };
    db.execute(
        "UPDATE tasks SET status = ?1, completed_at = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![new_status, completed_at, now, id],
    )
    .map_err(|e| e.to_string())?;

    // 未完成 → 完成 且带重复间隔：生成下一周期
    if new_status == "done" {
        if let Some(prev) = &prev {
            if prev.status != "done" && prev.repeat_interval.is_some() {
                spawn_repeat_task(&db, prev, &now)?;
            }
        }
    }

    fetch_task(&db, &id)
}

// ── Projects ──

#[tauri::command]
fn create_project(
    name: String,
    color: Option<String>,
    state: tauri::State<DbState>,
) -> Result<Project, String> {
    let db = state.lock_conn()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    db.execute(
        "INSERT INTO projects (id, name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, name, color, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(Project {
        id,
        name,
        color,
        sort_order: 0,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
fn get_projects(state: tauri::State<DbState>) -> Result<Vec<Project>, String> {
    let db = state.lock_conn()?;
    let mut stmt = db
        .prepare("SELECT * FROM projects ORDER BY sort_order, created_at ASC")
        .map_err(|e| e.to_string())?;
    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(projects)
}

#[tauri::command]
fn update_project(
    id: String,
    name: Option<String>,
    color: Option<String>,
    state: tauri::State<DbState>,
) -> Result<Project, String> {
    let db = state.lock_conn()?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    if let Some(name) = &name {
        let name = name.trim();
        if name.is_empty() {
            return Err("project name cannot be empty".into());
        }
        db.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![name, now, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(color) = &color {
        db.execute(
            "UPDATE projects SET color = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![color, now, id],
        )
        .map_err(|e| e.to_string())?;
    }

    db.query_row(
        "SELECT * FROM projects WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(id: String, state: tauri::State<DbState>) -> Result<(), String> {
    let db = state.lock_conn()?;
    // 先把任务移回收集箱，再删项目（避免 is_inbox 仍为 0）
    db.execute(
        "UPDATE tasks SET project_id = NULL, is_inbox = 1, updated_at = datetime('now') WHERE project_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tags ──

#[tauri::command]
fn create_tag(
    name: String,
    color: Option<String>,
    state: tauri::State<DbState>,
) -> Result<Tag, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("tag name cannot be empty".into());
    }
    let db = state.lock_conn()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    db.execute(
        "INSERT INTO tags (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, color, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(Tag {
        id,
        name,
        color,
        created_at: now,
    })
}

#[tauri::command]
fn get_tags(state: tauri::State<DbState>) -> Result<Vec<Tag>, String> {
    let db = state.lock_conn()?;
    let mut stmt = db
        .prepare("SELECT * FROM tags ORDER BY name ASC")
        .map_err(|e| e.to_string())?;
    let tags = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

#[tauri::command]
fn update_tag(
    id: String,
    name: Option<String>,
    color: Option<String>,
    state: tauri::State<DbState>,
) -> Result<Tag, String> {
    let db = state.lock_conn()?;
    if let Some(name) = &name {
        let name = name.trim();
        if name.is_empty() {
            return Err("tag name cannot be empty".into());
        }
        db.execute(
            "UPDATE tags SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(color) = &color {
        db.execute(
            "UPDATE tags SET color = ?1 WHERE id = ?2",
            rusqlite::params![color, id],
        )
        .map_err(|e| e.to_string())?;
    }
    db.query_row(
        "SELECT * FROM tags WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_tag(id: String, state: tauri::State<DbState>) -> Result<(), String> {
    let db = state.lock_conn()?;
    db.execute(
        "DELETE FROM task_tags WHERE tag_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM tags WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Task-Tags ──

#[tauri::command]
fn add_task_tag(
    task_id: String,
    tag_id: String,
    state: tauri::State<DbState>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    db.execute(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![task_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    touch_task(&db, &task_id, &now)?;
    fetch_task(&db, &task_id)
}

#[tauri::command]
fn remove_task_tag(
    task_id: String,
    tag_id: String,
    state: tauri::State<DbState>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    db.execute(
        "DELETE FROM task_tags WHERE task_id = ?1 AND tag_id = ?2",
        rusqlite::params![task_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    touch_task(&db, &task_id, &now)?;
    fetch_task(&db, &task_id)
}

/// 按名称给任务加标签（不存在则创建）
#[tauri::command]
fn attach_tag_by_name(
    task_id: String,
    name: String,
    state: tauri::State<DbState>,
) -> Result<Task, String> {
    let db = state.lock_conn()?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("tag name cannot be empty".into());
    }
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let tag_id: String = match db.query_row(
        "SELECT id FROM tags WHERE name = ?1",
        rusqlite::params![name],
        |row| row.get(0),
    ) {
        Ok(existing) => existing,
        Err(_) => {
            let new_id = uuid::Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![new_id, name, now],
            )
            .map_err(|e| e.to_string())?;
            new_id
        }
    };
    db.execute(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![task_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    touch_task(&db, &task_id, &now)?;
    fetch_task(&db, &task_id)
}

// ── Subtasks ──

fn map_subtask_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Subtask> {
    Ok(Subtask {
        id: row.get(0)?,
        task_id: row.get(1)?,
        title: row.get(2)?,
        done: row.get::<_, i32>(3)? != 0,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[tauri::command]
fn get_subtasks(task_id: String, state: tauri::State<DbState>) -> Result<Vec<Subtask>, String> {
    let db = state.lock_conn()?;
    let mut stmt = db
        .prepare(
            "SELECT * FROM subtasks WHERE task_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params![task_id], map_subtask_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
fn create_subtask(
    task_id: String,
    title: String,
    state: tauri::State<DbState>,
) -> Result<Subtask, String> {
    let db = state.lock_conn()?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("subtask title cannot be empty".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let sort_order: i32 = db
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM subtasks WHERE task_id = ?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    db.execute(
        "INSERT INTO subtasks (id, task_id, title, done, sort_order, created_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        rusqlite::params![id, task_id.clone(), title, sort_order, now.clone()],
    )
    .map_err(|e| e.to_string())?;
    touch_task(&db, &task_id, &now)?;

    Ok(Subtask {
        id,
        task_id: task_id.clone(),
        title,
        done: false,
        sort_order,
        created_at: now.clone(),
    })
}

#[tauri::command]
fn toggle_subtask(id: String, state: tauri::State<DbState>) -> Result<Subtask, String> {
    let db = state.lock_conn()?;
    let (current, task_id): (i32, String) = db
        .query_row(
            "SELECT done, task_id FROM subtasks WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let new_done = if current == 0 { 1 } else { 0 };
    db.execute(
        "UPDATE subtasks SET done = ?1 WHERE id = ?2",
        rusqlite::params![new_done, id],
    )
    .map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    touch_task(&db, &task_id, &now)?;

    db.query_row(
        "SELECT * FROM subtasks WHERE id = ?1",
        rusqlite::params![id],
        map_subtask_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_subtask(
    id: String,
    title: Option<String>,
    state: tauri::State<DbState>,
) -> Result<Subtask, String> {
    let db = state.lock_conn()?;
    let (task_id,): (String,) = db
        .query_row(
            "SELECT task_id FROM subtasks WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?,)),
        )
        .map_err(|e| e.to_string())?;
    if let Some(title) = title {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("subtask title cannot be empty".into());
        }
        db.execute(
            "UPDATE subtasks SET title = ?1 WHERE id = ?2",
            rusqlite::params![title, id],
        )
        .map_err(|e| e.to_string())?;
    }
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    touch_task(&db, &task_id, &now)?;
    db.query_row(
        "SELECT * FROM subtasks WHERE id = ?1",
        rusqlite::params![id],
        map_subtask_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_subtask(id: String, state: tauri::State<DbState>) -> Result<(), String> {
    let db = state.lock_conn()?;
    db.execute("DELETE FROM subtasks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Attachments ──

fn attachments_dir(data_dir: &Path, task_id: &str) -> PathBuf {
    data_dir.join("attachments").join(task_id)
}

fn map_attachment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskAttachment> {
    Ok(TaskAttachment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        file_name: row.get(2)?,
        stored_path: row.get(3)?,
        file_size: row.get(4)?,
        created_at: row.get(5)?,
    })
}

// ── Bulk ──

/// 批量更新任务字段（仅更新给定的字段；空字符串表示清空值）。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC 面：参数数由命令协议决定
fn batch_update_tasks(
    ids: Vec<String>,
    title: Option<String>,
    due_date: Option<String>,
    priority: Option<String>,
    project_id: Option<String>,
    repeat_interval: Option<String>,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<usize, String> {
    let db = state.lock_conn()?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut updated = 0;
    for id in &ids {
        if let Ok(prev) = fetch_task(&db, id) {
            record_restore(&undo, &prev);
        }
        if let Some(title) = &title {
            db.execute(
                "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![title, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(due_date) = &due_date {
            let value = if due_date.is_empty() {
                None::<String>
            } else {
                Some(due_date.clone())
            };
            db.execute(
                "UPDATE tasks SET due_date = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![value, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(priority) = &priority {
            db.execute(
                "UPDATE tasks SET priority = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![priority, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(project_id) = &project_id {
            let (pid, is_inbox_i) = if project_id.is_empty() {
                (None::<String>, 1)
            } else {
                (Some(project_id.clone()), 0)
            };
            db.execute(
                "UPDATE tasks SET project_id = ?1, is_inbox = ?2, updated_at = ?3 WHERE id = ?4",
                rusqlite::params![pid, is_inbox_i, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(interval) = &repeat_interval {
            let value = if interval.is_empty() {
                None::<String>
            } else {
                Some(interval.clone())
            };
            db.execute(
                "UPDATE tasks SET repeat_interval = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![value, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        updated += 1;
    }
    Ok(updated)
}

/// 批量删除任务（可撤销）。
#[tauri::command]
fn batch_delete_tasks(
    ids: Vec<String>,
    state: tauri::State<DbState>,
    undo: tauri::State<UndoStack>,
) -> Result<usize, String> {
    let db = state.lock_conn()?;
    for id in &ids {
        if let Ok(task) = fetch_task(&db, id) {
            record_recreate(&db, &undo, &task)?;
        }
        let dir = attachments_dir(&state.data_dir, id);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        db.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(ids.len())
}

#[tauri::command]
fn add_attachment(
    task_id: String,
    file_path: String,
    state: tauri::State<DbState>,
) -> Result<TaskAttachment, String> {
    let db = state.lock_conn()?;
    let src = Path::new(&file_path);
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let file_size = std::fs::metadata(src)
        .map_err(|e| e.to_string())?
        .len() as i64;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    let dest_dir = attachments_dir(&state.data_dir, &task_id);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let stored_name = format!("{}_{}", &id[..8], file_name);
    let dest_path = dest_dir.join(&stored_name);
    std::fs::copy(src, &dest_path).map_err(|e| e.to_string())?;

    let stored_path = dest_path.to_string_lossy().to_string();
    db.execute(
        "INSERT INTO task_attachments (id, task_id, file_name, stored_path, file_size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, task_id, file_name, stored_path, file_size, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(TaskAttachment {
        id,
        task_id,
        file_name,
        stored_path,
        file_size,
        created_at: now,
    })
}

#[tauri::command]
fn get_attachments(
    task_id: String,
    state: tauri::State<DbState>,
) -> Result<Vec<TaskAttachment>, String> {
    let db = state.lock_conn()?;
    let mut stmt = db
        .prepare(
            "SELECT * FROM task_attachments WHERE task_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params![task_id], map_attachment_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
fn delete_attachment(
    attachment_id: String,
    state: tauri::State<DbState>,
) -> Result<(), String> {
    let db = state.lock_conn()?;

    let (stored_path, task_id): (String, String) = db
        .query_row(
            "SELECT stored_path, task_id FROM task_attachments WHERE id = ?1",
            rusqlite::params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    db.execute(
        "DELETE FROM task_attachments WHERE id = ?1",
        rusqlite::params![attachment_id],
    )
    .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&stored_path);
    // 附件删除后清理可能变空的附件目录
    let task_dir = attachments_dir(&state.data_dir, &task_id);
    if let Ok(mut rd) = std::fs::read_dir(&task_dir) {
        if rd.next().is_none() {
            let _ = std::fs::remove_dir(&task_dir);
        }
    }

    Ok(())
}

#[tauri::command]
fn open_attachment_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开文件失败: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_encryption_status(state: tauri::State<DbState>) -> EncryptionStatus {
    state.status()
}

#[tauri::command]
fn unlock_database(password: String, state: tauri::State<DbState>) -> Result<EncryptionStatus, String> {
    unlock_into_state(&state, &password)?;
    // 解锁后补一次今日备份（启动时若未解锁会跳过）
    if !has_backup_today(&state.data_dir) {
        let _ = create_rolling_backup(&state);
    }
    Ok(state.status())
}

#[tauri::command]
fn enable_encryption(
    password: String,
    state: tauri::State<DbState>,
) -> Result<EncryptionStatus, String> {
    migrate_to_encrypted(&state, &password)?;
    Ok(state.status())
}

#[tauri::command]
fn disable_encryption(
    password: String,
    state: tauri::State<DbState>,
) -> Result<EncryptionStatus, String> {
    migrate_to_plain(&state, &password)?;
    Ok(state.status())
}

#[tauri::command]
fn change_encryption_password(
    old_password: String,
    new_password: String,
    state: tauri::State<DbState>,
) -> Result<EncryptionStatus, String> {
    rekey_database(&state, &old_password, &new_password)?;
    Ok(state.status())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
            app.manage(UndoStack {
                entries: Mutex::new(vec![]),
            });

            let meta = read_encryption_meta(&app_data_dir);
            if meta.enabled {
                // 加密库：先占位，等前端输入密码再真正打开
                let placeholder =
                    Connection::open_in_memory().expect("failed to open placeholder db");
                app.manage(DbState {
                    db: Mutex::new(placeholder),
                    data_dir: app_data_dir.clone(),
                    unlocked: AtomicBool::new(false),
                    encrypted: AtomicBool::new(true),
                    session_key: Mutex::new(None),
                });
            } else {
                let conn = init_schema_and_conn(&app_data_dir);
                ensure_default_project(&conn).ok();
                app.manage(DbState {
                    db: Mutex::new(conn),
                    data_dir: app_data_dir.clone(),
                    unlocked: AtomicBool::new(true),
                    encrypted: AtomicBool::new(false),
                    session_key: Mutex::new(None),
                });

                if !has_backup_today(&app_data_dir) {
                    let state = app.state::<DbState>();
                    let _ = create_rolling_backup(&state);
                }
            }

            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // 系统托盘：左键显示窗口；菜单可显示 / 退出
                let show_i =
                    MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
                let quit_i =
                    MenuItem::with_id(app, "quit", "退出 LocalFlow", true, None::<&str>)?;
                let tray_menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                let tray_icon = app
                    .default_window_icon()
                    .cloned()
                    .expect("missing default window icon for tray");

                let _tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .tooltip("LocalFlow")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            if let Some(win) = app.get_webview_window("quick-capture") {
                                match win.is_visible() {
                                    Ok(true) => {
                                        let _ = win.hide();
                                    }
                                    _ => {
                                        let _ = win.center();
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                        let _ = win.emit("quick-capture-opened", ());
                                    }
                                }
                            }
                        })
                        .build(),
                )?;

                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                app.global_shortcut().register(shortcut)?;
            }

            Ok(())
        })
        // 关闭主窗口 → 隐藏到托盘（托盘菜单「退出」才真正退出）
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_task,
            get_tasks,
            search_tasks,
            update_task,
            delete_task,
            toggle_task,
            batch_update_tasks,
            batch_delete_tasks,
            undo_last,
            create_project,
            get_projects,
            update_project,
            delete_project,
            create_tag,
            get_tags,
            update_tag,
            delete_tag,
            add_task_tag,
            remove_task_tag,
            attach_tag_by_name,
            get_subtasks,
            create_subtask,
            toggle_subtask,
            update_subtask,
            delete_subtask,
            backup_now,
            backup_to_dir,
            list_backups,
            import_backup,
            build_export,
            write_text_file,
            get_encryption_status,
            unlock_database,
            enable_encryption,
            disable_encryption,
            change_encryption_password,
            add_attachment,
            get_attachments,
            delete_attachment,
            open_attachment_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
