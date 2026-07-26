# LocalFlow（本地流）

纯本地、键盘优先的 PC 端工作待办工具。不联网、不注册账号，数据 100% 留在你的电脑上。

设计哲学：**极致轻量 · 键盘优先 · 绝对隐私 · 零延迟**。

完整产品设计见 [`产品文档.md`](./产品文档.md)，任务清单见 [`开发进度.md`](./开发进度.md)，**日常使用请看 [`用户手册.md`](./用户手册.md)**。

---

## 现在能做什么

| 功能 | 说明 |
|------|------|
| 添加任务 | 顶部输入框输入标题，按 Enter 创建；在项目视图下会自动归入该项目 |
| 完成 / 取消完成 | 点击任务左侧复选框，或在详情里操作 |
| 删除任务 | 点击任务右侧 ✕，或在详情里删除 |
| 视图切换 | 左侧：收集箱 / 今日 / 计划 / 随时 / 看板 / 项目 / 标签 |
| 任务详情 | 点击任务打开右侧面板；可改标题、描述（Markdown 预览）、子任务、截止日期（自定义日历）、优先级/项目（自定义下拉） |
| 深浅色 / 护眼主题 | 侧栏「设置」可选：浅色、深色、护眼绿、纸张黄、跟随系统 |
| 快速收集 | 任意时刻按 `Ctrl+Shift+Space` 呼出悬浮框，Enter 存入收集箱，Esc 关闭 |
| 智能输入 | 支持 `明天` / `下周一` / `#标签` / `!高`，输入时下方会预览识别结果 |
| 项目管理 | 侧栏点 `+` 新建；**双击**项目名可重命名；悬停可删除 |
| 标签 | 输入 `#标签` 创建；侧栏可按标签筛选/删除；详情里可添加或点掉标签 |
| 番茄钟 | 顶栏或详情点「番茄钟 / 开始番茄钟」进入 25 分钟专注；可暂停；到时提示音 |
| 看板 | 侧栏「看板」：拖拽任务在 待办 / 进行中 / 已完成 之间切换 |
| 备份 / 导出 | 侧栏「数据」：立即备份、备份到文件夹、导出 Markdown/JSON/CSV；每天首次启动自动备份 |
| 系统托盘 | 点窗口关闭会藏到托盘（不退出）；托盘左键再打开；右键菜单可「退出」 |
| 开机自启 | 侧栏「设置」里勾选即可 |
| 键盘快捷键 | 按 `?` 查看；支持 j/k 选任务、Ctrl+1–5 切视图、x 完成、n 新建、p 番茄钟等 |
| 完成反馈 | 勾选完成有短动画；可开关「完成音效」 |
| 数据库加密 | 侧栏「设置」可开启 AES-256 加密；开启后每次启动需输入密码；可改密/关闭 |
| 项目列表 | 左侧显示已有项目（首次启动会自动创建「默认项目」） |

数据保存在本机 SQLite 文件中（应用数据目录下的 `localflow.db`）。

### 常用快捷键（窗口内按 `?` 可随时查看）

| 按键 | 作用 |
|------|------|
| `Ctrl+Shift+Space` | 全局快速收集（任意软件中） |
| `Ctrl+1` … `5` | 收集箱 / 今日 / 计划 / 随时 / 看板 |
| `j` / `k` 或方向键 | 上下选择任务 |
| `x` 或 `空格` | 完成 / 取消完成 |
| `n` | 聚焦到新建输入框 |
| `p` | 开始番茄钟 |
| `Delete` | 删除选中任务 |
| `Esc` | 关闭详情或快捷键面板 |

---

## 如何安装 / 运行

### 普通用户：下载安装包

1. 打开仓库 **Releases**，下载对应系统文件（Windows `.msi` / macOS `.dmg` / Linux `.AppImage` 或 `.deb`）
2. 安装后打开即可；说明见 [`用户手册.md`](./用户手册.md)

发版由 GitHub Actions 自动打包：推送 `v*` 标签（如 `v1.1.0`）会生成草稿 Release。

### 开发者：从源码运行

需要先安装：**Node.js**、**Rust**、以及本机的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
# 安装前端依赖（首次）
npm install

# 启动完整桌面应用（推荐）
npm run tauri:dev

# 仅预览前端界面（没有数据库后端，任务接口会失败）
npm run dev

# 打正式包前自检
npm run release:check

# 打包正式安装包
npm run tauri:build
```

- 开发时前端在 `http://localhost:1420`
- 设置环境变量 `TAURI_DEV_HOST` 可开启局域网 HMR（端口 1421）
- 正式包产物在 `src-tauri/target/release/bundle/`

---

## 项目结构（给协作者）

```
LocalFlow/
├── 产品文档.md          # 产品定位与功能设计
├── 开发进度.md          # 分阶段任务清单
├── 用户手册.md          # 给用户的安装与使用说明
├── 跨平台测试清单.md    # Win / macOS / Linux 人工验收
├── AGENTS.md            # AI / 开发助手速查
├── app-icon.png         # 品牌图标源图（可用 tauri icon 再生成）
├── scripts/release-check.sh
├── .github/workflows/   # CI 编译 + Release 打包
├── src/                 # React 前端
│   ├── main.jsx
│   ├── App.jsx          # 主界面（侧栏 + 任务列表 + 快捷键/主题）
│   ├── Encryption.jsx   # 解锁页 + 加密设置
│   ├── feedback.js      # 完成任务音效
│   └── App.css
└── src-tauri/           # Rust / Tauri 后端
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── crypto_db.rs # SQLCipher AES-256 开库/迁移
        └── lib.rs       # SQLite + 业务命令 + 托盘
```

| 层 | 技术 | 入口 |
|----|------|------|
| 前端 | React 19 + Vite 7 | `src/main.jsx` → `App.jsx` |
| 后端 | Tauri v2 + Rust | `src-tauri/src/lib.rs` |
| 数据库 | SQLite（rusqlite，bundled） | 应用数据目录 `localflow.db` |

Rust 库 crate 名为 **`localflow_lib`**（避免 Windows 下与可执行文件重名）。

---

## 后端命令一览（前端通过 `invoke` 调用）

### 任务

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `create_task` | `title`, `description?`, `dueDate?`, `priority?`, `projectId?`, `tags?` | `Task` | 创建任务；`tags` 为标签名数组，不存在则自动创建 |
| `get_tasks` | `filter?`：`today` / `inbox` / `upcoming` / `someday` / `board` / `project:<id>` / `tag:<id>` / 空=全部 | `Task[]`（含 `tags`） | 按视图查询 |
| `update_task` | `id` + 可选字段 | `Task` | 更新标题/描述/日期/优先级/状态/项目 |
| `toggle_task` | `id` | `Task` | 在 todo ↔ done 之间切换 |
| `delete_task` | `id` | — | 删除任务 |

### 项目

| 命令 | 参数 | 返回 |
|------|------|------|
| `create_project` | `name`, `color?` | `Project` |
| `get_projects` | — | `Project[]` |
| `update_project` | `id`, `name?`, `color?` | `Project` |
| `delete_project` | `id` | — |

### 标签

| 命令 | 参数 | 返回 |
|------|------|------|
| `create_tag` | `name`, `color?` | `Tag` |
| `get_tags` | — | `Tag[]` |
| `update_tag` | `id`, `name?`, `color?` | `Tag` |
| `delete_tag` | `id` | — |
| `add_task_tag` | `taskId`, `tagId` | `Task` |
| `remove_task_tag` | `taskId`, `tagId` | `Task` |
| `attach_tag_by_name` | `taskId`, `name` | `Task` | 按名称加标签，不存在则创建 |

### 备份与导出

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `backup_now` | — | `BackupInfo` | 备份到应用数据目录 `backups/`，保留最近 7 份 |
| `backup_to_dir` | `dir` | `BackupInfo` | 备份数据库副本到指定文件夹 |
| `list_backups` | — | `BackupInfo[]` | 列出本地滚动备份 |
| `build_export` | `format`：`json` / `csv` / `markdown` | `string` | 生成导出文本 |
| `write_text_file` | `path`, `content` | — | 写入导出文件 |

### 数据库加密（SQLCipher AES-256）

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `get_encryption_status` | — | `{ enabled, unlocked }` | 是否加密、本会话是否已解锁 |
| `unlock_database` | `password` | 同上 | 启动时解锁加密库 |
| `enable_encryption` | `password`（≥6 字符） | 同上 | 把现有库迁成加密库 |
| `disable_encryption` | `password` | 同上 | 解密为明文库 |
| `change_encryption_password` | `oldPassword`, `newPassword` | 同上 | 修改密码 |

密码只保存在本次运行的内存中，不会写入磁盘。忘记密码将无法打开已加密数据。

### 子任务

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `get_subtasks` | `taskId` | `Subtask[]` | 某任务的子任务列表 |
| `create_subtask` | `taskId`, `title` | `Subtask` | 添加子任务 |
| `toggle_subtask` | `id` | `Subtask` | 勾选/取消 |
| `update_subtask` | `id`, `title?` | `Subtask` | 改标题 |
| `delete_subtask` | `id` | — | 删除 |

### 数据模型要点

- **Task**：`id`, `title`, `description`, `due_date`, `priority`（high/medium/low）, `status`（todo/done）, `project_id`, `is_inbox`, `sort_order`, 时间戳
- **Project / Tag**：本地 UUID 主键；任务与标签通过 `task_tags` 多对多关联

---

## 开发路线（简版）

1. **Phase 0** — 脚手架：已完成  
2. **Phase 1** — MVP（SQLite + 基础增删改查 + 三栏 UI + 快速收集）：基本完成  
3. **Phase 2** — 自然语言解析、计划分组、项目/标签、子任务、Markdown 预览：完成  
4. **Phase 3** — 番茄钟、看板、备份导出、托盘/自启/快捷键/护眼主题、可选 AES 加密：已完成  
5. **Phase 4** — 跨平台 CI、性能与图标、发布流程、用户手册：已完成  

详细勾选状态见 [`开发进度.md`](./开发进度.md)。

---

## 已知问题与待改进

- 尚无单元测试 / E2E；跨平台需对照 [`跨平台测试清单.md`](./跨平台测试清单.md) 人工点验
- 全局快捷键若被系统或其他软件占用，可能无法触发
- Markdown 为轻量本地渲染（标题/列表/粗斜体/代码/链接），非完整 CommonMark
- 备份为 SQLite 文件副本（非 zip 整包附件目录；当前无附件功能）
- Linux 上系统托盘依赖桌面环境对 StatusNotifier/AppIndicator 的支持
- 开启数据库加密后请务必记住密码；软件无法帮你找回

已完成：MVP → Phase 2 → Phase 3 → Phase 4（2026-07-24）。

---

## 相关文档

- [`用户手册.md`](./用户手册.md) — 怎么装、怎么用  
- [`跨平台测试清单.md`](./跨平台测试清单.md) — 发版前验收  
- [`产品文档.md`](./产品文档.md) — 为什么做、做成什么样  
- [`开发进度.md`](./开发进度.md) — 做到哪一步了  
- [`AGENTS.md`](./AGENTS.md) — 给 AI / 开发者的架构速查
