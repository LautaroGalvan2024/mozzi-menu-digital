import { Check, Circle } from 'lucide-react'

export function PasswordStrength({ password }: { password: string }) {
  const checks = [
    ['12 caracteres', password.length >= 12],
    ['una mayúscula', /[A-Z]/.test(password)],
    ['una minúscula', /[a-z]/.test(password)],
    ['un número', /\d/.test(password)],
    ['un símbolo', /[^\w\s]/.test(password)],
  ] as const
  const score = checks.filter(([, valid]) => valid).length
  return (
    <div aria-live="polite" className="space-y-2 text-sm">
      <div className="h-2 overflow-hidden rounded-full bg-stone-200">
        <div
          className="h-full rounded-full bg-emerald-600 transition-all"
          style={{ width: `${score * 20}%` }}
        />
      </div>
      <ul className="grid gap-1 text-stone-600 sm:grid-cols-2">
        {checks.map(([label, valid]) => (
          <li key={label} className="flex items-center gap-1.5">
            {valid ? (
              <Check className="h-4 w-4 text-emerald-700" aria-hidden />
            ) : (
              <Circle className="h-3 w-3" aria-hidden />
            )}
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}
