import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './features/auth/AuthProvider.tsx'
import { CartProvider } from './features/cart/CartProvider.tsx'
import { RestaurantScopeProvider } from './features/restaurants/RestaurantScope.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RestaurantScopeProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </RestaurantScopeProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
