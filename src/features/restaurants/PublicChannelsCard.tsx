import { useEffect, useState } from 'react'
import { Copy, Download, ExternalLink, QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import { Link } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'
import { env } from '../../lib/env'

export function PublicChannelsCard({ slug, menuEnabled, storeEnabled, canConfigure = true }: { slug: string; menuEnabled: boolean; storeEnabled: boolean; canConfigure?: boolean }) {
  return <section className="form-card">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="form-card-title">Tus links</h2><p className="mt-1 text-sm text-stone-500">Compartí tu menú o tu tienda con tus clientes.</p></div>
      {canConfigure ? <Link className="text-sm font-semibold text-orange-700 hover:underline" to="/admin/tienda">{storeEnabled ? 'Configurar mi tienda online' : 'Publicar mi tienda online'}</Link> : null}
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
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!showQr) return
    let cancelled = false
    void QRCode.toDataURL(url, { width: 256, margin: 2 }).then(value => { if (!cancelled) { setQr(value); setQrError(false) } }).catch(() => { if (!cancelled) setQrError(true) })
    return () => { cancelled = true }
  }, [url, showQr])
  return <article className="min-w-0 rounded-xl border border-stone-200 p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3><span className={`flex items-center gap-1.5 text-xs ${enabled ? 'text-emerald-700' : 'text-stone-500'}`}><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-600' : 'bg-stone-300'}`} />{enabled ? 'Publicado' : 'Sin publicar'}</span></div>
    <p className="mt-2 truncate text-sm text-stone-500" title={url}>{displayUrl}</p>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => setMessage('Link copiado.')).catch(() => setMessage('No se pudo copiar. Abrí el link para copiarlo desde el navegador.'))}><Copy className="h-4 w-4" aria-hidden />Copiar</button>
      <a className="button-secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" aria-hidden />Abrir</a>
      <button type="button" className="button-quiet" aria-expanded={showQr} aria-controls={`channel-qr-${channel}`} onClick={() => setShowQr(value => !value)}><QrCode className="h-4 w-4" aria-hidden />{showQr ? 'Ocultar QR' : 'Ver QR'}</button>
    </div>
    {showQr ? <div id={`channel-qr-${channel}`} className="mt-4 border-t border-stone-100 pt-4">
      {qr ? <div className="flex flex-wrap items-center justify-center gap-4"><img src={qr} alt={`Código QR de ${title}`} className="h-36 w-36" /><a className="button-secondary" href={qr} download={`${slug}-${channel}-qr.png`}><Download className="h-4 w-4" aria-hidden />Descargar QR</a></div> : <p className="text-sm text-stone-500">{qrError ? 'No se pudo generar el QR. Cerrá y volvé a abrir esta opción.' : 'Preparando QR…'}</p>}
    </div> : null}
    {message ? <p className="mt-3 text-xs text-stone-600" role="status">{message}</p> : null}
  </article>
}
