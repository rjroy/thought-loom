// Layout-owned decoration. The surrounding text retains the relationship meaning.
export default function FlowArrow({ direction = "down", className = "" }: { direction?: "down" | "up" | "across" | "left"; className?: string }) {
  return <span className={`flow-arrow flow-arrow-${direction} ${className}`} aria-hidden="true">
    <svg className="arrow-horizontal" viewBox="0 0 64 24" preserveAspectRatio="none" focusable="false"><path d="M0 12H61M52 4L61 12L52 20" /></svg>
    <svg className="arrow-vertical" viewBox="0 0 24 32" preserveAspectRatio="none" focusable="false"><path d="M12 0V29M5 21L12 29L19 21" /></svg>
  </span>;
}
