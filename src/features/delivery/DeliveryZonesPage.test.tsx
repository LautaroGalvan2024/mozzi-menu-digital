import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryZoneForm } from './DeliveryZonesPage'
import { emptyDeliveryPolicy } from './delivery-schedule'

const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./delivery-api', () => ({ saveDeliveryZone: mocks.save, loadDeliverySchedules: vi.fn() }))
const restaurantId = 'e1900000-0000-4000-8000-000000000001'
const zoneId = 'e1900000-0000-4000-8000-000000000002'
const row = { id: zoneId, restaurant_id: restaurantId, name: 'Centro', description: '', delivery_fee_cents: 15000, minimum_order_cents: 50000, free_shipping_from_cents: 120000, active: true, sort_order: 2 }
const second = { ...row, id: 'e1900000-0000-4000-8000-000000000003', name: 'Norte' }
const onSaved = vi.fn(async () => undefined)

function open(schedulingEnabled = true) {
  render(<DeliveryZoneForm restaurantId={restaurantId} zone={row} zones={[row, second]} policy={undefined} schedulingEnabled={schedulingEnabled} timezone="America/Argentina/Buenos_Aires" onClose={vi.fn()} onSaved={onSaved} />)
}

describe('delivery zone setup', () => {
  afterEach(cleanup)
  beforeEach(() => { mocks.save.mockReset(); mocks.save.mockResolvedValue({ saved: 1, zoneId }); onSaved.mockClear() })

  it('preserves legacy prices and saves with the calendar disabled by default', async () => {
    open()
    expect(screen.getByLabelText('Mostrar la próxima entrega estimada')).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(mocks.save).toHaveBeenCalledWith({ restaurantId, zoneId, zone: {
      name: 'Centro', description: '', deliveryFeeCents: 15000, minimumOrderCents: 50000,
      freeShippingFromCents: 120000, active: true, sortOrder: 2,
    }, policy: emptyDeliveryPolicy(), copyZoneIds: [], expectedRevision: 0 })
    expect(onSaved).toHaveBeenCalledWith(1)
  })

  it('saves ordinary zone details without sending calendar changes outside the pilot', async () => {
    open(false)
    expect(screen.queryByLabelText('Mostrar la próxima entrega estimada')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ zoneId, policy: null, copyZoneIds: [] }))
  })

  it('requires a delivery weekday, then saves a copy in one operation', async () => {
    const user = userEvent.setup(); open()
    await user.click(screen.getByLabelText('Mostrar la próxima entrega estimada'))
    await user.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Elegí al menos un día')
    expect(mocks.save).not.toHaveBeenCalled()
    await user.click(screen.getByLabelText('Martes'))
    await user.click(screen.getByLabelText('Viernes'))
    await user.click(screen.getByText('Copiar este calendario a otras zonas'))
    await user.click(screen.getByLabelText('Norte'))
    await user.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ copyZoneIds: [second.id], policy: {
      menuEnabled: true, storeEnabled: true, weekdays: [2, 5], cutoffTime: '18:00', cutoffDayOffset: 1, closedDates: [],
    } }))
  })

  it('adds a closure and enables one channel without asking the shopper for a date', async () => {
    const user = userEvent.setup(); open()
    await user.click(screen.getByLabelText('Mostrar la próxima entrega estimada'))
    await user.click(screen.getByLabelText('Viernes'))
    await user.click(screen.getByText('Excepciones y dónde mostrarlo'))
    await user.click(screen.getByLabelText('Menú'))
    await user.type(screen.getByLabelText('Fecha sin reparto'), '2026-12-25')
    await user.click(screen.getByRole('button', { name: 'Agregar cierre' }))
    await user.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({ menuEnabled: false, storeEnabled: true, closedDates: ['2026-12-25'] }) }))
  })

  it('rejects extra decimals instead of silently rounding shipping fees', async () => {
    const user = userEvent.setup(); open()
    await user.clear(screen.getByLabelText('Costo de envío'))
    await user.type(screen.getByLabelText('Costo de envío'), '150.005')
    await user.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('hasta dos decimales')
  })

  it('retains entered data after a save failure', async () => {
    mocks.save.mockRejectedValue(new Error('Otra persona cambió este calendario.'))
    const user = userEvent.setup(); open()
    await user.click(screen.getByRole('button', { name: 'Guardar zona' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Otra persona cambió')
    expect(screen.getByLabelText('Nombre')).toHaveValue('Centro')
    expect(onSaved).not.toHaveBeenCalled()
  })
})
