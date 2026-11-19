import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Plus, Shield, UserCog } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AdminConfirmDialog } from '../../components/AdminConfirmDialog'
import { EmptyState, ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { invalidateRestaurantMemberQueries } from '../../lib/admin-cache'
import { supabase } from '../../lib/supabase/client'
import { listRestaurantMembers, type RestaurantMemberWithProfile } from './member-directory'
import { useRestaurantScope } from './RestaurantScope'

export function UsersPage() {
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const [show, setShow] = useState(false)
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<RestaurantMemberWithProfile['role']>('order_manager')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'info' | 'warning'; text: string } | null>(null)
  const [inviting, setInviting] = useState(false)
  const [suspending, setSuspending] = useState<RestaurantMemberWithProfile | null>(null)
  const inviteName = useRef<HTMLInputElement>(null)
  const restaurantId = scope.selected?.id
  const isSuperAdmin = scope.selected?.role === 'super_admin'
  const canInvite = isSuperAdmin || scope.selected?.role === 'restaurant_admin'
  const query = useQuery({
    queryKey: ['restaurant-users', restaurantId],
    enabled: Boolean(restaurantId),
    queryFn: () => listRestaurantMembers(restaurantId ?? ''),
  })
  useEffect(() => {
    if (show) inviteName.current?.focus()
  }, [show])

  if (query.isLoading) return <AdminLoading label="Cargando el equipo…" />
  if (query.error) return <ErrorPanel>{query.error.message}</ErrorPanel>

  async function send(member?: RestaurantMemberWithProfile) {
    if (inviting || !restaurantId) return
    setInviting(true)
    setError(null)
    setMessage(null)
    try {
      const body = member
        ? { restaurantId, resendUserId: member.user_id, role: member.role }
        : { restaurantId, email: email.trim(), fullName: fullName.trim(), role }
      const { data, error: invokeError } = await supabase.functions.invoke('invite-restaurant-user', { body })
      if (invokeError) {
        setError('No se pudo enviar la invitación. Verificá tu rol y los datos.')
        return
      }
      if (data?.invitationSent) setMessage({ tone: 'success', text: 'Invitación enviada por correo.' })
      else if (data?.deliveryPending) setMessage({ tone: 'warning', text: 'El acceso quedó guardado. Podés reintentar el envío en un minuto.' })
      else if (member || data?.membership?.status === 'invited') setMessage({ tone: 'warning', text: 'La invitación sigue pendiente. Si necesitás otro correo, reintentá en un minuto.' })
      else setMessage({ tone: 'info', text: 'Se actualizó el acceso de la cuenta existente. No se envió un correo nuevo.' })
      if (!member) {
        setShow(false)
        setEmail('')
        setFullName('')
      }
      await invalidateRestaurantMemberQueries(client, restaurantId)
    } catch {
      setError('No se pudo enviar la invitación. Verificá tu conexión e intentá nuevamente.')
    } finally {
      setInviting(false)
    }
  }

  function invite(event: FormEvent) {
    event.preventDefault()
    void send()
  }

  async function toggle(id: string, status: 'active' | 'suspended') {
    if (!restaurantId) return
    setError(null)
    const { error: rpcError } = await supabase.rpc('set_restaurant_member_status', {
      p_membership_id: id, p_status: status,
    })
    if (rpcError) {
      setError('No se pudo cambiar el acceso. Verificá tus permisos y evitá suspender el último administrador.')
      return
    }
    await invalidateRestaurantMemberQueries(client, restaurantId)
  }

  return <>
    <PageHeader title="Usuarios" description="Invitá a tu equipo y revisá quién tiene acceso al comercio."
      actions={canInvite ? <button type="button" className={show ? 'button-secondary' : 'button-primary'} aria-expanded={show} aria-controls={show ? 'invite-team' : undefined} disabled={inviting} onClick={() => setShow(value => !value)}>{!show ? <Plus className="h-4 w-4" aria-hidden /> : null}{show ? 'Cerrar invitación' : 'Invitar'}</button> : undefined} />
    {show && <form className="form-card mb-4" id="invite-team" onSubmit={invite}>
      <h2 className="form-card-title">Nueva invitación</h2>
      <div className="admin-team-fields">
        <label className="field"><span>Nombre</span><input ref={inviteName} disabled={inviting} required maxLength={120} value={fullName} onChange={e => setFullName(e.target.value)} /></label>
        <label className="field"><span>Correo</span><input disabled={inviting} type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="field"><span>Rol</span><select disabled={inviting} value={role} onChange={e => setRole(e.target.value as typeof role)}>
          <option value="order_manager">Gestor de pedidos</option>{isSuperAdmin && <option value="restaurant_admin">Administrador</option>}
        </select></label>
      </div>
      <p className="admin-muted mt-3">El gestor de pedidos tiene acceso a Pedidos y Stock.</p>
      <button aria-busy={inviting} className="button-primary mt-3" disabled={inviting} type="submit"><Mail className="h-4 w-4" aria-hidden />{inviting ? 'Enviando…' : 'Enviar invitación'}</button>
    </form>}
    {error && <InlineFeedback tone="error" className="mb-4">{error}</InlineFeedback>}
    {message && <InlineFeedback tone={message.tone} className="mb-4">{message.text}</InlineFeedback>}
    {query.data?.length ? <ul className="admin-team-list surface-card" aria-label="Personas con acceso">{query.data.map(member => {
      const manageable = isSuperAdmin || (canInvite && member.role === 'order_manager')
      return <li className="admin-team-row" key={member.id}>
        <div className="admin-record-person">
          <span className="admin-record-icon" aria-hidden>{member.role === 'restaurant_admin' ? <Shield size={18} /> : <UserCog size={18} />}</span>
          <div><h2>{member.profiles?.full_name ?? 'Invitación pendiente'}</h2><p>{member.profiles?.email ?? `Usuario …${member.user_id.slice(-8)}`}</p></div>
        </div>
        <div className="admin-team-permission">
          <span>{member.role === 'restaurant_admin' ? 'Administrador' : 'Gestor de pedidos'}</span>
          <span className={`admin-member-state admin-member-state--${member.status}`}>{member.status === 'active' ? 'Activo' : member.status === 'invited' ? 'Invitación pendiente' : 'Suspendido'}</span>
        </div>
        {manageable ? <div className="admin-record-actions">
          {member.status === 'invited' && <button type="button" disabled={inviting} className="button-secondary" onClick={() => void send(member)}>Reenviar invitación</button>}
          <button type="button" className={member.status === 'suspended' ? 'button-secondary' : 'button-danger'} onClick={() => member.status === 'suspended' ? void toggle(member.id, 'active') : setSuspending(member)}>{member.status === 'suspended' ? 'Reactivar' : 'Suspender'}</button>
        </div> : null}
      </li>
    })}</ul> : <EmptyState title="Todavía no hay personas para mostrar" description="Los accesos al comercio aparecen en esta lista." />}
    {suspending ? <AdminConfirmDialog
      title="¿Suspender este acceso?"
      description={`${suspending.profiles?.full_name ?? 'Esta persona'} perderá acceso al comercio.`}
      confirmLabel="Suspender acceso"
      onCancel={() => setSuspending(null)}
      onConfirm={() => { setSuspending(null); void toggle(suspending.id, 'suspended') }}
    /> : null}
  </>
}
