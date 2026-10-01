export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_logs": {
                  Row: {
                    "action": Database["public"]['Enums']["audit_action"],"actor_user_id": string | null,"after_data": Json | null,"before_data": Json | null,"created_at": string,"entity_id": string | null,"entity_type": string,"id": string,"metadata": NonNullable<Json>,"restaurant_id": string | null
                  }
                  Insert: {
                    "action": Database["public"]['Enums']["audit_action"],"actor_user_id"?: string | null,"after_data"?: Json | null,"before_data"?: Json | null,"created_at"?: string,"entity_id"?: string | null,"entity_type": string,"id"?: string,"metadata"?: NonNullable<Json>,"restaurant_id"?: string | null
                  }
                  Update: {
                    "action"?: Database["public"]['Enums']["audit_action"],"actor_user_id"?: string | null,"after_data"?: Json | null,"before_data"?: Json | null,"created_at"?: string,"entity_id"?: string | null,"entity_type"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"restaurant_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_logs_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"business_hours": {
                  Row: {
                    "active": boolean,"closes_at": string,"created_at": string,"day_of_week": number,"id": string,"opens_at": string,"restaurant_id": string,"slot_index": number,"spans_next_day": boolean,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"closes_at": string,"created_at"?: string,"day_of_week": number,"id"?: string,"opens_at": string,"restaurant_id": string,"slot_index": number,"spans_next_day"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"closes_at"?: string,"created_at"?: string,"day_of_week"?: number,"id"?: string,"opens_at"?: string,"restaurant_id"?: string,"slot_index"?: number,"spans_next_day"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_hours_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"categories": {
                  Row: {
                    "active": boolean,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description": string,"id": string,"image_path": string | null,"name": string,"restaurant_id": string,"slug": string,"sort_order": number,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string,"id"?: string,"image_path"?: string | null,"name": string,"restaurant_id": string,"slug": string,"sort_order"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string,"id"?: string,"image_path"?: string | null,"name"?: string,"restaurant_id"?: string,"slug"?: string,"sort_order"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"delivery_zones": {
                  Row: {
                    "active": boolean,"created_at": string,"delivery_fee_cents": number,"description": string,"free_shipping_from_cents": number | null,"id": string,"minimum_order_cents": number,"name": string,"restaurant_id": string,"sort_order": number,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"delivery_fee_cents"?: number,"description"?: string,"free_shipping_from_cents"?: number | null,"id"?: string,"minimum_order_cents"?: number,"name": string,"restaurant_id": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"delivery_fee_cents"?: number,"description"?: string,"free_shipping_from_cents"?: number | null,"id"?: string,"minimum_order_cents"?: number,"name"?: string,"restaurant_id"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "delivery_zones_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"image_assets": {
                  Row: {
                    "bucket": string,"created_at": string,"created_by": string,"deleted_at": string | null,"entity_id": string | null,"entity_type": string,"height": number,"id": string,"mime_type": string,"path": string,"restaurant_id": string,"size_bytes": number,"width": number
                  }
                  Insert: {
                    "bucket"?: string,"created_at"?: string,"created_by": string,"deleted_at"?: string | null,"entity_id"?: string | null,"entity_type": string,"height": number,"id"?: string,"mime_type": string,"path": string,"restaurant_id": string,"size_bytes": number,"width": number
                  }
                  Update: {
                    "bucket"?: string,"created_at"?: string,"created_by"?: string,"deleted_at"?: string | null,"entity_id"?: string | null,"entity_type"?: string,"height"?: number,"id"?: string,"mime_type"?: string,"path"?: string,"restaurant_id"?: string,"size_bytes"?: number,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "image_assets_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"order_events": {
                  Row: {
                    "actor_type": Database["public"]['Enums']["order_actor_type"],"actor_user_id": string | null,"created_at": string,"event_type": string,"from_status": Database["public"]['Enums']["order_status"] | null,"id": string,"metadata": NonNullable<Json>,"order_id": string,"restaurant_id": string,"to_status": Database["public"]['Enums']["order_status"] | null
                  }
                  Insert: {
                    "actor_type": Database["public"]['Enums']["order_actor_type"],"actor_user_id"?: string | null,"created_at"?: string,"event_type": string,"from_status"?: Database["public"]['Enums']["order_status"] | null,"id"?: string,"metadata"?: NonNullable<Json>,"order_id": string,"restaurant_id": string,"to_status"?: Database["public"]['Enums']["order_status"] | null
                  }
                  Update: {
                    "actor_type"?: Database["public"]['Enums']["order_actor_type"],"actor_user_id"?: string | null,"created_at"?: string,"event_type"?: string,"from_status"?: Database["public"]['Enums']["order_status"] | null,"id"?: string,"metadata"?: NonNullable<Json>,"order_id"?: string,"restaurant_id"?: string,"to_status"?: Database["public"]['Enums']["order_status"] | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_events_order_id_restaurant_id_fkey"
      columns: ["order_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "order_events_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"order_item_options": {
                  Row: {
                    "created_at": string,"group_name_snapshot": string,"id": string,"option_name_snapshot": string,"order_item_id": string,"price_delta_cents": number,"product_option_id": string | null,"restaurant_id": string
                  }
                  Insert: {
                    "created_at"?: string,"group_name_snapshot": string,"id"?: string,"option_name_snapshot": string,"order_item_id": string,"price_delta_cents": number,"product_option_id"?: string | null,"restaurant_id": string
                  }
                  Update: {
                    "created_at"?: string,"group_name_snapshot"?: string,"id"?: string,"option_name_snapshot"?: string,"order_item_id"?: string,"price_delta_cents"?: number,"product_option_id"?: string | null,"restaurant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_item_options_order_item_id_restaurant_id_fkey"
      columns: ["order_item_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "order_items"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "order_item_options_product_option_id_restaurant_id_fkey"
      columns: ["product_option_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "product_options"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "order_item_options_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"order_items": {
                  Row: {
                    "base_subtotal_cents": number,"created_at": string,"id": string,"line_total_cents": number,"notes": string | null,"options_total_unit_cents": number,"order_id": string,"pricing_breakdown_snapshot": Json,"pricing_mode_snapshot": string,"product_code_snapshot": string,"product_id": string | null,"product_name_snapshot": string,"quantity": number,"restaurant_id": string,"unit_price_cents": number
                  }
                  Insert: {
                    "base_subtotal_cents": number,"created_at"?: string,"id"?: string,"line_total_cents": number,"notes"?: string | null,"options_total_unit_cents"?: number,"order_id": string,"pricing_breakdown_snapshot": Json,"pricing_mode_snapshot": string,"product_code_snapshot": string,"product_id"?: string | null,"product_name_snapshot": string,"quantity": number,"restaurant_id": string,"unit_price_cents": number
                  }
                  Update: {
                    "base_subtotal_cents"?: number,"created_at"?: string,"id"?: string,"line_total_cents"?: number,"notes"?: string | null,"options_total_unit_cents"?: number,"order_id"?: string,"pricing_breakdown_snapshot"?: Json,"pricing_mode_snapshot"?: string,"product_code_snapshot"?: string,"product_id"?: string | null,"product_name_snapshot"?: string,"quantity"?: number,"restaurant_id"?: string,"unit_price_cents"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_items_order_id_restaurant_id_fkey"
      columns: ["order_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "order_items_product_id_restaurant_id_fkey"
      columns: ["product_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "order_items_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"orders": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"action_id": string,"cancel_reason": string | null,"cancelled_at": string | null,"cancelled_by": string | null,"completed_at": string | null,"completed_by": string | null,"created_at": string,"currency_code": string,"customer_name": string,"customer_notes": string | null,"customer_phone": string,"delivery_address": string | null,"delivery_apartment": string | null,"delivery_city": string | null,"delivery_fee_cents": number,"delivery_floor": string | null,"delivery_neighborhood": string | null,"delivery_reference": string | null,"delivery_zone_id": string | null,"discount_cents": number,"display_number": string,"expires_at": string | null,"fulfillment_type": Database["public"]['Enums']["fulfillment_type"],"id": string,"idempotency_key": string,"payment_account_holder_snapshot": string | null,"payment_adjustment_bps_snapshot": number,"payment_adjustment_fixed_cents_snapshot": number,"payment_adjustment_scope_snapshot": Database["public"]['Enums']["payment_adjustment_scope"],"payment_adjustment_type_snapshot": Database["public"]['Enums']["payment_adjustment_type"],"payment_bank_name_snapshot": string | null,"payment_instructions_snapshot": string | null,"payment_method_id": string,"payment_method_name_snapshot": string,"payment_transfer_alias_snapshot": string | null,"restaurant_id": string,"status": Database["public"]['Enums']["order_status"],"subtotal_cents": number,"surcharge_cents": number,"total_cents": number,"updated_at": string,"whatsapp_opened_at": string | null
                  }
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"action_id"?: string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"currency_code": string,"customer_name": string,"customer_notes"?: string | null,"customer_phone": string,"delivery_address"?: string | null,"delivery_apartment"?: string | null,"delivery_city"?: string | null,"delivery_fee_cents"?: number,"delivery_floor"?: string | null,"delivery_neighborhood"?: string | null,"delivery_reference"?: string | null,"delivery_zone_id"?: string | null,"discount_cents"?: number,"display_number": string,"expires_at"?: string | null,"fulfillment_type": Database["public"]['Enums']["fulfillment_type"],"id"?: string,"idempotency_key": string,"payment_account_holder_snapshot"?: string | null,"payment_adjustment_bps_snapshot": number,"payment_adjustment_fixed_cents_snapshot": number,"payment_adjustment_scope_snapshot": Database["public"]['Enums']["payment_adjustment_scope"],"payment_adjustment_type_snapshot": Database["public"]['Enums']["payment_adjustment_type"],"payment_bank_name_snapshot"?: string | null,"payment_instructions_snapshot"?: string | null,"payment_method_id": string,"payment_method_name_snapshot": string,"payment_transfer_alias_snapshot"?: string | null,"restaurant_id": string,"status"?: Database["public"]['Enums']["order_status"],"subtotal_cents": number,"surcharge_cents"?: number,"total_cents": number,"updated_at"?: string,"whatsapp_opened_at"?: string | null
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"action_id"?: string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"currency_code"?: string,"customer_name"?: string,"customer_notes"?: string | null,"customer_phone"?: string,"delivery_address"?: string | null,"delivery_apartment"?: string | null,"delivery_city"?: string | null,"delivery_fee_cents"?: number,"delivery_floor"?: string | null,"delivery_neighborhood"?: string | null,"delivery_reference"?: string | null,"delivery_zone_id"?: string | null,"discount_cents"?: number,"display_number"?: string,"expires_at"?: string | null,"fulfillment_type"?: Database["public"]['Enums']["fulfillment_type"],"id"?: string,"idempotency_key"?: string,"payment_account_holder_snapshot"?: string | null,"payment_adjustment_bps_snapshot"?: number,"payment_adjustment_fixed_cents_snapshot"?: number,"payment_adjustment_scope_snapshot"?: Database["public"]['Enums']["payment_adjustment_scope"],"payment_adjustment_type_snapshot"?: Database["public"]['Enums']["payment_adjustment_type"],"payment_bank_name_snapshot"?: string | null,"payment_instructions_snapshot"?: string | null,"payment_method_id"?: string,"payment_method_name_snapshot"?: string,"payment_transfer_alias_snapshot"?: string | null,"restaurant_id"?: string,"status"?: Database["public"]['Enums']["order_status"],"subtotal_cents"?: number,"surcharge_cents"?: number,"total_cents"?: number,"updated_at"?: string,"whatsapp_opened_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "orders_delivery_zone_id_restaurant_id_fkey"
      columns: ["delivery_zone_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "delivery_zones"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "orders_payment_method_id_restaurant_id_fkey"
      columns: ["payment_method_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "payment_methods"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "orders_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_methods": {
                  Row: {
                    "account_holder": string | null,"active": boolean,"adjustment_bps": number,"adjustment_fixed_cents": number,"adjustment_scope": Database["public"]['Enums']["payment_adjustment_scope"],"adjustment_type": Database["public"]['Enums']["payment_adjustment_type"],"bank_name": string | null,"code": string,"created_at": string,"description": string,"id": string,"instructions": string | null,"name": string,"restaurant_id": string,"sort_order": number,"transfer_alias": string | null,"updated_at": string
                  }
                  Insert: {
                    "account_holder"?: string | null,"active"?: boolean,"adjustment_bps"?: number,"adjustment_fixed_cents"?: number,"adjustment_scope"?: Database["public"]['Enums']["payment_adjustment_scope"],"adjustment_type"?: Database["public"]['Enums']["payment_adjustment_type"],"bank_name"?: string | null,"code": string,"created_at"?: string,"description"?: string,"id"?: string,"instructions"?: string | null,"name": string,"restaurant_id": string,"sort_order"?: number,"transfer_alias"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "account_holder"?: string | null,"active"?: boolean,"adjustment_bps"?: number,"adjustment_fixed_cents"?: number,"adjustment_scope"?: Database["public"]['Enums']["payment_adjustment_scope"],"adjustment_type"?: Database["public"]['Enums']["payment_adjustment_type"],"bank_name"?: string | null,"code"?: string,"created_at"?: string,"description"?: string,"id"?: string,"instructions"?: string | null,"name"?: string,"restaurant_id"?: string,"sort_order"?: number,"transfer_alias"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_methods_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_user_roles": {
                  Row: {
                    "created_at": string,"created_by": string | null,"role": Database["public"]['Enums']["platform_role"],"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"role": Database["public"]['Enums']["platform_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"role"?: Database["public"]['Enums']["platform_role"],"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"product_option_groups": {
                  Row: {
                    "active": boolean,"code": string | null,"created_at": string,"id": string,"max_select": number,"min_select": number,"name": string,"product_id": string,"required": boolean,"restaurant_id": string,"sort_order": number,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"code"?: string | null,"created_at"?: string,"id"?: string,"max_select"?: number,"min_select"?: number,"name": string,"product_id": string,"required"?: boolean,"restaurant_id": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"code"?: string | null,"created_at"?: string,"id"?: string,"max_select"?: number,"min_select"?: number,"name"?: string,"product_id"?: string,"required"?: boolean,"restaurant_id"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_option_groups_product_id_restaurant_id_fkey"
      columns: ["product_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "product_option_groups_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"product_options": {
                  Row: {
                    "active": boolean,"code": string | null,"created_at": string,"id": string,"name": string,"option_group_id": string,"price_delta_cents": number,"restaurant_id": string,"sort_order": number,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"code"?: string | null,"created_at"?: string,"id"?: string,"name": string,"option_group_id": string,"price_delta_cents"?: number,"restaurant_id": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"code"?: string | null,"created_at"?: string,"id"?: string,"name"?: string,"option_group_id"?: string,"price_delta_cents"?: number,"restaurant_id"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_options_option_group_id_restaurant_id_fkey"
      columns: ["option_group_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "product_option_groups"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "product_options_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"product_quantity_prices": {
                  Row: {
                    "active": boolean,"created_at": string,"id": string,"product_id": string,"quantity": number,"restaurant_id": string,"total_price_cents": number,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"product_id": string,"quantity": number,"restaurant_id": string,"total_price_cents": number,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"product_id"?: string,"quantity"?: number,"restaurant_id"?: string,"total_price_cents"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_quantity_prices_product_id_restaurant_id_fkey"
      columns: ["product_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "product_quantity_prices_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"products": {
                  Row: {
                    "active": boolean,"available": boolean,"base_price_cents": number,"category_id": string,"code": string,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description": string,"featured": boolean,"id": string,"image_path": string | null,"name": string,"promotion_ends_at": string | null,"promotion_starts_at": string | null,"promotional_price_cents": number | null,"restaurant_id": string,"sort_order": number,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "active"?: boolean,"available"?: boolean,"base_price_cents": number,"category_id": string,"code": string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string,"featured"?: boolean,"id"?: string,"image_path"?: string | null,"name": string,"promotion_ends_at"?: string | null,"promotion_starts_at"?: string | null,"promotional_price_cents"?: number | null,"restaurant_id": string,"sort_order"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"available"?: boolean,"base_price_cents"?: number,"category_id"?: string,"code"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description"?: string,"featured"?: boolean,"id"?: string,"image_path"?: string | null,"name"?: string,"promotion_ends_at"?: string | null,"promotion_starts_at"?: string | null,"promotional_price_cents"?: number | null,"restaurant_id"?: string,"sort_order"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "products_category_id_restaurant_id_fkey"
      columns: ["category_id","restaurant_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id","restaurant_id"]
    },{
      foreignKeyName: "products_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "active": boolean,"created_at": string,"email": string,"full_name": string,"id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"email": string,"full_name"?: string,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"email"?: string,"full_name"?: string,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"restaurant_members": {
                  Row: {
                    "created_at": string,"id": string,"invited_by": string | null,"restaurant_id": string,"role": Database["public"]['Enums']["restaurant_role"],"status": Database["public"]['Enums']["membership_status"],"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"invited_by"?: string | null,"restaurant_id": string,"role": Database["public"]['Enums']["restaurant_role"],"status"?: Database["public"]['Enums']["membership_status"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"invited_by"?: string | null,"restaurant_id"?: string,"role"?: Database["public"]['Enums']["restaurant_role"],"status"?: Database["public"]['Enums']["membership_status"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "restaurant_members_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"restaurant_order_counters": {
                  Row: {
                    "next_value": number,"restaurant_id": string,"updated_at": string
                  }
                  Insert: {
                    "next_value"?: number,"restaurant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "next_value"?: number,"restaurant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "restaurant_order_counters_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: true
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                },"restaurants": {
                  Row: {
                    "address": string,"city": string,"cover_path": string | null,"created_at": string,"created_by": string | null,"currency_code": string,"default_preparation_minutes": number,"delivery_enabled": boolean,"description": string,"id": string,"locale": string,"logo_path": string | null,"minimum_order_cents": number,"name": string,"order_prefix": string,"pickup_enabled": boolean,"primary_color": string,"public_menu_enabled": boolean,"secondary_color": string,"slug": string,"status": Database["public"]['Enums']["restaurant_status"],"timezone": string,"trade_name": string,"updated_at": string,"whatsapp_phone_e164": string
                  }
                  Insert: {
                    "address"?: string,"city"?: string,"cover_path"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"default_preparation_minutes"?: number,"delivery_enabled"?: boolean,"description"?: string,"id"?: string,"locale"?: string,"logo_path"?: string | null,"minimum_order_cents"?: number,"name": string,"order_prefix": string,"pickup_enabled"?: boolean,"primary_color"?: string,"public_menu_enabled"?: boolean,"secondary_color"?: string,"slug": string,"status"?: Database["public"]['Enums']["restaurant_status"],"timezone"?: string,"trade_name": string,"updated_at"?: string,"whatsapp_phone_e164": string
                  }
                  Update: {
                    "address"?: string,"city"?: string,"cover_path"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"default_preparation_minutes"?: number,"delivery_enabled"?: boolean,"description"?: string,"id"?: string,"locale"?: string,"logo_path"?: string | null,"minimum_order_cents"?: number,"name"?: string,"order_prefix"?: string,"pickup_enabled"?: boolean,"primary_color"?: string,"public_menu_enabled"?: boolean,"secondary_color"?: string,"slug"?: string,"status"?: Database["public"]['Enums']["restaurant_status"],"timezone"?: string,"trade_name"?: string,"updated_at"?: string,"whatsapp_phone_e164"?: string
                  }
                  Relationships: [
                    
                  ]
                },"special_hours": {
                  Row: {
                    "closes_at": string | null,"created_at": string,"date": string,"id": string,"is_closed": boolean,"opens_at": string | null,"reason": string | null,"restaurant_id": string,"slot_index": number,"spans_next_day": boolean,"updated_at": string
                  }
                  Insert: {
                    "closes_at"?: string | null,"created_at"?: string,"date": string,"id"?: string,"is_closed"?: boolean,"opens_at"?: string | null,"reason"?: string | null,"restaurant_id": string,"slot_index"?: number,"spans_next_day"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "closes_at"?: string | null,"created_at"?: string,"date"?: string,"id"?: string,"is_closed"?: boolean,"opens_at"?: string | null,"reason"?: string | null,"restaurant_id"?: string,"slot_index"?: number,"spans_next_day"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "special_hours_restaurant_id_fkey"
      columns: ["restaurant_id"]
isOneToOne: false
      referencedRelation: "restaurants"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "cancel_order":
{ Args: { "p_order_id": string,"p_reason": string }; Returns: Json
                           },
"check_order_rate_limits":
{ Args: { "p_ip_hash": string,"p_phone_hash": string,"p_restaurant_slug": string }; Returns: Json
                           },
"check_rate_limit":
{ Args: { "p_key_hash": string,"p_limit": number,"p_restaurant_id": string,"p_window_seconds": number }; Returns: boolean
                           },
"claim_order":
{ Args: { "p_action_id": string }; Returns: Json
                           },
"cleanup_rate_limits":
{ Args: { "p_before"?: string }; Returns: number
                           },
"complete_order":
{ Args: { "p_order_id": string }; Returns: Json
                           },
"create_order_transaction":
{ Args: { "p_client_event_token_hash": string,"p_ip_hash": string,"p_phone_hash": string,"p_request": Json }; Returns: Json
                           },
"create_restaurant_transaction":
{ Args: { "p_actor_id": string,"p_admin_email": string,"p_admin_user_id": string,"p_idempotency_key": string,"p_payload": Json }; Returns: Json
                           },
"expire_orders":
{ Args: { "p_before"?: string,"p_limit"?: number }; Returns: number
                           },
"get_actor_authorization":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_order_by_action":
{ Args: { "p_action_id": string }; Returns: Json
                           },
"get_order_metrics":
{ Args: { "p_from": string,"p_restaurant_id": string,"p_to": string }; Returns: Json
                           },
"get_public_menu":
{ Args: { "p_restaurant_slug": string }; Returns: Json
                           },
"import_products_batch":
{ Args: { "p_mode"?: string,"p_restaurant_id": string,"p_rows": Json }; Returns: Json
                           },
"list_orphan_image_assets":
{ Args: { "p_restaurant_id": string }; Returns: {
              "asset_id": string,"issue": string,"path": string,"restaurant_id": string
            }[]
                           },
"register_whatsapp_opened":
{ Args: { "p_action_id": string,"p_token_hash": string }; Returns: Json
                           },
"save_product_catalog":
{ Args: { "p_groups": Json,"p_product": Json,"p_removed_group_ids"?: (string)[],"p_removed_option_ids"?: (string)[],"p_restaurant_id": string }; Returns: Json
                           },
"save_restaurant_hours":
{ Args: { "p_delete_regular_ids"?: (string)[],"p_delete_special_ids"?: (string)[],"p_regular": Json,"p_restaurant_id": string,"p_special": Json }; Returns: Json
                           },
"set_restaurant_member_status":
{ Args: { "p_membership_id": string,"p_status": Database["public"]['Enums']["membership_status"] }; Returns: Json
                           },
"upsert_restaurant_membership":
{ Args: { "p_actor_id": string,"p_restaurant_id": string,"p_role": Database["public"]['Enums']["restaurant_role"],"p_status": Database["public"]['Enums']["membership_status"],"p_user_id": string }; Returns: Json
                           }
          }
          Enums: {
            "audit_action": "create"|"update"|"delete"|"invite"|"activate"|"suspend"|"claim_order"|"complete_order"|"cancel_order"|"import","fulfillment_type": "delivery"|"pickup","membership_status": "invited"|"active"|"suspended","order_actor_type": "customer"|"authenticated_user"|"system","order_status": "generated"|"whatsapp_opened"|"accepted"|"completed"|"cancelled"|"expired","payment_adjustment_scope": "subtotal"|"shipping"|"total","payment_adjustment_type": "none"|"discount"|"surcharge","platform_role": "super_admin","restaurant_role": "restaurant_admin"|"order_manager","restaurant_status": "draft"|"active"|"suspended"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "audit_action": ["create", "update", "delete", "invite", "activate", "suspend", "claim_order", "complete_order", "cancel_order", "import"],"fulfillment_type": ["delivery", "pickup"],"membership_status": ["invited", "active", "suspended"],"order_actor_type": ["customer", "authenticated_user", "system"],"order_status": ["generated", "whatsapp_opened", "accepted", "completed", "cancelled", "expired"],"payment_adjustment_scope": ["subtotal", "shipping", "total"],"payment_adjustment_type": ["none", "discount", "surcharge"],"platform_role": ["super_admin"],"restaurant_role": ["restaurant_admin", "order_manager"],"restaurant_status": ["draft", "active", "suspended"]
          }
        }
} as const

