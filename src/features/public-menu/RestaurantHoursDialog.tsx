import { CalendarDays, Clock3, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  buildUpcomingHoursExceptions,
  buildWeeklyHours,
} from '../../lib/hours'
import type { BusinessHour, SpecialHour } from '../../types/domain'

export interface RestaurantHoursDialogProps {
  restaurantName: string
  timeZone: string
  locale: string
  businessHours: readonly BusinessHour[]
  specialHours: readonly SpecialHour[]
  onClose: () => void
  now?: Date
}

export function RestaurantHoursDialog({
  restaurantName,
  timeZone,
  locale,
  businessHours,
  specialHours,
  onClose,
  now,
}: RestaurantHoursDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const [referenceTime] = useState(() => now ?? new Date())
  const titleId = useId()
  const descriptionId = useId()
  const weeklyHours = useMemo(() => buildWeeklyHours(businessHours), [businessHours])
  const upcomingExceptions = useMemo(
    () => buildUpcomingHoursExceptions({ specialHours, now: referenceTime, timeZone, locale }),
    [locale, referenceTime, specialHours, timeZone],
  )

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleClose = () => onCloseRef.current()
    dialog.addEventListener('close', handleClose)
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    return () => dialog.removeEventListener('close', handleClose)
  }, [])

  function close() {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.close === 'function') dialog.close()
    else {
      dialog.removeAttribute('open')
      onCloseRef.current()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="hours-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(event) => {
        if (event.target === dialogRef.current) close()
      }}
    >
      <div className="relative flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[2rem] bg-white shadow-2xl sm:rounded-[2rem]">
        <header className="flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-5 sm:px-7 sm:py-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-orange-700">
              <Clock3 className="h-5 w-5 shrink-0" aria-hidden />
              <p className="text-xs font-bold uppercase tracking-[.14em]">Horarios de atención</p>
            </div>
            <h2 id={titleId} className="mt-2 font-display text-2xl font-bold tracking-tight text-stone-950">
              {restaurantName}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm leading-5 text-stone-500">
              Horarios habituales y próximas modificaciones.
            </p>
          </div>
          <button
            type="button"
            className="icon-button -mr-2 -mt-2"
            aria-label="Cerrar horarios"
            onClick={close}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7 sm:py-6">
          <section aria-labelledby={`${titleId}-weekly`}>
            <h3 id={`${titleId}-weekly`} className="font-display text-lg font-bold text-stone-950">
              Semana habitual
            </h3>
            <dl className="mt-3 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white">
              {weeklyHours.map((day) => (
                <div
                  key={day.dayOfWeek}
                  className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]"
                  data-testid={`weekly-day-${day.dayOfWeek}`}
                >
                  <dt className="font-semibold text-stone-950">{day.label}</dt>
                  <dd className="space-y-1 text-right text-stone-600">
                    {day.slots.length > 0 ? (
                      day.slots.map((slot) => <span className="block" key={slot.id}>{slot.label}</span>)
                    ) : (
                      <span className="font-medium text-stone-400">Cerrado</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {upcomingExceptions.length > 0 ? (
            <section className="mt-7" aria-labelledby={`${titleId}-exceptions`}>
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-orange-700" aria-hidden />
                <h3 id={`${titleId}-exceptions`} className="font-display text-lg font-bold text-stone-950">
                  Próximas excepciones
                </h3>
              </div>
              <ul className="mt-3 space-y-2">
                {upcomingExceptions.map((exception) => (
                  <li
                    key={exception.date}
                    className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3"
                    data-testid={`hours-exception-${exception.date}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="font-semibold text-stone-950">{exception.dateLabel}</p>
                      <div className="text-sm font-medium text-stone-700">
                        {exception.isClosed ? (
                          <span>Cerrado</span>
                        ) : (
                          exception.slots.map((slot) => <span className="block text-right" key={slot.id}>{slot.label}</span>)
                        )}
                      </div>
                    </div>
                    {exception.reason ? <p className="mt-1 text-xs leading-5 text-stone-600">{exception.reason}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </dialog>
  )
}
