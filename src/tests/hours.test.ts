import { describe, expect, it } from 'vitest'
import { isRestaurantOpenAt } from '../lib/hours'
import type { BusinessHour, SpecialHour } from '../types/domain'

const overnight: BusinessHour[] = [{ id:'10000000-0000-4000-8000-000000000001', dayOfWeek:6, slotIndex:0, opensAt:'20:00', closesAt:'02:00', spansNextDay:true }]

describe('restaurant hours', () => {
  it('handles a shift that crosses midnight in the restaurant timezone', () => {
    expect(isRestaurantOpenAt({ now:new Date('2026-09-27T04:00:00Z'), timeZone:'America/Argentina/Cordoba', businessHours:overnight, specialHours:[] })).toBe(true)
    expect(isRestaurantOpenAt({ now:new Date('2026-09-27T06:00:00Z'), timeZone:'America/Argentina/Cordoba', businessHours:overnight, specialHours:[] })).toBe(false)
  })
  it('lets a closed special date override regular hours', () => {
    const regular:BusinessHour[]=[{id:'10000000-0000-4000-8000-000000000002',dayOfWeek:1,slotIndex:0,opensAt:'09:00',closesAt:'18:00',spansNextDay:false}]
    const special:SpecialHour[]=[{id:'10000000-0000-4000-8000-000000000003',date:'2026-09-28',isClosed:true,slotIndex:0,opensAt:null,closesAt:null,spansNextDay:false,reason:'Feriado'}]
    expect(isRestaurantOpenAt({now:new Date('2026-09-28T15:00:00Z'),timeZone:'America/Argentina/Cordoba',businessHours:regular,specialHours:special})).toBe(false)
  })
})
