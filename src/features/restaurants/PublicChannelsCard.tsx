import { useEffect, useState } from 'react'
import { Copy, Download, ExternalLink } from 'lucide-react'
import QRCode from 'qrcode'
import { commercePath } from '../../lib/commerce-channel'
import { env } from '../../lib/env'

export function PublicChannelsCard({ slug, menuEnabled, storeEnabled }: { slug: string; menuEnabled: boolean; storeEnabled: boolean }) {
  return <section className="form-card"><h2 className="form-card-title">Links y códigos QR</h2><p className="mb-5 text-sm text-stone-500">El menú y la tienda comparten tu catálogo. Publicá cada vista desde la configuración.</p><div className="grid gap-5 sm:grid-cols-2"><ChannelLink slug={slug} channel="menu" enabled={menuEnabled} /><ChannelLink slug={slug} channel="store" enabled={storeEnabled} /></div></section>
}

function ChannelLink({ slug, channel, enabled }: { slug: string; channel: 'menu' | 'store'; enabled: boolean }) {
  const url = new URL(commercePath(slug, channel), `${env.appBaseUrl}/`).toString()
  const title = channel === 'store' ? 'Tienda online' : 'Menú digital'
  const [qr, setQr] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(url, { width: 256, margin: 2 }).then(value => { if (!cancelled) setQr(value) }).catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [url])
  return <article className="rounded-2xl border border-stone-200 p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-bold">{title}</h3><span className={`rounded-full px-2 py-1 text-xs ${enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-100 text-stone-600'}`}>{enabled ? 'Publicado' : 'Sin publicar'}</span></div><p className="mt-3 break-all text-sm text-stone-600">{url}</p>{qr ? <img src={qr} alt={`Código QR de ${title}`} className="mx-auto my-4 h-40 w-40" /> : null}<div className="mt-4 flex flex-wrap gap-2"><button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => setMessage('Link copiado.')).catch(() => setMessage('No se pudo copiar. Seleccioná el link para copiarlo.'))}><Copy className="h-4 w-4" />Copiar</button><a className="button-secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />Abrir</a>{qr ? <a className="button-secondary" href={qr} download={`${slug}-${channel}-qr.png`}><Download className="h-4 w-4" />QR</a> : null}</div>{message ? <p className="mt-3 text-xs" role="status">{message}</p> : null}</article>
}
