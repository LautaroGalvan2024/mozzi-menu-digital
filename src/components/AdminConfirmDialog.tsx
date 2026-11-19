import { useEffect, useId, useRef } from 'react'

export function AdminConfirmDialog({ title, description, confirmLabel, onCancel, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.open = true
    cancel.current?.focus()
    return () => {
      if (element.open && typeof element.close === 'function') element.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  return <dialog
    ref={dialog}
    className="admin-confirm-dialog"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel() }}
  >
    <div className="admin-confirm-content">
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
    </div>
    <footer className="admin-confirm-actions">
      <button ref={cancel} className="button-secondary" type="button" onClick={onCancel}>Cancelar</button>
      <button className="button-danger" type="button" onClick={onConfirm}>{confirmLabel}</button>
    </footer>
  </dialog>
}
