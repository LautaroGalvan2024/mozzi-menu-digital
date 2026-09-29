import { lazy, Suspense } from 'react'
import { createBrowserRouter,RouterProvider } from 'react-router'
import { AdminLayout } from './components/AdminLayout'
import { LoadingScreen } from './components/Feedback'
import { SuperAdminLayout } from './components/SuperAdminLayout'
import { RequireAuth } from './features/auth/RequireAuth'
import { RequireRestaurantAdmin } from './features/auth/RequireRestaurantAdmin'

const LandingPage=lazy(()=>import('./pages/LandingPage').then((module)=>({default:module.LandingPage})))
const NotFoundPage=lazy(()=>import('./pages/NotFoundPage').then((module)=>({default:module.NotFoundPage})))
const PublicMenuPage=lazy(()=>import('./features/public-menu/PublicMenuPage').then((module)=>({default:module.PublicMenuPage})))
const CartPage=lazy(()=>import('./features/cart/CartPage').then((module)=>({default:module.CartPage})))
const CheckoutPage=lazy(()=>import('./features/checkout/CheckoutPage').then((module)=>({default:module.CheckoutPage})))
const OrderGeneratedPage=lazy(()=>import('./features/checkout/OrderGeneratedPage').then((module)=>({default:module.OrderGeneratedPage})))
const LoginPage=lazy(()=>import('./features/auth/LoginPage').then((module)=>({default:module.LoginPage})))
const AuthenticatedEntryPage=lazy(()=>import('./features/auth/AuthenticatedEntryPage').then((module)=>({default:module.AuthenticatedEntryPage})))
const AuthCallbackPage=lazy(()=>import('./features/auth/AuthCallbackPage').then((module)=>({default:module.AuthCallbackPage})))
const SetPasswordPage=lazy(()=>import('./features/auth/SetPasswordPage').then((module)=>({default:module.SetPasswordPage})))
const ForgotPasswordPage=lazy(()=>import('./features/auth/ForgotPasswordPage').then((module)=>({default:module.ForgotPasswordPage})))
const MfaPage=lazy(()=>import('./features/auth/MfaPage').then((module)=>({default:module.MfaPage})))
const SecurityPage=lazy(()=>import('./features/auth/SecurityPage').then((module)=>({default:module.SecurityPage})))
const RestaurantSelectPage=lazy(()=>import('./features/restaurants/RestaurantSelectPage').then((module)=>({default:module.RestaurantSelectPage})))
const AdminDashboardPage=lazy(()=>import('./features/restaurants/AdminDashboardPage').then((module)=>({default:module.AdminDashboardPage})))
const RestaurantSettingsPage=lazy(()=>import('./features/restaurants/RestaurantSettingsPage').then((module)=>({default:module.RestaurantSettingsPage})))
const BrandPage=lazy(()=>import('./features/restaurants/BrandPage').then((module)=>({default:module.BrandPage})))
const UsersPage=lazy(()=>import('./features/restaurants/UsersPage').then((module)=>({default:module.UsersPage})))
const HoursPage=lazy(()=>import('./features/business-hours/HoursPage').then((module)=>({default:module.HoursPage})))
const CategoriesPage=lazy(()=>import('./features/catalog/CategoriesPage').then((module)=>({default:module.CategoriesPage})))
const ProductsPage=lazy(()=>import('./features/catalog/ProductsPage').then((module)=>({default:module.ProductsPage})))
const ProductEditorPage=lazy(()=>import('./features/catalog/ProductEditorPage').then((module)=>({default:module.ProductEditorPage})))
const ImportProductsPage=lazy(()=>import('./features/catalog/ImportProductsPage').then((module)=>({default:module.ImportProductsPage})))
const DeliveryZonesPage=lazy(()=>import('./features/delivery/DeliveryZonesPage').then((module)=>({default:module.DeliveryZonesPage})))
const PaymentMethodsPage=lazy(()=>import('./features/payments/PaymentMethodsPage').then((module)=>({default:module.PaymentMethodsPage})))
const OrdersPage=lazy(()=>import('./features/orders/OrdersPage').then((module)=>({default:module.OrdersPage})))
const OrderDetailPage=lazy(()=>import('./features/orders/OrderDetailPage').then((module)=>({default:module.OrderDetailPage})))
const ClaimOrderPage=lazy(()=>import('./features/orders/ClaimOrderPage').then((module)=>({default:module.ClaimOrderPage})))
const SuperAdminDashboardPage=lazy(()=>import('./features/superadmin/SuperAdminDashboardPage').then((module)=>({default:module.SuperAdminDashboardPage})))
const RestaurantsPage=lazy(()=>import('./features/superadmin/RestaurantsPage').then((module)=>({default:module.RestaurantsPage})))
const CreateRestaurantPage=lazy(()=>import('./features/superadmin/CreateRestaurantPage').then((module)=>({default:module.CreateRestaurantPage})))
const SuperRestaurantDetailPage=lazy(()=>import('./features/superadmin/RestaurantDetailPage').then((module)=>({default:module.SuperRestaurantDetailPage})))
const PlatformUsersPage=lazy(()=>import('./features/superadmin/PlatformUsersPage').then((module)=>({default:module.PlatformUsersPage})))
const AuditPage=lazy(()=>import('./features/superadmin/AuditPage').then((module)=>({default:module.AuditPage})))
const SuperSecurityPage=lazy(()=>import('./features/superadmin/SuperSecurityPage').then((module)=>({default:module.SuperSecurityPage})))

const router=createBrowserRouter([
  {path:'/',element:<LandingPage/>},
  {path:'/r/:restaurantSlug',element:<PublicMenuPage/>},
  {path:'/r/:restaurantSlug/carrito',element:<CartPage/>},
  {path:'/r/:restaurantSlug/checkout',element:<CheckoutPage/>},
  {path:'/r/:restaurantSlug/pedido-generado',element:<OrderGeneratedPage/>},
  {path:'/login',element:<LoginPage/>},
  {path:'/auth/continue',element:<AuthenticatedEntryPage/>},
  {path:'/auth/callback',element:<AuthCallbackPage/>},
  {path:'/auth/set-password',element:<SetPasswordPage/>},
  {path:'/auth/forgot-password',element:<ForgotPasswordPage/>},
  {path:'/auth/reset-password',element:<SetPasswordPage/>},
  {path:'/auth/mfa',element:<MfaPage/>},
  {element:<RequireAuth/>,children:[
    {path:'/admin/seleccionar-restaurante',element:<RestaurantSelectPage/>},
    {path:'/admin/pedidos/tomar/:actionId',element:<ClaimOrderPage/>},
    {path:'/admin',element:<AdminLayout/>,children:[
      {index:true,element:<AdminDashboardPage/>},
      {path:'pedidos',element:<OrdersPage/>},
      {path:'pedidos/:orderId',element:<OrderDetailPage/>},
      {path:'seguridad',element:<SecurityPage/>},
      {element:<RequireRestaurantAdmin/>,children:[
        {path:'configuracion',element:<RestaurantSettingsPage/>},
        {path:'marca',element:<BrandPage/>},
        {path:'horarios',element:<HoursPage/>},
        {path:'medios-de-pago',element:<PaymentMethodsPage/>},
        {path:'zonas-de-envio',element:<DeliveryZonesPage/>},
        {path:'catalogo/categorias',element:<CategoriesPage/>},
        {path:'catalogo/productos',element:<ProductsPage/>},
        {path:'catalogo/productos/nuevo',element:<ProductEditorPage/>},
        {path:'catalogo/productos/:productId',element:<ProductEditorPage/>},
        {path:'catalogo/importar',element:<ImportProductsPage/>},
        {path:'usuarios',element:<UsersPage/>},
      ]},
    ]},
  ]},
  {element:<RequireAuth superAdmin/>,children:[
    {path:'/superadmin',element:<SuperAdminLayout/>,children:[
      {index:true,element:<SuperAdminDashboardPage/>},
      {path:'restaurantes',element:<RestaurantsPage/>},
      {path:'restaurantes/nuevo',element:<CreateRestaurantPage/>},
      {path:'restaurantes/:id',element:<SuperRestaurantDetailPage/>},
      {path:'usuarios',element:<PlatformUsersPage/>},
      {path:'auditoria',element:<AuditPage/>},
      {path:'seguridad',element:<SuperSecurityPage/>},
    ]},
  ]},
  {path:'*',element:<NotFoundPage/>},
])

export default function App(){return <Suspense fallback={<LoadingScreen label="Cargando módulo…"/>}><RouterProvider router={router}/></Suspense>}
