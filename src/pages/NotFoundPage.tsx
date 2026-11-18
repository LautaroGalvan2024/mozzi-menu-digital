import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router'
import { MozziBrand } from '../components/MozziBrand'
import './not-found.css'

export function NotFoundPage() {
  return <main className="not-found">
    <div className="not-found-content">
      <MozziBrand />
      <p className="not-found-code">404</p>
      <h1>No encontramos esa página</h1>
      <Link to="/" className="not-found-home"><ArrowLeft size={17} aria-hidden /> Volver al inicio</Link>
    </div>
  </main>
}
