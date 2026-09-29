export type MembershipRole = 'restaurant_admin' | 'order_manager'
export type MembershipStatus = 'invited' | 'active' | 'suspended'
export type OrderStatus =
  | 'generated'
  | 'whatsapp_opened'
  | 'accepted'
  | 'completed'
  | 'cancelled'
  | 'expired'

export interface Profile {
  id: string
  fullName: string
  email: string
  active: boolean
}

export interface Membership {
  id: string
  restaurantId: string
  restaurantName: string
  restaurantSlug: string
  restaurantStatus: 'draft' | 'active' | 'suspended'
  role: MembershipRole
  status: MembershipStatus
}

export interface PublicOption {
  id: string
  name: string
  priceDeltaCents: number
  sortOrder: number
}

export interface PublicOptionGroup {
  id: string
  name: string
  required: boolean
  minSelect: number
  maxSelect: number
  sortOrder: number
  options: PublicOption[]
}

export interface PublicProduct {
  id: string
  categoryId: string
  code: string
  name: string
  description: string
  basePriceCents: number
  promotionalPriceCents: number | null
  promotionStartsAt: string | null
  promotionEndsAt: string | null
  imagePath: string | null
  available: boolean
  featured: boolean
  sortOrder: number
  optionGroups: PublicOptionGroup[]
}

export interface PublicCategory {
  id: string
  name: string
  slug: string
  description: string
  imagePath: string | null
  sortOrder: number
  products: PublicProduct[]
}

export interface BusinessHour {
  id: string
  dayOfWeek: number
  slotIndex: number
  opensAt: string
  closesAt: string
  spansNextDay: boolean
}

export interface SpecialHour {
  id: string
  date: string
  isClosed: boolean
  slotIndex: number
  opensAt: string | null
  closesAt: string | null
  spansNextDay: boolean
  reason: string | null
}

export interface PublicPaymentMethod {
  id: string
  code: string
  name: string
  description: string
  adjustmentType: 'none' | 'discount' | 'surcharge'
  adjustmentScope: 'subtotal' | 'shipping' | 'total'
  adjustmentBps: number
  adjustmentFixedCents: number
  transferAlias: string | null
  accountHolder: string | null
  bankName: string | null
  instructions: string | null
  sortOrder: number
}

export interface PublicDeliveryZone {
  id: string
  name: string
  description: string
  deliveryFeeCents: number
  minimumOrderCents: number
  freeShippingFromCents: number | null
  sortOrder: number
}

export interface PublicRestaurant {
  id: string
  name: string
  tradeName: string
  slug: string
  description: string
  whatsappPhone: string
  address: string
  city: string
  timezone: string
  currencyCode: string
  locale: string
  logoPath: string | null
  coverPath: string | null
  primaryColor: string
  secondaryColor: string
  deliveryEnabled: boolean
  pickupEnabled: boolean
  minimumOrderCents: number
  defaultPreparationMinutes: number
  isOpen: boolean
  nextOpeningAt: string | null
}

export interface PublicMenu {
  restaurant: PublicRestaurant
  categories: PublicCategory[]
  businessHours: BusinessHour[]
  specialHours: SpecialHour[]
  paymentMethods: PublicPaymentMethod[]
  deliveryZones: PublicDeliveryZone[]
}

export interface CartLine {
  key: string
  productId: string
  productName: string
  productImagePath: string | null
  quantity: number
  notes: string
  unitPriceCents: number
  selectedOptions: Array<{
    id: string
    groupName: string
    name: string
    priceDeltaCents: number
  }>
}

export interface GeneratedOrder {
  order: {
    actionId: string
    displayNumber: string
    status: OrderStatus
    totalCents: number
    currencyCode: string
    createdAt: string
  }
  whatsapp: {
    phone: string
    message: string
    url: string
  }
  clientEventToken: string | null
  clientEventExpiresAt?: string | undefined
  idempotentReplay: boolean
}

export interface AdminOrder {
  id: string
  restaurant_id: string
  action_id: string
  display_number: string
  status: OrderStatus
  customer_name: string
  customer_phone: string
  fulfillment_type: 'delivery' | 'pickup'
  delivery_address: string | null
  delivery_city: string | null
  delivery_neighborhood: string | null
  customer_notes: string | null
  payment_method_name_snapshot: string
  subtotal_cents: number | string
  discount_cents: number | string
  surcharge_cents: number | string
  delivery_fee_cents: number | string
  total_cents: number | string
  currency_code: string
  whatsapp_opened_at: string | null
  accepted_by: string | null
  accepted_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

export interface OrderItemSnapshot {
  id: string
  order_id: string
  product_name_snapshot: string
  product_code_snapshot: string
  quantity: number
  unit_price_cents: number | string
  options_total_unit_cents: number | string
  line_total_cents: number | string
  notes: string | null
}

export interface OrderEvent {
  id: string
  order_id: string
  event_type: string
  from_status: OrderStatus | null
  to_status: OrderStatus | null
  actor_type: 'customer' | 'authenticated_user' | 'system'
  actor_user_id: string | null
  created_at: string
}
