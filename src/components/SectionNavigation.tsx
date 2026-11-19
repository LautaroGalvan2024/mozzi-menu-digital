import { CircleAlert, type LucideIcon } from 'lucide-react'
import './section-navigation.css'

interface Section<Key extends string> {
  id: Key
  label: string
  icon?: LucideIcon
}

export function SectionNavigation<Key extends string>({
  label,
  panelPrefix,
  sections,
  selected,
  onSelect,
  invalidSections,
}: {
  label: string
  panelPrefix: string
  sections: readonly Section<Key>[]
  selected: Key
  onSelect: (id: Key) => void
  invalidSections?: ReadonlySet<Key> | undefined
}) {
  return <nav className="section-navigation" aria-label={label}>
    <label className="field section-navigation-mobile">
      <span>{label}</span>
      <select value={selected} aria-controls={`${panelPrefix}-${selected}`} onChange={event => {
        const section = sections.find(item => item.id === event.currentTarget.value)
        if (section) onSelect(section.id)
      }}>
        {sections.map(section => <option key={section.id} value={section.id}>
          {section.label}{invalidSections?.has(section.id) ? ' · Revisar campos' : ''}
        </option>)}
      </select>
    </label>
    <div className="section-navigation-buttons">
      {sections.map(({ id, label: title, icon: Icon }) => <button
        key={id}
        className="section-navigation-button"
        type="button"
        aria-current={selected === id ? 'true' : undefined}
        aria-controls={`${panelPrefix}-${id}`}
        onClick={() => onSelect(id)}
      >
        {Icon ? <Icon aria-hidden /> : null}
        <span>{title}</span>
        {invalidSections?.has(id) ? <><CircleAlert className="section-navigation-issue" aria-hidden /><span className="sr-only">Revisar campos</span></> : null}
      </button>)}
    </div>
  </nav>
}
