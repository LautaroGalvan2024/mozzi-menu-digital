import { ArrowRight, ArrowUpRight, ShoppingBag, UtensilsCrossed } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { MozziBrand } from '../components/MozziBrand'
import { commercePath, type CommerceChannel } from '../lib/commerce-channel'
import './landing.css'

export function LandingPage() {
  const [slug, setSlug] = useState('')
  const [channel, setChannel] = useState<CommerceChannel>('store')
  const navigate = useNavigate()
  const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (normalized) void navigate(commercePath(normalized, channel))
  }

  return <main className="mozzi-landing">
    <div className="landing-shell">
      <header className="landing-header">
        <MozziBrand surface="dark" />
        <Link className="landing-admin-link" to="/login">Administración <ArrowUpRight aria-hidden /></Link>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <h1 id="landing-title">Tu comercio, <br />listo para <span>vender online.</span></h1>
          <p>Compartí tus productos, organizá el stock y recibí los pedidos de tu tienda o menú desde un solo lugar.</p>
        </div>
        <div className="landing-photo">
          <img
            src="/brand/preparando-un-pedido-560.webp"
            srcSet="/brand/preparando-un-pedido-560.webp 560w, /brand/preparando-un-pedido-1120.webp 1120w"
            sizes="(min-width: 1376px) 642px, (min-width: 760px) 48vw, calc(100vw - 32px)"
            width="1120" height="840" fetchPriority="high" alt=""
          />
        </div>
      </section>

      <form className="landing-access" onSubmit={submit}>
        <fieldset className="landing-channel">
          <legend>Visitá un comercio</legend>
          <div className="landing-channel-options">
            <label><input type="radio" name="commerce-channel" value="store" checked={channel === 'store'} onChange={() => setChannel('store')} /><ShoppingBag aria-hidden />Tienda</label>
            <label><input type="radio" name="commerce-channel" value="menu" checked={channel === 'menu'} onChange={() => setChannel('menu')} /><UtensilsCrossed aria-hidden />Menú</label>
          </div>
        </fieldset>
        <div className="landing-address">
          <label className="landing-slug-label" htmlFor="commerce-slug">Dirección de tu comercio</label>
          <div className="landing-access-row">
            <div className="landing-slug-field">
              <span aria-hidden>{channel === 'store' ? '/t/' : '/r/'}</span>
              <input id="commerce-slug" value={slug} onChange={event => setSlug(event.target.value)} placeholder="mi-comercio" autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-describedby="commerce-slug-help" />
            </div>
            <button className="landing-open-button" type="submit" disabled={!normalized}>Abrir {channel === 'store' ? 'tienda' : 'menú'} <ArrowRight aria-hidden /></button>
          </div>
          <p id="commerce-slug-help">Ingresá el nombre que aparece al final del enlace de tu comercio.</p>
        </div>
      </form>
    </div>
  </main>
}
