import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusinessHour, SpecialHour } from '../../types/domain'
import { RestaurantHoursDialog } from './RestaurantHoursDialog'

const businessHours: BusinessHour[] = [
  { id: 'monday-lunch', dayOfWeek: 1, slotIndex: 0, opensAt: '11:00:00', closesAt: '14:00:00', spansNextDay: false },
  { id: 'monday-evening', dayOfWeek: 1, slotIndex: 1, opensAt: '19:30:00', closesAt: '23:30:00', spansNextDay: false },
  { id: 'saturday', dayOfWeek: 6, slotIndex: 0, opensAt: '21:00:00', closesAt: '02:00:00', spansNextDay: true },
]

const specialHours: SpecialHour[] = [
  { id: 'closed', date: '2026-10-02', isClosed: true, slotIndex: 0, opensAt: null, closesAt: null, spansNextDay: false, reason: 'Evento privado' },
  { id: 'special-lunch', date: '2026-10-03', isClosed: false, slotIndex: 0, opensAt: '11:00', closesAt: '14:00', spansNextDay: false, reason: 'Horario especial' },
  { id: 'special-evening', date: '2026-10-03', isClosed: false, slotIndex: 1, opensAt: '19:00', closesAt: '01:00', spansNextDay: true, reason: 'Horario especial' },
]

describe('RestaurantHoursDialog', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      },
    })
  })

  afterEach(cleanup)

  it('shows the complete week, multiple shifts, closures and upcoming exceptions', () => {
    render(
      <RestaurantHoursDialog
        restaurantName="El Nieto"
        timeZone="America/Argentina/Cordoba"
        locale="es-AR"
        businessHours={businessHours}
        specialHours={specialHours}
        now={new Date('2026-10-01T22:30:00Z')}
        onClose={() => undefined}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'El Nieto' })).toHaveAttribute('open')
    const monday = within(screen.getByTestId('weekly-day-1'))
    expect(monday.getByText('11:00 a 14:00 hs')).toBeVisible()
    expect(monday.getByText('19:30 a 23:30 hs')).toBeVisible()
    expect(within(screen.getByTestId('weekly-day-2')).getByText('Cerrado')).toBeVisible()
    expect(within(screen.getByTestId('weekly-day-6')).getByText('21:00 a 02:00 hs (día siguiente)')).toBeVisible()

    expect(screen.getByRole('heading', { name: 'Próximas excepciones' })).toBeVisible()
    const closure = within(screen.getByTestId('hours-exception-2026-10-02'))
    expect(closure.getByText('Viernes, 02/10')).toBeVisible()
    expect(closure.getByText('Cerrado')).toBeVisible()
    expect(closure.getByText('Evento privado')).toBeVisible()
    const special = within(screen.getByTestId('hours-exception-2026-10-03'))
    expect(special.getByText('11:00 a 14:00 hs')).toBeVisible()
    expect(special.getByText('19:00 a 01:00 hs (día siguiente)')).toBeVisible()
  })

  it('closes from its accessible close button', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <RestaurantHoursDialog
        restaurantName="El Nieto"
        timeZone="America/Argentina/Cordoba"
        locale="es-AR"
        businessHours={businessHours}
        specialHours={[]}
        now={new Date('2026-10-01T22:30:00Z')}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Cerrar horarios' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
