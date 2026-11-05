import { ArrowRight, Check, Headphones, Package, ShieldCheck, ShoppingBag, Store, UtensilsCrossed } from 'lucide-react'
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
    <div className="page-shell landing-shell">
      <header className="landing-header">
        <MozziBrand surface="dark" />
        <Link className="landing-admin-link" to="/login"><ShieldCheck aria-hidden />Administración</Link>
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="landing-eyebrow"><span />Más simple. Más cerca de tus clientes.</p>
          <h1 id="landing-title">Tu comercio,<br />listo para <span>vender online.</span></h1>
          <p className="landing-description">Tu catálogo, menú y tienda en un solo lugar. Compartí tus productos, organizá el stock y gestioná cada pedido con Mozzi Comercio.</p>
          <ul className="landing-benefits" aria-label="Todo para tu comercio">
            {['Catálogo a tu medida', 'Pedidos organizados', 'Tu propia marca'].map(benefit => <li key={benefit}><Check aria-hidden />{benefit}</li>)}
          </ul>
          <form className="landing-access" onSubmit={submit}>
            <fieldset className="landing-channel">
              <legend>Visitá un comercio</legend>
              <div className="landing-channel-options">
                <label><input type="radio" name="commerce-channel" value="store" checked={channel === 'store'} onChange={() => setChannel('store')} /><ShoppingBag aria-hidden />Tienda</label>
                <label><input type="radio" name="commerce-channel" value="menu" checked={channel === 'menu'} onChange={() => setChannel('menu')} /><UtensilsCrossed aria-hidden />Menú</label>
              </div>
            </fieldset>
            <label className="landing-slug-label" htmlFor="commerce-slug">Dirección de tu comercio</label>
            <div className="landing-access-row">
              <div className="landing-slug-field">
                <Store aria-hidden /><span aria-hidden>{channel === 'store' ? '/t/' : '/r/'}</span>
                <input id="commerce-slug" value={slug} onChange={event => setSlug(event.target.value)} placeholder="mi-comercio" autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-describedby="commerce-slug-help" />
              </div>
              <button className="landing-open-button" type="submit" disabled={!normalized}>Abrir {channel === 'store' ? 'tienda' : 'menú'}<ArrowRight aria-hidden /></button>
            </div>
            <p id="commerce-slug-help">Ingresá el nombre que aparece al final del enlace de tu comercio.</p>
          </form>
        </div>
        <div className="landing-preview" aria-hidden="true">
          <div className="landing-preview-caption"><span />Una tienda con tu identidad</div>
          <div className="landing-store-window">
            <div className="landing-window-bar"><i /><i /><i /><span>Tu tienda online</span><ShieldCheck /></div>
            <div className="landing-store-cover"><span className="landing-example-logo"><Store /></span><p>Productos que van con vos.</p><h2>Tu comercio</h2><span className="landing-store-tag">Encontrá tu próximo favorito</span></div>
            <div className="landing-example-catalog">
              <div className="landing-example-heading"><strong>Elegidos para vos</strong><span>Ver todo <ArrowRight /></span></div>
              <div className="landing-example-products">
                <article><div className="landing-product-art landing-product-art-bag"><ShoppingBag /></div><span>Para todos los días</span><h3>Bolso urbano</h3><strong>$ 24.900</strong></article>
                <article><div className="landing-product-art landing-product-art-audio"><Headphones /></div><span>Tu música, con vos</span><h3>Auriculares</h3><strong>$ 18.500</strong></article>
              </div>
              <div className="landing-example-order"><span><Package /></span><div><strong>Todo listo para tu próximo pedido</strong><p>Elegí, agregá y comprá.</p></div><ArrowRight /></div>
            </div>
          </div>
        </div>
      </section>
      <footer className="landing-footer"><span>Mozzi Comercio</span><p>De tu comercio a tus clientes.</p></footer>
    </div>
  </main>
}
