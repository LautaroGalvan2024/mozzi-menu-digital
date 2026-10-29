import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { LoadingScreen } from './components/Feedback'

const AuthenticatedProviders = lazy(() => import('./app/AuthenticatedProviders').then((module) => ({ default: module.AuthenticatedProviders })))
const RestaurantAdminProviders = lazy(() => import('./app/AdminProviders').then((module) => ({ default: module.RestaurantAdminProviders })))
const SuperAdminProviders = lazy(() => import('./app/AdminProviders').then((module) => ({ default: module.SuperAdminProviders })))
const AdminLayout = lazy(() => import('./components/AdminLayout').then((module) => ({ default: module.AdminLayout })))
const SuperAdminLayout = lazy(() => import('./components/SuperAdminLayout').then((module) => ({ default: module.SuperAdminLayout })))
const RequireAuth = lazy(() => import('./features/auth/RequireAuth').then((module) => ({ default: module.RequireAuth })))
const RequireRestaurantAdmin = lazy(() => import('./features/auth/RequireRestaurantAdmin').then((module) => ({ default: module.RequireRestaurantAdmin })))
const LandingPage = lazy(() => import('./pages/LandingPage').then((module) => ({ default: module.LandingPage })))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })))
const LoginPage = lazy(() => import('./features/auth/LoginPage').then((module) => ({ default: module.LoginPage })))
const AuthenticatedEntryPage = lazy(() => import('./features/auth/AuthenticatedEntryPage').then((module) => ({ default: module.AuthenticatedEntryPage })))
const AuthCallbackPage = lazy(() => import('./features/auth/AuthCallbackPage').then((module) => ({ default: module.AuthCallbackPage })))
const SetPasswordPage = lazy(() => import('./features/auth/SetPasswordPage').then((module) => ({ default: module.SetPasswordPage })))
const ForgotPasswordPage = lazy(() => import('./features/auth/ForgotPasswordPage').then((module) => ({ default: module.ForgotPasswordPage })))
const MfaPage = lazy(() => import('./features/auth/MfaPage').then((module) => ({ default: module.MfaPage })))
const SecurityPage = lazy(() => import('./features/auth/SecurityPage').then((module) => ({ default: module.SecurityPage })))
const RestaurantSelectPage = lazy(() => import('./features/restaurants/RestaurantSelectPage').then((module) => ({ default: module.RestaurantSelectPage })))
const AdminDashboardPage = lazy(() => import('./features/restaurants/AdminDashboardPage').then((module) => ({ default: module.AdminDashboardPage })))
const RestaurantSettingsPage = lazy(() => import('./features/restaurants/RestaurantSettingsPage').then((module) => ({ default: module.RestaurantSettingsPage })))
const StoreSettingsPage = lazy(() => import('./features/restaurants/StoreSettingsPage').then((module) => ({ default: module.StoreSettingsPage })))
const BrandPage = lazy(() => import('./features/restaurants/BrandPage').then((module) => ({ default: module.BrandPage })))
const UsersPage = lazy(() => import('./features/restaurants/UsersPage').then((module) => ({ default: module.UsersPage })))
const HoursPage = lazy(() => import('./features/business-hours/HoursPage').then((module) => ({ default: module.HoursPage })))
const CategoriesPage = lazy(() => import('./features/catalog/CategoriesPage').then((module) => ({ default: module.CategoriesPage })))
const ProductsPage = lazy(() => import('./features/catalog/ProductsPage').then((module) => ({ default: module.ProductsPage })))
const ProductEditorPage = lazy(() => import('./features/catalog/ProductEditorPage').then((module) => ({ default: module.ProductEditorPage })))
const ImportProductsPage = lazy(() => import('./features/catalog/ImportProductsPage').then((module) => ({ default: module.ImportProductsPage })))
const DeliveryZonesPage = lazy(() => import('./features/delivery/DeliveryZonesPage').then((module) => ({ default: module.DeliveryZonesPage })))
const PaymentMethodsPage = lazy(() => import('./features/payments/PaymentMethodsPage').then((module) => ({ default: module.PaymentMethodsPage })))
const OrdersPage = lazy(() => import('./features/orders/OrdersPage').then((module) => ({ default: module.OrdersPage })))
const InventoryPage = lazy(() => import('./features/inventory/InventoryPage').then((module) => ({ default: module.InventoryPage })))
const OrderDetailPage = lazy(() => import('./features/orders/OrderDetailPage').then((module) => ({ default: module.OrderDetailPage })))
const ClaimOrderPage = lazy(() => import('./features/orders/ClaimOrderPage').then((module) => ({ default: module.ClaimOrderPage })))
const SuperAdminDashboardPage = lazy(() => import('./features/superadmin/SuperAdminDashboardPage').then((module) => ({ default: module.SuperAdminDashboardPage })))
const RestaurantsPage = lazy(() => import('./features/superadmin/RestaurantsPage').then((module) => ({ default: module.RestaurantsPage })))
const CreateRestaurantPage = lazy(() => import('./features/superadmin/CreateRestaurantPage').then((module) => ({ default: module.CreateRestaurantPage })))
const SuperRestaurantDetailPage = lazy(() => import('./features/superadmin/RestaurantDetailPage').then((module) => ({ default: module.SuperRestaurantDetailPage })))
const PlatformUsersPage = lazy(() => import('./features/superadmin/PlatformUsersPage').then((module) => ({ default: module.PlatformUsersPage })))
const AuditPage = lazy(() => import('./features/superadmin/AuditPage').then((module) => ({ default: module.AuditPage })))
const SuperSecurityPage = lazy(() => import('./features/superadmin/SuperSecurityPage').then((module) => ({ default: module.SuperSecurityPage })))

function route(element: ReactNode, label = 'Cargando módulo…') {
  return <Suspense fallback={<LoadingScreen label={label} />}>{element}</Suspense>
}

function CommerceFallback() {
  return <LoadingScreen label="Preparando el comercio…" />
}

const router = createBrowserRouter([
  { path: '/', element: route(<LandingPage />, 'Cargando…') },
  {
    HydrateFallback: CommerceFallback,
    loader: ({ params, request }) => {
      const slug = params.restaurantSlug
      if (!slug) return null
      const pathname = new URL(request.url).pathname
      const channel = pathname.startsWith('/t/') ? 'store' : 'menu'
      if (pathname === `/r/${slug}` || pathname === `/t/${slug}` || pathname.startsWith(`/t/${slug}/producto/`)) {
        void import('./app/preload-public-catalog').then((module) => {
          module.preloadPublicCatalog(slug, channel)
        })
      }
      return null
    },
    lazy: async () => {
      const module = await import('./app/CommerceProviders')
      return { Component: module.CommerceProviders }
    },
    children: [
      { path: '/r/:restaurantSlug', lazy: async () => { const module = await import('./features/public-menu/PublicMenuPage'); return { Component: module.PublicMenuPage } } },
      { path: '/r/:restaurantSlug/carrito', lazy: async () => { const module = await import('./features/cart/CartPage'); return { Component: module.CartPage } } },
      { path: '/r/:restaurantSlug/checkout', lazy: async () => { const module = await import('./features/checkout/CheckoutPage'); return { Component: module.CheckoutPage } } },
      { path: '/r/:restaurantSlug/pedido-generado', lazy: async () => { const module = await import('./features/checkout/OrderGeneratedPage'); return { Component: module.OrderGeneratedPage } } },
      { path: '/t/:restaurantSlug', lazy: async () => { const module = await import('./features/store/PublicStorePage'); return { Component: module.PublicStorePage } } },
      { path: '/t/:restaurantSlug/producto/:productId', lazy: async () => { const module = await import('./features/store/PublicStorePage'); return { Component: module.PublicStorePage } } },
      { path: '/t/:restaurantSlug/carrito', lazy: async () => { const module = await import('./features/cart/CartPage'); return { Component: module.CartPage } } },
      { path: '/t/:restaurantSlug/checkout', lazy: async () => { const module = await import('./features/checkout/CheckoutPage'); return { Component: module.CheckoutPage } } },
      { path: '/t/:restaurantSlug/pedido-generado', lazy: async () => { const module = await import('./features/checkout/OrderGeneratedPage'); return { Component: module.OrderGeneratedPage } } },
      { path: '/t/:restaurantSlug/pago', lazy: async () => { const module = await import('./features/store/PaymentStatusPage'); return { Component: module.PaymentStatusPage } } },
    ],
  },
  {
    element: route(<AuthenticatedProviders />),
    children: [
      { path: '/login', element: route(<LoginPage />) },
      { path: '/auth/continue', element: route(<AuthenticatedEntryPage />) },
      { path: '/auth/callback', element: route(<AuthCallbackPage />) },
      { path: '/auth/set-password', element: route(<SetPasswordPage />) },
      { path: '/auth/forgot-password', element: route(<ForgotPasswordPage />) },
      { path: '/auth/reset-password', element: route(<SetPasswordPage />) },
      { path: '/auth/mfa', element: route(<MfaPage />) },
      {
        element: route(<RequireAuth />),
        children: [
          {
            element: route(<RestaurantAdminProviders />),
            children: [
              { path: '/admin/seleccionar-restaurante', element: route(<RestaurantSelectPage />) },
              { path: '/admin/pedidos/tomar/:actionId', element: route(<ClaimOrderPage />) },
              {
                path: '/admin',
                element: route(<AdminLayout />),
                children: [
                  { index: true, element: route(<AdminDashboardPage />) },
                  { path: 'pedidos', element: route(<OrdersPage />) },
                  { path: 'stock', element: route(<InventoryPage />) },
                  { path: 'pedidos/:orderId', element: route(<OrderDetailPage />) },
                  { path: 'seguridad', element: route(<SecurityPage />) },
                  {
                    element: route(<RequireRestaurantAdmin />),
                    children: [
                      { path: 'configuracion', element: route(<RestaurantSettingsPage />) },
                      { path: 'tienda', element: route(<StoreSettingsPage />) },
                      { path: 'marca', element: route(<BrandPage />) },
                      { path: 'horarios', element: route(<HoursPage />) },
                      { path: 'medios-de-pago', element: route(<PaymentMethodsPage />) },
                      { path: 'zonas-de-envio', element: route(<DeliveryZonesPage />) },
                      { path: 'catalogo/categorias', element: route(<CategoriesPage />) },
                      { path: 'catalogo/productos', element: route(<ProductsPage />) },
                      { path: 'catalogo/productos/nuevo', element: route(<ProductEditorPage />) },
                      { path: 'catalogo/productos/:productId', element: route(<ProductEditorPage />) },
                      { path: 'catalogo/importar', element: route(<ImportProductsPage />) },
                      { path: 'usuarios', element: route(<UsersPage />) },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        element: route(<RequireAuth superAdmin />),
        children: [
          {
            element: route(<SuperAdminProviders />),
            children: [
              {
                path: '/superadmin',
                element: route(<SuperAdminLayout />),
                children: [
                  { index: true, element: route(<SuperAdminDashboardPage />) },
                  { path: 'restaurantes', element: route(<RestaurantsPage />) },
                  { path: 'restaurantes/nuevo', element: route(<CreateRestaurantPage />) },
                  { path: 'restaurantes/:id', element: route(<SuperRestaurantDetailPage />) },
                  { path: 'usuarios', element: route(<PlatformUsersPage />) },
                  { path: 'auditoria', element: route(<AuditPage />) },
                  { path: 'seguridad', element: route(<SuperSecurityPage />) },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: route(<NotFoundPage />) },
])

export default function App() {
  return <RouterProvider router={router} />
}
