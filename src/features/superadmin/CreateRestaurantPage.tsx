import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Building2 } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useForm, type FieldErrors } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'
import { PageHeader } from '../../components/PageHeader'
import { invalidateRestaurantCreationQueries } from '../../lib/admin-cache'
import { parsePriceCents } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { restaurantCreateSchema } from '../../lib/validation/schemas'

const createResponseSchema = z.object({ restaurant: z.object({ id: z.string().uuid() }) })
const amountSchema = z.string().refine(value => parsePriceCents(value) !== null, 'Ingresá un importe válido, desde 0 y con hasta 2 decimales.')
const createFormSchema = restaurantCreateSchema.omit({ minimumOrderCents: true, initialDeliveryFeeCents: true }).extend({
  minimumOrder: amountSchema,
  initialDeliveryFee: amountSchema,
})
type CreateFormValues = z.infer<typeof createFormSchema>
const optionalFields = new Set<keyof CreateFormValues>([
  'currencyCode', 'timezone', 'primaryColor', 'secondaryColor', 'deliveryEnabled', 'pickupEnabled',
  'minimumOrder', 'initialDeliveryFee', 'defaultPreparationMinutes',
])

export function CreateRestaurantPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const optionalSection = useRef<HTMLDetailsElement>(null)
  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createFormSchema),
    shouldFocusError: false,
    defaultValues: {
      name: '', slug: '', tradeName: '', description: '', whatsappPhone: '', address: '', city: '',
      timezone: 'America/Argentina/Cordoba', currencyCode: 'ARS', primaryColor: '#ea580c', secondaryColor: '#1c1917',
      deliveryEnabled: true, pickupEnabled: true, minimumOrder: '0', initialDeliveryFee: '0',
      defaultPreparationMinutes: 30, adminName: '', adminEmail: '',
    },
  })
  const currency = form.watch('currencyCode').trim().toUpperCase() || 'ARS'
  const errors = form.formState.errors

  function revealErrors(validationErrors: FieldErrors<CreateFormValues>) {
    const fields = Object.keys(validationErrors) as (keyof CreateFormValues)[]
    if (fields.some(field => optionalFields.has(field)) && optionalSection.current) optionalSection.current.open = true
    if (fields[0]) form.setFocus(fields[0])
  }

  const submit = form.handleSubmit(async values => {
    setError(null)
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('create-restaurant', {
        body: {
          idempotencyKey, name: values.name, slug: values.slug, tradeName: values.tradeName,
          description: values.description, whatsappPhoneE164: values.whatsappPhone,
          address: values.address, city: values.city, timezone: values.timezone, currencyCode: values.currencyCode.toUpperCase(),
          primaryColor: values.primaryColor, secondaryColor: values.secondaryColor,
          deliveryEnabled: values.deliveryEnabled, pickupEnabled: values.pickupEnabled,
          minimumOrderCents: parsePriceCents(values.minimumOrder)!,
          initialDeliveryFeeCents: parsePriceCents(values.initialDeliveryFee)!,
          defaultPreparationMinutes: values.defaultPreparationMinutes,
          administrator: { fullName: values.adminName, email: values.adminEmail },
        },
      })
      const result = createResponseSchema.safeParse(data)
      if (invokeError || !result.success) {
        setError('No se pudo crear el comercio. Revisá el enlace, el correo del administrador y tu verificación en dos pasos.')
        return
      }
      await invalidateRestaurantCreationQueries(queryClient)
      navigate(`/superadmin/restaurantes/${result.data.restaurant.id}`, { replace: true })
    } catch {
      setError('No se pudo crear el comercio. Verificá tu conexión e intentá nuevamente.')
    }
  }, revealErrors)

  return <>
    <PageHeader eyebrow="Comercios" title="Crear comercio" description="Creá el comercio e invitá a su primer administrador. El menú y la tienda se publican después de completar el catálogo." actions={<Link className="button-secondary" to="/superadmin/restaurantes"><ArrowLeft className="h-4 w-4" />Volver</Link>} />
    <form className="space-y-6" onSubmit={submit} noValidate>
      <FormSection title="Identidad">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre interno" error={errors.name?.message}><input {...form.register('name')} /></Field>
          <Field label="Nombre comercial" error={errors.tradeName?.message}><input {...form.register('tradeName')} /></Field>
          <Field label="Dirección del link" error={errors.slug?.message}><input {...form.register('slug')} placeholder="mi-comercio" /><p className="text-xs font-normal text-stone-500">Sin espacios ni acentos. Por ejemplo: mi-comercio.</p></Field>
          <Field label="WhatsApp" error={errors.whatsappPhone?.message}><input type="tel" {...form.register('whatsappPhone')} placeholder="+549..." /><p className="text-xs font-normal text-stone-500">Incluí el código de país y área.</p></Field>
          <Field label="Descripción" wide error={errors.description?.message}><textarea rows={2} {...form.register('description')} /></Field>
          <Field label="Dirección" error={errors.address?.message}><input {...form.register('address')} /></Field>
          <Field label="Ciudad" error={errors.city?.message}><input {...form.register('city')} /></Field>
        </div>
      </FormSection>
      <FormSection title="Primer administrador">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre completo" error={errors.adminName?.message}><input autoComplete="name" {...form.register('adminName')} /></Field>
          <Field label="Correo" error={errors.adminEmail?.message}><input type="email" autoComplete="email" {...form.register('adminEmail')} /></Field>
        </div>
        <p className="mt-3 text-xs text-stone-500">Recibirá por correo una invitación para crear su contraseña.</p>
      </FormSection>
      <details className="admin-disclosure" ref={optionalSection}>
        <summary>Opciones del comercio <span className="ml-2 font-normal text-stone-500">Opcional</span></summary>
        <div className="space-y-6 p-5 sm:p-6">
          <p className="text-sm text-stone-500">Envíos, importes, apariencia y región. Podés ajustarlos más adelante.</p>
          <section aria-labelledby="create-operation-title">
            <h2 className="mb-4 font-semibold" id="create-operation-title">Operación</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={`Pedido mínimo (${currency})`} error={errors.minimumOrder?.message}><input inputMode="decimal" {...form.register('minimumOrder')} /></Field>
              <Field label={`Envío inicial (${currency})`} error={errors.initialDeliveryFee?.message}><input inputMode="decimal" {...form.register('initialDeliveryFee')} /></Field>
              <Field label="Preparación (minutos)" error={errors.defaultPreparationMinutes?.message}><input type="number" min="5" max="240" {...form.register('defaultPreparationMinutes', { valueAsNumber: true })} /></Field>
            </div>
            <p className="mt-2 text-xs text-stone-500">Escribí el importe final. Por ejemplo: 1500,50. Dejá 0 si no corresponde.</p>
            <div className="mt-4 flex flex-wrap gap-5">
              <label className="check-field"><input type="checkbox" {...form.register('deliveryEnabled')} />Envío</label>
              <label className="check-field"><input type="checkbox" {...form.register('pickupEnabled')} />Retiro</label>
            </div>
          </section>
          <section aria-labelledby="create-brand-title">
            <h2 className="mb-4 font-semibold" id="create-brand-title">Apariencia</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Color principal" error={errors.primaryColor?.message}><input type="color" {...form.register('primaryColor')} /></Field>
              <Field label="Color secundario" error={errors.secondaryColor?.message}><input type="color" {...form.register('secondaryColor')} /></Field>
            </div>
          </section>
          <section aria-labelledby="create-region-title">
            <h2 className="mb-4 font-semibold" id="create-region-title">Región</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Moneda" error={errors.currencyCode?.message}><input maxLength={3} {...form.register('currencyCode')} /></Field>
              <Field label="Zona horaria" error={errors.timezone?.message}><input {...form.register('timezone')} /></Field>
            </div>
          </section>
        </div>
      </details>
      {error ? <p className="rounded-xl bg-red-50 p-4 text-sm text-red-800" role="alert">{error}</p> : null}
      <button aria-busy={form.formState.isSubmitting} className="button-primary" disabled={form.formState.isSubmitting} type="submit"><Building2 className="h-4 w-4" />{form.formState.isSubmitting ? 'Creando…' : 'Crear e invitar'}</button>
    </form>
  </>
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="form-card"><h2 className="form-card-title">{title}</h2><div className="mt-5">{children}</div></section>
}

function Field({ label, error, wide = false, children }: { label: string; error?: string | undefined; wide?: boolean; children: ReactNode }) {
  return <label className={`field ${wide ? 'sm:col-span-2' : ''}`}><span>{label}</span>{children}{error ? <small role="alert">{error}</small> : null}</label>
}
