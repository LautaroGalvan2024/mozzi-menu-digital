import { useEffect, useState } from 'react'
import { Copy, Download, ExternalLink, QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import { Link } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'
import { env } from '../../lib/env'
import './settings-workspace.css'

export function PublicChannelsCard({ slug, menuEnabled, storeEnabled, canConfigure = true }: { slug: string; menuEnabled: boolean; storeEnabled: boolean; canConfigure?: boolean }) {
  return <section className="form-card">
    <div className="settings-panel-heading mb-4">
      <div><h2 className="form-card-title">Tus links</h2><p className="settings-panel-description">Compartí tu menú o tu tienda con tus clientes.</p></div>
      {canConfigure ? <Link className="button-secondary" to="/admin/tienda">{storeEnabled ? 'Configurar mi tienda online' : 'Publicar mi tienda online'}</Link> : null}
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><ChannelLink key={`${slug}-menu`} slug={slug} channel="menu" enabled={menuEnabled} /><ChannelLink key={`${slug}-store`} slug={slug} channel="store" enabled={storeEnabled} /></div>
  </section>
}

function ChannelLink({ slug, channel, enabled }: { slug: string; channel: 'menu' | 'store'; enabled: boolean }) {
  const url = new URL(commercePath(slug, channel), `${env.appBaseUrl}/`).toString()
  const displayUrl = url.replace(/^https?:\/\//, '')
  const title = channel === 'store' ? 'Tienda online' : 'Menú digital'
  const [showQr, setShowQr] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (!showQr) return
    let cancelled = false
    void QRCode.toDataURL(url, { width: 256, margin: 2 }).then(value => { if (!cancelled) { setQr(value); setQrError(false) } }).catch(() => { if (!cancelled) setQrError(true) })
    return () => { cancelled = true }
  }, [url, showQr])
  return <article className="settings-related-card">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3>{title}</h3><span className={`status-badge ${enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-stone-100 text-stone-600'}`}>{enabled ? 'Publicado' : 'Sin publicar'}</span></div>
    <p className="settings-help mt-2">{displayUrl}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(url)
        .then(() => setMessage({ kind: 'success', text: 'Link copiado.' }))
        .catch(() => setMessage({ kind: 'error', text: 'No se pudo copiar. Abrí el link para copiarlo desde el navegador.' }))}>
        <Copy className="h-4 w-4" aria-hidden />Copiar
      </button>
      <a className="button-secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" aria-hidden />Abrir</a>
      <button type="button" className="button-quiet" aria-expanded={showQr} aria-controls={`channel-qr-${channel}`} onClick={() => setShowQr(value => !value)}><QrCode className="h-4 w-4" aria-hidden />{showQr ? 'Ocultar QR' : 'Ver QR'}</button>
    </div>
    {showQr ? <div id={`channel-qr-${channel}`} className="mt-3 border-t border-stone-200 pt-3" aria-busy={!qr && !qrError}>
      {qr ? <div className="flex flex-wrap items-center gap-4"><img src={qr} alt={`Código QR de ${title}`} className="h-36 w-36" /><a className="button-secondary" href={qr} download={`${slug}-${channel}-qr.png`}><Download className="h-4 w-4" aria-hidden />Descargar QR</a></div> : qrError
        ? <p className="form-error" role="alert">No se pudo generar el QR. Cerrá y volvé a abrir esta opción.</p>
        : <div className="flex items-center gap-3" role="status"><span className="h-36 w-36 shrink-0 rounded-lg bg-stone-100" aria-hidden /><span className="settings-help">Preparando QR…</span></div>}
    </div> : null}
    {message ? <p className={`mt-3 form-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
  </article>
}
