import "./Icons.css";

const PATHS = {
  inbox: (
    <>
      <path d="M3 6.5h10l1.2 2.2V13a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V8.7L3 6.5Z" />
      <path d="M3 6.5 5.2 3.8h5.6L13 6.5" />
      <path d="M8 9.2v3.2" />
    </>
  ),
  today: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <path d="M5.2 2.5v2" />
      <path d="M10.8 2.5v2" />
      <path d="M5.5 9.2h2.2" />
      <path d="M9.2 9.2h1.3" />
    </>
  ),
  upcoming: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <path d="M5.2 2.5v2" />
      <path d="M10.8 2.5v2" />
      <path d="M5.3 9h1.4" />
      <path d="M7.8 9h1.4" />
      <path d="M10.3 9h1.2" />
      <path d="M5.3 11.2h1.4" />
      <path d="M7.8 11.2h1.4" />
    </>
  ),
  someday: (
    <>
      <path d="M8 13.2c0-3.4 2.2-5.1 2.2-7.1A2.2 2.2 0 0 0 8 3.8 2.2 2.2 0 0 0 5.8 6.1c0 2 2.2 3.7 2.2 7.1Z" />
      <path d="M6.6 10.4c.4.7.9 1.1 1.4 1.1s1-.4 1.4-1.1" />
    </>
  ),
  board: (
    <>
      <rect x="2.5" y="3" width="3.2" height="10" rx="0.8" />
      <rect x="6.4" y="3" width="3.2" height="7.2" rx="0.8" />
      <rect x="10.3" y="3" width="3.2" height="9" rx="0.8" />
    </>
  ),
  close: (
    <>
      <path d="M4.2 4.2 11.8 11.8" />
      <path d="M11.8 4.2 4.2 11.8" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </>
  ),
  chevronDown: <path d="M4.2 6.2 8 10l3.8-3.8" />,
  chevronLeft: <path d="M9.8 3.8 5.6 8l4.2 4.2" />,
  chevronRight: <path d="M6.2 3.8 10.4 8l-4.2 4.2" />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <path d="M5.2 2.5v2" />
      <path d="M10.8 2.5v2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.6 6.4a1.5 1.5 0 1 1 2.1 1.4c-.5.3-.9.7-.9 1.4" />
      <path d="M8 11.2h.01" />
    </>
  ),
  tag: (
    <>
      <path d="M2.8 8.8 7.2 4.4a1.2 1.2 0 0 1 .9-.4h4.1c.6 0 1.1.5 1.1 1.1v4.1c0 .3-.1.7-.4.9L8.5 14a1.2 1.2 0 0 1-1.7 0L2.8 10a1.2 1.2 0 0 1 0-1.2Z" />
      <circle cx="11" cy="5.8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  timer: (
    <>
      <circle cx="8" cy="8.5" r="5" />
      <path d="M8 8.5V6.2" />
      <path d="M8 8.5l2 1.4" />
      <path d="M6.2 2.8h3.6" />
    </>
  ),
  check: (
    <path d="M3.5 8.2 6.6 11.2 12.5 4.8" />
  ),
  minimize: (
    <path d="M3.5 8h9" />
  ),
  maximize: (
    <>
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1" />
    </>
  ),
  restore: (
    <>
      <rect x="5" y="3.5" width="8" height="8" rx="1" />
      <path d="M5 6.5h-1.8a.7.7 0 0 0-.7.7v5.6a.7.7 0 0 0 .7.7h5.6a.7.7 0 0 0 .7-.7v-1.8" />
    </>
  ),
  search: (
    <>
      <circle cx="6.8" cy="6.8" r="3.8" />
      <path d="M10.4 10.4 13.2 13.2" />
    </>
  ),
  undo: (
    <>
      <path d="M6.5 4 3.2 7.3 6.5 10.6" />
      <path d="M3.2 7.3h5.6a4 4 0 0 1 4 4V13" />
    </>
  ),
  select: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M6 8.2l1.6 1.6 2.9-3.4" />
    </>
  ),
};

/**
 * @param {{ name: keyof typeof PATHS, size?: number, className?: string, strokeWidth?: number }} props
 */
export default function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.6,
}) {
  const content = PATHS[name];
  if (!content) return null;
  return (
    <svg
      className={`lf-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {content}
    </svg>
  );
}
