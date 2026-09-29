# Matriz RLS, RPC y Storage

## Lectura de la matriz

- **Propio**: la fila debe pertenecer a un restaurante con membresía activa.
- **AAL2**: el JWT verificado contiene `aal = aal2`.
- **Edge**: el navegador no recibe grant a la RPC interna; una Edge Function valida primero y usa la capacidad server-side.
- Un casillero vacío significa que grants y/o RLS niegan la operación.

RLS es la autoridad final para acceso directo. Los route guards solo mejoran la navegación.

## Tablas base

| Recurso | Anónimo | Auth sin membresía | Restaurant Admin propio | Order Manager propio | Super Admin `aal1` | Super Admin `aal2` |
|---|---|---|---|---|---|---|
| `profiles` | — | Leer propio; editar `full_name` si el perfil está activo | Leer perfiles del tenant si su propio perfil y membresía admin están activos; editar nombre propio si está activo | Leer propio; editar nombre propio si está activo | Leer todos si el perfil/rol global está activo; editar nombre propio | Igual |
| `platform_user_roles` | — | Leer roles propios | Leer roles propios | Leer roles propios | Leer todos | Leer todos |
| `restaurants` | — | — | Leer/actualizar propio salvo campos protegidos | Leer propio | Leer todos; sin update administrativo | Leer/actualizar todos |
| `restaurant_members` | — | Filas propias | Leer miembros propios | Leer fila propia | Leer todos | Leer todos |
| Catálogo | — | — | Leer/insertar/actualizar propio | Solo leer propio | Solo leer todos | Leer/insertar/actualizar todos |
| Horarios, pagos y zonas | — | — | Leer/insertar/actualizar propio; borrar turnos/excepciones | Solo leer propio | Solo leer todos | Leer/insertar/actualizar todos; borrar turnos/excepciones |
| `image_assets` metadata | — | — | Leer/insertar propio; update limitado a `deleted_at` | Solo leer propio | Solo leer todos | Leer/insertar y marcar baja en todos |
| `orders` | — | — | Leer propios | Leer propios | — | Leer todos |
| `order_items` / `order_item_options` | — | — | Leer propios | Leer propios | — | Leer todos |
| `order_events` | — | — | Leer propios | Leer propios | — | Leer todos |
| `audit_logs` | — | — | Leer propios | — | Leer todos | Leer todos |
| `restaurant_order_counters` | — | — | — | — | — | — |

No existen grants de cliente para insertar/actualizar pedidos, ítems, timeline o auditoría. Los triggers también bloquean cambios fuera de operaciones controladas. No hay grants `DELETE` sobre recursos históricos ni tablas de baja lógica.

## Políticas de identidad y tenant

| Política | Operación | Condición |
|---|---|---|
| `profiles_select_authorized` | SELECT | perfil propio, Super Admin o perfil que comparte tenant con un Restaurant Admin cuya membresía y perfil están activos |
| `profiles_update_self` | UPDATE | usuario activo sobre su propia fila; el grant limita a `full_name` |
| `platform_roles_select_authorized` | SELECT | roles propios o Super Admin |
| `restaurants_select_member` | SELECT | `private.can_view_restaurant(id)` |
| `restaurants_update_admin` | UPDATE | Restaurant Admin activo propio o Super Admin AAL2 |
| `restaurant_members_select_authorized` | SELECT | miembro mismo, Restaurant Admin del tenant o Super Admin |

`private.can_view_restaurant` permite Super Admin activo en cualquier AAL y miembros activos de ambos roles. `private.can_manage_restaurant` permite Restaurant Admin propio o Super Admin AAL2. Esa autorización de fila no habilita todos los campos: el grant por columna y `private.guard_restaurant_protected_fields` reservan `status`, `slug` y `order_prefix` para Super Admin AAL2 o mantenimiento `service_role`; `id`, `created_by` y `created_at` son inmutables, y `updated_at` es administrado.

## Catálogo y configuración

Las migraciones generan policies equivalentes por tabla:

| Familia | Tablas | SELECT | INSERT/UPDATE |
|---|---|---|---|
| Catálogo | `categories`, `products`, `product_option_groups`, `product_options` | `*_select_member`: miembro activo o Super Admin | `*_insert_admin`, `*_update_admin`: `private.can_manage_catalog` |
| Configuración | `business_hours`, `special_hours`, `payment_methods`, `delivery_zones` | `*_select_member`: miembro activo o Super Admin | `*_insert_admin`, `*_update_admin`: `private.can_manage_restaurant` |

`order_manager` obtiene lectura para operar pedidos, pero no escritura. `DELETE` se concede únicamente a `business_hours` y `special_hours`, sujeto a `private.can_manage_restaurant`; catálogo, pagos y zonas no reciben borrado directo. El cliente público no usa estas tablas: consume una proyección RPC.

## Pedidos y auditoría

| Política | Recurso | Condición |
|---|---|---|
| `orders_select_operator` | `orders` | Restaurant Admin u Order Manager activo propio, o Super Admin AAL2 |
| `order_items_select_operator` | `order_items` | Misma frontera del pedido |
| `order_item_options_select_operator` | `order_item_options` | Misma frontera del pedido |
| `order_events_select_operator` | `order_events` | Misma frontera del pedido |
| `audit_logs_select_restaurant_admin` | `audit_logs` | Restaurant Admin propio o Super Admin |

Las transiciones usan `claim_order`, `complete_order` y `cancel_order`; reciben el ID del pedido/acción, obtienen `auth.uid()` y vuelven a verificar tenant/rol. `claim_order` condiciona el `UPDATE` a estados tomables para resolver concurrencia.

## RPC y superficie expuesta

| RPC | `anon` | `authenticated` | Server/Edge | Seguridad adicional |
|---|---|---|---|---|
| `get_public_menu(text)` | Ejecutar | Ejecutar | — | Solo restaurante activo/publicado y proyección sin PII |
| `get_actor_authorization()` | — | Ejecutar | — | Devuelve la autorización del usuario actual |
| `get_order_by_action(uuid)` | — | Ejecutar | — | Verifica `can_manage_orders` del tenant |
| `claim_order(uuid)` | — | Ejecutar | — | Actor real, membresía y update atómico |
| `complete_order(uuid)` | — | Ejecutar | — | Solo desde `accepted` y tenant autorizado |
| `cancel_order(uuid,text)` | — | Ejecutar | — | Tenant autorizado y motivo de 3–500 caracteres |
| `set_restaurant_member_status(uuid,membership_status)` | — | Ejecutar | — | Admin propio solo gestiona order managers; Super Admin exige AAL2; protege al último admin activo |
| `get_order_metrics(uuid,timestamptz,timestamptz)` | — | Ejecutar | — | `can_manage_orders`; rango válido de hasta 366 días |
| `import_products_batch(uuid,jsonb,text)` | — | Ejecutar | — | `can_manage_catalog`, límites y transacción; `skip` omite el grafo completo del producto existente |
| `save_restaurant_hours(uuid,jsonb,jsonb,uuid[],uuid[])` | — | Ejecutar | — | `can_manage_restaurant`; reemplazo atómico, swaps sin colisión, cierres exclusivos e IDs confinados al tenant |
| `save_product_catalog(uuid,jsonb,jsonb,uuid[],uuid[])` | — | Ejecutar | — | `can_manage_catalog`; producto, grupos, opciones y bajas lógicas atómicos |
| `list_orphan_image_assets(uuid)` | — | Ejecutar | — | `can_manage_catalog`; inventario read-only del tenant, sin borrado automático |
| `create_restaurant_transaction(...)` | — | — | `service_role` | Edge verifica JWT, Super Admin AAL2 e idempotencia antes de invocar |
| `upsert_restaurant_membership(...)` | — | — | `service_role` | Edge autoriza; la RPC vuelve a verificar actor/rol |
| `create_order_transaction(...)` | — | — | `service_role` | Edge valida origen/anti-spam; DB recalcula todo |
| `register_whatsapp_opened(uuid,text)` | — | — | `service_role` | Hash efímero, alcance único e idempotencia |
| `check_order_rate_limits(text,text,text)` / `cleanup_rate_limits(...)` | — | — | `service_role` | Límites persistentes por IP, teléfono y restaurante; solo hashes |
| `check_rate_limit(...)` | — | — | — | Helper owner-only invocado por `check_order_rate_limits`; no tiene superficie API directa |
| `expire_orders(...)` | — | — | `service_role` | Edge interna con secreto de mantenimiento |

Todas las funciones `SECURITY DEFINER` fijan `search_path`, usan nombres calificados y revocan ejecución de `PUBLIC` y de los roles API antes del grant explícito. Los privilegios por defecto globales también son deny-by-default para funciones nuevas. Las RPC server-only no son seguras por ocultar su nombre: lo son porque solo `service_role` puede ejecutarlas y la Edge Function controla esa capacidad.

## Storage

Bucket: `restaurant-assets`, público solo para contenido que debe mostrarse en el menú.

| Política | Operación | Regla |
|---|---|---|
| `restaurant_assets_public_read` | SELECT | `bucket_id = restaurant-assets` |
| `restaurant_assets_admin_insert` | INSERT | autenticado, tenant derivado del path, `can_manage_catalog`, carpeta permitida, extensión y MIME admitidos |
| `restaurant_assets_admin_update` | UPDATE | mismo tenant y controles de path/tipo en `USING`/`WITH CHECK` |
| `restaurant_assets_admin_delete` | DELETE | mismo tenant y `can_manage_catalog` |

Formato de ruta:

```text
restaurants/{restaurant_id}/logo/{uuid}.webp
restaurants/{restaurant_id}/cover/{uuid}.webp
restaurants/{restaurant_id}/categories/{category_id}/{uuid}.webp
restaurants/{restaurant_id}/products/{product_id}/{uuid}.webp
restaurants/{restaurant_id}/promotions/{uuid}.webp
```

La función `private.storage_restaurant_id(name)` valida UUID, prefijo y ausencia de `..`. La allowlist acepta `jpg`, `jpeg`, `png`, `webp` y los MIME correspondientes. SVG falla tanto por extensión como por MIME. `order_manager` no satisface `can_manage_catalog`.

## Esquema privado

`private.order_client_event_tokens`, `private.rate_limits` y `private.operation_idempotency` no tienen grants para `anon` ni `authenticated`, y `private` no forma parte de `api.schemas`. Los helpers privados también revocan ejecución de esos roles.

## Realtime

Realtime se habilita solo sobre las tablas administrativas necesarias. La suscripción del cliente filtra `restaurant_id`, pero ese filtro no es el control de seguridad: la lectura RLS determina qué cambios puede recibir la sesión. Un Super Admin debe elevar a AAL2 para acceder al stream de pedidos.

## Casos de prueba imprescindibles

1. `anon` no puede `SELECT` ni `INSERT` en `orders`, pero sí ejecutar `get_public_menu`.
2. Admin A no puede leer/actualizar B ni forzando `restaurant_id`.
3. Order Manager puede leer/tomar pedidos propios y no puede cambiar catálogo/configuración.
4. Super Admin `aal1` no puede administrar ni leer pedidos; `aal2` sí.
5. Admin A no puede escribir en la carpeta Storage de B y SVG es rechazado.
6. `get_public_menu` no devuelve perfiles, membresías, pedidos ni auditoría.
7. Dos claims simultáneos producen un único `accepted_by`.
8. La RPC de importación no actualiza códigos de otro tenant.
9. Un usuario autenticado sin membresía solo accede a su perfil/roles permitidos.
10. Ningún rol de aplicación borra pedidos, eventos o auditoría.
11. Un Restaurant Admin no puede cambiar `status`, `slug`, `order_prefix` ni campos de procedencia de `restaurants`; un Super Admin AAL2 solo puede cambiar los tres primeros.
12. Desactivar el perfil de un Restaurant Admin le quita lectura sobre perfiles de compañeros aunque su membresía siga activa; conserva lectura de su propio perfil.
13. Un error en una excepción horaria revierte también eliminaciones/horarios regulares anteriores del mismo guardado.
14. Un error en una opción revierte el producto y todos los grupos/opciones del mismo guardado.
15. `skip_existing` no crea categoría, grupo, opción ni imagen para el código omitido, pero sí persiste el grafo de los códigos nuevos.
16. El inventario de assets excluye referencias válidas, clasifica las cuatro inconsistencias previstas y no expone paths de otro tenant.
