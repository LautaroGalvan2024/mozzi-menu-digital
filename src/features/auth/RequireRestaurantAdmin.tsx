import { Navigate, Outlet } from 'react-router'
import { LoadingScreen } from '../../components/Feedback'
import { useAuth } from './AuthProvider'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

export function RequireRestaurantAdmin(){const auth=useAuth();const scope=useRestaurantScope();if(scope.loading)return <LoadingScreen/>;if(auth.isSuperAdmin||scope.selected?.role==='restaurant_admin')return <Outlet/>;return <Navigate to="/admin/pedidos" replace/>}
