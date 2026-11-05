import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { LandingPage } from './LandingPage'

function Destination() {
  return <output aria-label="Destino">{useLocation().pathname}</output>
}

function landing() {
  return render(<MemoryRouter><Routes><Route path="/" element={<LandingPage />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter>)
}

afterEach(cleanup)

describe('acceso al comercio desde la portada', () => {
  it('abre la tienda por defecto y conserva la dirección normalizada', () => {
    landing()
    expect(screen.getByRole('img', { name: 'Mozzi Comercio' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Tienda' })).toBeChecked()
    fireEvent.change(screen.getByLabelText('Dirección de tu comercio'), { target: { value: ' Mi-Comercio ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir tienda' }))
    expect(screen.getByLabelText('Destino')).toHaveTextContent('/t/mi-comercio')
  })

  it('permite elegir el menú sin modificar el nombre ingresado', () => {
    landing()
    fireEvent.change(screen.getByLabelText('Dirección de tu comercio'), { target: { value: 'casa-central' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Menú' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir menú' }))
    expect(screen.getByLabelText('Destino')).toHaveTextContent('/r/casa-central')
  })

  it('no abre una dirección vacía y mantiene accesible la administración', () => {
    landing()
    expect(screen.getByRole('button', { name: 'Abrir tienda' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Dirección de tu comercio'), { target: { value: ' /?! ' } })
    expect(screen.getByRole('button', { name: 'Abrir tienda' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Administración' })).toHaveAttribute('href', '/login')
  })
})
