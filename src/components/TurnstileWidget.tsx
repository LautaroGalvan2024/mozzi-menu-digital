import { useEffect, useRef, useState } from 'react'

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      action: string
      theme: 'auto'
      size: 'flexible'
      callback: (token: string) => void
      'expired-callback': () => void
      'timeout-callback': () => void
      'error-callback': () => void
    },
  ) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_ID = 'cloudflare-turnstile-script'
let loadingScript: Promise<TurnstileApi> | null = null

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (loadingScript) return loadingScript
  loadingScript = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    const script = existing ?? document.createElement('script')
    const loaded = () => window.turnstile
      ? resolve(window.turnstile)
      : reject(new Error('Turnstile no quedó disponible.'))
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar Turnstile.')), { once: true })
    if (!existing) {
      script.id = SCRIPT_ID
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      document.head.append(script)
    }
  }).catch((error) => {
    loadingScript = null
    throw error
  })
  return loadingScript
}

export function TurnstileWidget({
  siteKey,
  onTokenChange,
}: {
  siteKey: string
  onTokenChange: (token: string | null) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    let api: TurnstileApi | null = null
    let widgetId: string | null = null
    onTokenChange(null)
    setFailed(false)
    void loadTurnstile()
      .then((loadedApi) => {
        if (disposed || !container.current) return
        api = loadedApi
        widgetId = loadedApi.render(container.current, {
          sitekey: siteKey,
          action: 'create_order',
          theme: 'auto',
          size: 'flexible',
          callback: (token) => onTokenChange(token),
          'expired-callback': () => onTokenChange(null),
          'timeout-callback': () => onTokenChange(null),
          'error-callback': () => {
            onTokenChange(null)
            setFailed(true)
          },
        })
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      onTokenChange(null)
      if (api && widgetId) api.remove(widgetId)
    }
  }, [onTokenChange, siteKey])

  return (
    <div>
      <div ref={container} />
      {failed ? <p className="form-error mt-2" role="alert">No se pudo validar el control anti-spam. Revisá tu conexión y reintentá.</p> : null}
    </div>
  )
}

