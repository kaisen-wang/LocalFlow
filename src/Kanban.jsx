import { useMemo, useState } from "react";
import Checkbox from "./Checkbox";
import "./Kanban.css";

const COLUMNS = [
  { key: "todo", label: "待办" },
  { key: "doing", label: "进行中" },
  { key: "done", label: "已完成" },
];

function normalizeStatus(status) {
  if (status === "doing" || status === "done") return status;
  return "todo";
}

export default function KanbanBoard({
  tasks,
  projects,
  selectedId,
  onSelect,
  onMoveStatus,
  onToggle,
}) {
  const [dragOverCol, setDragOverCol] = useState(null);
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  function tasksFor(col) {
    return tasks.filter((t) => normalizeStatus(t.status) === col);
  }

  function handleDrop(col, e) {
    e.preventDefault();
    setDragOverCol(null);
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || normalizeStatus(task.status) === col) return;
    onMoveStatus(id, col);
  }

  return (
    <div className="kanban">
      {COLUMNS.map((col) => {
        const items = tasksFor(col.key);
        return (
          <section
            key={col.key}
            className={`kanban-col ${dragOverCol === col.key ? "drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverCol(col.key);
            }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={(e) => handleDrop(col.key, e)}
          >
            <header className="kanban-col-header">
              <span>{col.label}</span>
              <span className="kanban-count">{items.length}</span>
            </header>
            <div className="kanban-col-body">
              {items.length === 0 && (
                <div className="kanban-empty">拖到这里</div>
              )}
              {items.map((task) => (
                <article
                  key={task.id}
                  className={`kanban-card ${selectedId === task.id ? "selected" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/task-id", task.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onSelect(task.id)}
                >
                  <div className="kanban-card-top">
                    <Checkbox
                      variant="round"
                      checked={task.status === "done"}
                      ariaLabel={
                        task.status === "done" ? "标为未完成" : "标为完成"
                      }
                      stopPropagation
                      onChange={(_, e) => onToggle(task.id, e)}
                    />
                    <span
                      className={`kanban-card-title ${task.status === "done" ? "done" : ""}`}
                    >
                      {task.title}
                    </span>
                  </div>
                  <div className="kanban-card-meta">
                    {task.project_id && (
                      <span>
                        {projectById.get(task.project_id)?.name ||
                          ""}
                      </span>
                    )}
                    {(task.tags || []).slice(0, 2).map((name) => (
                      <span key={name}>#{name}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
