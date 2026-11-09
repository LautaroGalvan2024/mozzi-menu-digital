import { describe, expect, it } from 'vitest'
import { inferredCategoryIcon, resolvedCategoryIcon } from '../lib/category-icons'

describe('category icon presentation', () => {
  it.each([
    ['Alimentos para Animales', 'pets'],
    ['Bebidas', 'drinks'],
    ['Bebidas alcohólicas', 'wine'],
    ['Condimentos', 'spices'],
    ['Higiene Personal', 'hygiene'],
    ['Infusiones', 'infusions'],
    ['Lácteos', 'dairy'],
    ['Limpieza', 'cleaning'],
    ['Papeles', 'paper'],
    ['Snacks', 'snacks'],
    ['Verdulería', 'produce'],
  ])('infers %s as %s', (name, key) => {
    expect(inferredCategoryIcon(name)).toBe(key)
  })

  it('uses an explicit valid choice and ignores unknown stored values', () => {
    expect(resolvedCategoryIcon('Bebidas', 'infusions')).toBe('infusions')
    expect(resolvedCategoryIcon('Bebidas', 'not-an-icon')).toBe('drinks')
  })
})
