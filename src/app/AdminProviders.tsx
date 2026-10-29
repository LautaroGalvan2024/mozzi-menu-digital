import { Outlet } from 'react-router'
import '../admin.css'
import { RestaurantScopeProvider } from '../features/restaurants/RestaurantScope'

export function RestaurantAdminProviders() {
  return (
    <RestaurantScopeProvider>
      <Outlet />
    </RestaurantScopeProvider>
  )
}

export function SuperAdminProviders() {
  return <Outlet />
}
