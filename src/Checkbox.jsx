import "./Checkbox.css";

/**
 * 自定义复选框
 * - round：任务/子任务圆形勾选
 * - square：设置项方形勾选
 */
export default function Checkbox({
  checked = false,
  onChange,
  variant = "square",
  disabled = false,
  ariaLabel,
  className = "",
  stopPropagation = false,
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={[
        "lf-check",
        `lf-check-${variant}`,
        checked ? "checked" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        if (disabled) return;
        onChange?.(!checked, e);
      }}
    >
      {checked ? (
        <svg
          className="lf-check-mark"
          viewBox="0 0 16 16"
          aria-hidden
          focusable="false"
        >
          <path
            d="M3.5 8.2 6.6 11.2 12.5 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}
