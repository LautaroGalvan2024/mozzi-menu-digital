const SELECTED_RESTAURANT_STORAGE_KEY = 'mozzi:selected-restaurant'

export function readSelectedRestaurant() {
  return localStorage.getItem(SELECTED_RESTAURANT_STORAGE_KEY)
}

export function persistSelectedRestaurant(id: string) {
  localStorage.setItem(SELECTED_RESTAURANT_STORAGE_KEY, id)
}

export function resolveSelectedChoice<T extends { id: string }>(
  choices: readonly T[],
  selectedId: string | null,
  allowFirstChoiceFallback: boolean,
): T | null {
  const explicitlySelected = choices.find((choice) => choice.id === selectedId)
  if (explicitlySelected) return explicitlySelected
  if (choices.length === 1 || allowFirstChoiceFallback) return choices[0] ?? null
  return null
}
