import './mozzi-brand.css'

export function MozziBrand({ compact = false, surface = 'light' }: { compact?: boolean; surface?: 'light' | 'dark' }) {
  const source = compact ? 'mozzi-symbol' : `mozzi-comercio-${surface === 'dark' ? 'light' : 'dark'}`
  return <span className={`mozzi-logo${compact ? ' mozzi-logo--compact' : ''}`} role="img" aria-label="Mozzi Comercio">
    <img src={`/brand/${source}.png`} width={compact ? 1114 : 1464} height={compact ? 885 : 252} alt="" aria-hidden="true" decoding="async" />
  </span>
}
