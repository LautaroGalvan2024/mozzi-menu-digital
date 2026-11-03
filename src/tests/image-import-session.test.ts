import { beforeEach, describe, expect, it } from 'vitest'
import { latestImageOnlySession, persistImageOnlySession, prepareImageOnlySession } from '../lib/images/image-import-session'

const tenant = '10000000-0000-4000-8000-000000000001'
const targets = [{ key: 'a.png', filename: 'a.png', productId: '20000000-0000-4000-8000-000000000001', expectedPath: null }]
describe('independent image import recovery', () => {
  beforeEach(() => {
    localStorage.clear()
    const tails = new Map<string, Promise<unknown>>()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, callback: () => unknown) => {
      const pending = (tails.get(name) ?? Promise.resolve()).then(callback)
      tails.set(name, pending.catch(() => undefined)); return pending
    } } })
  })
  it('reuses archive and mapping identity across filenames and ignores a changed current image during recovery', async () => {
    const session = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'a.zip', targets)
    session.started = true
    session.attempts['a.png'] = { path: 'new.webp', expectedPath: null, associated: false }
    await persistImageOnlySession(session)
    const replay = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'renamed.zip', [{ ...targets[0]!, expectedPath: 'new.webp' }])
    expect(replay.id).toBe(session.id)
    expect(replay.targets[0]?.expectedPath).toBeNull()
    expect(replay.attempts['a.png']?.path).toBe('new.webp')
    expect(latestImageOnlySession('10000000-0000-4000-8000-000000000002')).toBeNull()
  })
  it('preserves completed attempts across stale saves and keeps the live attempt object usable', async () => {
    const session = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'a.zip', targets)
    session.attempts['a.png'] = { path: 'new.webp', expectedPath: null, associated: false }
    await persistImageOnlySession(session)
    const stale = structuredClone(session)
    const attempts = session.attempts
    const activeAttempt = attempts['a.png']!
    await persistImageOnlySession(session)
    expect(session.attempts['a.png']).toBe(activeAttempt)
    attempts['a.png']!.associated = true
    await persistImageOnlySession(session)
    expect(session.attempts).toBe(attempts)
    await persistImageOnlySession(stale)
    expect(latestImageOnlySession(tenant)?.attempts['a.png']?.associated).toBe(true)
  })
  it('separates changed ZIPs and mappings and allows a deliberate new operation', async () => {
    const original = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'a.zip', targets)
    const changedZip = await prepareImageOnlySession(tenant, 'b'.repeat(64), 'a.zip', targets)
    const changedMapping = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'a.zip', [{ ...targets[0]!, productId: '20000000-0000-4000-8000-000000000002' }])
    const deliberate = await prepareImageOnlySession(tenant, 'a'.repeat(64), 'a.zip', targets, true)
    expect(new Set([original.id, changedZip.id, changedMapping.id, deliberate.id]).size).toBe(4)
  })
})
