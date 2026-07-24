import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icons";
import "./Select.css";

/**
 * 自定义下拉框：样式跟主题变量走，避免系统原生 select 在深色/护眼主题下难看。
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  className = "",
  ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setMenuStyle(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 240 && rect.top > spaceBelow;
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, 140),
      top: openUp ? undefined : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
      zIndex: 80,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
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
  }, [open]);

  return (
    <div
      className={`lf-select ${open ? "open" : ""} ${className}`}
      ref={rootRef}
    >
      <button
        type="button"
        ref={triggerRef}
        className="lf-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lf-select-value">
          {selected?.color && (
            <span
              className="lf-select-dot"
              style={{ background: selected.color }}
            />
          )}
          {selected?.label || placeholder}
        </span>
        <span className="lf-select-caret" aria-hidden>
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
      {open && menuStyle && (
        <ul
          className="lf-select-menu lf-select-menu-fixed"
          role="listbox"
          id={listId}
          style={menuStyle}
        >
          {options.map((opt) => (
            <li key={opt.value === "" ? "__empty" : opt.value} role="option">
              <button
                type="button"
                className={`lf-select-option ${opt.value === value ? "active" : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.color && (
                  <span
                    className="lf-select-dot"
                    style={{ background: opt.color }}
                  />
                )}
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
