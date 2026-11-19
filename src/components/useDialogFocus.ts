import { useEffect, useRef, type RefObject } from 'react'

function visibleControls(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex]')).filter(control => {
    if (control.matches(':disabled,[tabindex="-1"],input[type="hidden"]')) return false
    for (let parent: HTMLElement | null = control; parent && parent !== dialog; parent = parent.parentElement) {
      if (parent.hidden || getComputedStyle(parent).display === 'none') return false
      if (parent instanceof HTMLDetailsElement && !parent.open && control !== parent.querySelector('summary')) return false
    }
    return true
  })
}

export function useDialogFocus(dialog: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  const escape = useRef(onEscape)
  useEffect(() => { escape.current = onEscape }, [onEscape])

  useEffect(() => {
    const element = dialog.current
    if (!active || !element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = visibleControls(element)
    const firstInput = controls.find(control => control instanceof HTMLInputElement)
    const initial = firstInput ?? controls[0] ?? element
    initial.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        escape.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = visibleControls(element)
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [active, dialog])
}
