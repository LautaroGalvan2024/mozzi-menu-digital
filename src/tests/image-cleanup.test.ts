import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupRestaurantImage } from '../lib/images/cleanup'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), remove: vi.fn() }))
vi.mock('../lib/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, storage: { from: () => ({ remove: mocks.remove }) } },
}))
const tenant = '10000000-0000-4000-8000-000000000001'
const primary = `restaurants/${tenant}/products/image-1200.webp`
const paths = [320, 640, 1200].map(width => `restaurants/${tenant}/products/image-${width}.webp`)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockResolvedValue({ data: { retained: false, paths }, error: null })
  mocks.remove.mockResolvedValue({ data: paths.map(name => ({ name })), error: null })
})

describe('server-authorized image cleanup', () => {
  it('retains an image shared by a family without treating it as a failed save', async () => {
    mocks.rpc.mockResolvedValue({ data: { retained: true, paths: [] }, error: null })
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('retained')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('prepares a durable retirement before deleting exactly the server-authorized variants', async () => {
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('removed')
    expect(mocks.rpc).toHaveBeenCalledWith('prepare_image_asset_cleanup', { p_restaurant_id: tenant, p_path: primary })
    expect(mocks.remove).toHaveBeenCalledWith(paths)
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!)
  })

  it('preserves bytes if the migration is unavailable or authorization fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('pending')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('does not delete on malformed or foreign-tenant preparation', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { retained: false, paths: ['restaurants/other/products/x.webp'] }, error: null })
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('pending')
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('pending')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('leaves a failed Storage request pending for safe retry', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('network'))
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('pending')
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('removed')
  })

  it('does not report success when Storage filters or partially removes requested objects', async () => {
    mocks.remove.mockResolvedValue({ data: [{ name: paths[0] }], error: null })
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('pending')
  })

  it('finishes an idempotent retry when the objects were already removed', async () => {
    mocks.rpc.mockResolvedValue({ data: { retained: false, paths: [] }, error: null })
    expect(await cleanupRestaurantImage(tenant, primary)).toBe('removed')
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
