export function MozziBrand({ compact = false }: { compact?: boolean }) {
  return <span className="mozzi-brand" role="img" aria-label="Mozzi">
    <svg className="mozzi-brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect width="36" height="36" rx="10" fill="currentColor" />
      <path d="M9 25V11L18 20L27 11V25" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    {!compact ? <span className="mozzi-brand-word" aria-hidden="true">mozzi<span>.</span></span> : null}
  </span>
}
