# Mozzi Menu

Menú digital multi-restaurante con paneles administrativos, checkout por WhatsApp e historial de pedidos en Supabase. La aplicación es una SPA estática; Supabase concentra Auth, PostgreSQL, RLS, Storage, Edge Functions, RPC y Realtime.

El diseño parte de tres reglas:

- ningún tenant puede leer o modificar datos de otro;
- el navegador nunca decide precios, permisos ni estados finales;
- una carga `GET` nunca toma un pedido: hace falta sesión, autorización y una acción explícita.

## Stack

- React 19, Vite y TypeScript estricto.
- React Router, TanStack Query, React Hook Form y Zod.
- Tailwind CSS.
- Supabase Auth, PostgreSQL/RLS, Storage, Edge Functions y Realtime.
- Vitest, Testing Library, Playwright y pgTAP.
- Vercel para el frontend estático.

No hay Express, Prisma, VPS ni API Node propia.

## Requisitos

- Node.js 22.12 o posterior.
- npm 10 o posterior.
- Supabase CLI actual.
- Docker Desktop o runtime compatible para Supabase local.
- Para desplegar: proyectos separados de Supabase y Vercel.

## Configuración guiada en Windows

```powershell
npm ci
npm run setup:project
npm run dev
```

`setup:project` solicita el correo real del Super Admin, la publishable key y la secret key modernas de Supabase, una URL productiva opcional y, si se activa, el par de Turnstile. La entrada de secretos es oculta. El asistente genera automáticamente:

- `.env.local`, únicamente con configuración pública del frontend;
- `.env.bootstrap`, únicamente para el bootstrap local;
- `.env.edge.production`, únicamente con variables personalizadas de Edge.

El Project Ref `coqkgyaekenxccbxlozo`, su URL y `http://localhost:5173` ya están configurados como valores base. La URL productiva puede dejarse vacía y actualizarse más adelante volviendo a ejecutar el mismo comando. El asistente preserva los secretos internos aleatorios válidos al reejecutarse, comprueba `.gitignore`, detecta el vínculo de Supabase y ofrece —siempre con confirmación— cargar secretos, aplicar migraciones, desplegar funciones y ejecutar el bootstrap. Nunca coloca una secret key en una variable `VITE_*` ni imprime valores sensibles.

Contrato generado definitivo:

- frontend: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_BASE_URL` y `VITE_TURNSTILE_SITE_KEY` solo si se activa Turnstile;
- bootstrap: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPER_ADMIN_EMAIL`;
- Edge custom: `APP_BASE_URL`, `APP_ALLOWED_ORIGINS`, `RATE_LIMIT_HASH_SECRET`, `MAINTENANCE_SECRET`, `TURNSTILE_ENABLED` y `TURNSTILE_SECRET_KEY` solo si se activa Turnstile.

Las variables de E2E (`E2E_*`) y generación de tipos (`SUPABASE_PROJECT_ID`, `SUPABASE_DB_URL`, `SUPABASE_TYPES_OUTPUT`, `SUPABASE_CLI`) son tooling opcional y no pertenecen a esos tres archivos.

## Supabase local

Comandos habituales:

```powershell
supabase start
supabase status
supabase db reset
supabase test db
supabase functions serve --env-file .env.edge.production
supabase stop
```

El asistente crea `.env.edge.production`; no lo copies ni completes a mano. El runtime moderno de Supabase inyecta `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` y `SUPABASE_SECRET_KEYS`. Los dos últimos son mapas JSON y las funciones usan la clave `default`; no se guardan en `.env.edge.production` porque el prefijo `SUPABASE_` está reservado. El esquema `private` no debe agregarse a `api.schemas`.

### Migraciones

Las 22 migraciones versionadas crean enums, identidad, tenants, catálogo, horarios, pagos, entrega, pedidos y snapshots; también helpers, triggers, RPC, RLS, Storage, Realtime, rate limiting, auditoría, autorización por campo para los datos sensibles de `restaurants`, aislamiento de perfiles desactivados, escrituras administrativas transaccionales, inventario de assets huérfanos, una allowlist explícita de `EXECUTE` por RPC y reemplazos de horarios sin colisiones intermedias.

Para probar que el entorno se reconstruye solo desde Git:

```powershell
supabase db reset
supabase test db
```

No hagas cambios de esquema manuales que no terminen en una migración incremental.

`save_restaurant_hours` guarda altas, cambios y bajas de horarios regulares y excepciones en una sola transacción. Valida todos los IDs antes de mutar, permite mover/intercambiar turnos sin chocar con índices únicos y no permite mezclar un cierre de día completo con turnos abiertos de la misma fecha. `save_product_catalog` hace lo mismo con el producto, sus grupos, opciones y bajas lógicas. Ambas RPC vuelven a verificar actor, tenant y referencias, y un error revierte el conjunto completo de cambios de base. Los archivos de Storage quedan fuera de esa transacción PostgreSQL.

### Tipos generados

Con Supabase local iniciado:

```powershell
npm run supabase:types
```

El script invoca la CLI sin shell y escribe `src/types/database.generated.ts` solo si la salida parece válida. Para un proyecto remoto, definí temporalmente `SUPABASE_PROJECT_ID`. Podés indicar una ruta de CLI no estándar con `SUPABASE_CLI`.

## Edge Functions

| Función | Acceso | Responsabilidad |
|---|---|---|
| `create-order` | Pública, `POST`, CORS allowlist | Anti-spam, Turnstile opcional, rate limit, revalidación y pedido transaccional |
| `register-whatsapp-opened` | Pública, `POST`, token mínimo | Registrar intento de apertura sin leer ni aceptar el pedido |
| `create-restaurant` | JWT, Super Admin `aal2` | Crear tenant e invitar primer administrador de forma idempotente |
| `invite-restaurant-user` | JWT y rol | Invitar/agregar miembros con mínimo privilegio |
| `import-products` | JWT y admin de tenant o Super Admin `aal2` | Revalidar y aplicar transaccionalmente hasta 500 productos por lote |
| `expire-orders` | Interna, secreto de mantenimiento | Expirar pedidos viejos en lotes; sin CORS de navegador |

Todas las funciones mutables aceptan `POST`; las expuestas al navegador manejan `OPTIONS`. `verify_jwt = false` en el gateway permite que el handler procese preflight y aplique su verificación versionada; las funciones privadas siguen verificando el usuario con Auth antes de usar capacidad administrativa.

En remoto:

```powershell
npx supabase secrets set --env-file .env.edge.production
supabase functions deploy create-order
supabase functions deploy register-whatsapp-opened
supabase functions deploy create-restaurant
supabase functions deploy invite-restaurant-user
supabase functions deploy import-products
supabase functions deploy expire-orders
```

No se incluyó ningún valor real en el repositorio. Consultá [deployment](docs/deployment.md) antes de ejecutar estos pasos.

## Bootstrap del Super Admin

El nombre visible inicial es **Lautaro Galván**, pero nunca se usa como criterio de autorización. El rol protegido en base es la única fuente de autoridad.

1. En Supabase Auth, enviá una invitación al correo real. La persona define su propia contraseña; no crees una temporal fija.
2. Confirmá que la invitación y el correo se completaron.
3. Ejecutá `npm run setup:project` y confirmá el bootstrap cuando el asistente lo ofrezca.
4. Si preferís conservar el archivo y ejecutar el paso después, usá:

   ```powershell
   npm run bootstrap:superadmin
   ```

   También se admite `npm run bootstrap:superadmin -- --email correo@dominio`.
5. Confirmá su eliminación cuando el asistente lo pregunte, o eliminá `.env.bootstrap` cuando termines.
6. Iniciá sesión, enrolá TOTP y comprobá que una operación crítica requiera `aal2`.

El script es local, se niega a correr en CI/Vercel, busca exactamente un usuario confirmado, hace upsert de perfil/rol y registra auditoría. No imprime la clave ni tokens. Ver el procedimiento ampliado en [operaciones](docs/operations.md#bootstrap-inicial-del-super-admin).

## Crear el primer restaurante

Con el Super Admin en `aal2`:

1. abrí `/superadmin/restaurantes/nuevo`;
2. completá datos, modalidades, moneda, zona horaria y administrador;
3. confirmá la creación;
4. el administrador acepta la invitación;
5. configurá horarios, excepciones, pagos, zonas, categorías y productos;
6. activá el restaurante y publicá el menú.

La aplicación no publica un restaurante en borrador. La plantilla XLSX descargable está en `public/templates/importacion-productos.xlsx`.

## Importar catálogo

El panel acepta la plantilla XLSX completa o un CSV de productos, con máximo 10 MB. Valida columnas, tipos, fechas, códigos duplicados, relaciones entre hojas, precios, booleanos y límites antes de llamar a `import-products`; la Edge Function repite autenticación, tenant, esquema, cardinalidad y tamaño, y la RPC vuelve a validar relaciones y aplica la metadata en una transacción. El JSON de la función se limita a 2 MiB y el lote a 500 productos, 2.500 grupos y 10.000 opciones.

Los modos son explícitos: `create_or_update` reconcilia por código; `create_only` informa todos los conflictos detectados antes de escribir; `skip_existing` deja intactos el producto existente, su categoría, grupos, opciones e imagen, pero importa el grafo completo de los códigos nuevos del mismo lote.

El ZIP opcional admite hasta 100 MB comprimidos, 250 MB extraídos en total y 15 MB por imagen original. Se abre y valida antes de confirmar la metadata; si está corrupto, la importación no comienza. Solo procesa JPEG, PNG o WebP con nombres seguros y vuelve a comprimir cada imagen antes de subirla. Una vez validado el ZIP, la metadata del catálogo se confirma antes de subir las imágenes: un fallo individual de imagen no revierte los productos y puede reintentarse desde la pantalla.

La UI muestra y exporta a CSV sanitizado errores de prevalidación, conflictos `create_only`, validaciones estructuradas de Edge/RPC y fallos de imágenes. Los errores internos no se exponen. Las imágenes de productos, logo y portada pueden quitarse; primero se retira su referencia de negocio y después se intenta borrar Storage y marcar `image_assets`. Ese cleanup es best-effort: un fallo puede dejar un objeto o registro huérfano. `list_orphan_image_assets` permite inventariarlo por tenant, pero no existe borrado automático: toda limpieza requiere revisión.

## Probar un pedido

1. Abrí `/r/:restaurantSlug` con un restaurante activo, publicado y dentro de horario.
2. Agregá un producto disponible y completá checkout.
3. Confirmá que la respuesta usa precios server-side y persiste `generated`.
4. Elegí **Abrir WhatsApp** para usar el enlace universal (puede derivar a la aplicación) o **Abrir WhatsApp Web** para abrir el cliente web en otra pestaña. El intento puede pasar a `whatsapp_opened`, pero no significa mensaje enviado.
5. Abrí `/admin/pedidos/tomar/:actionId` como miembro autorizado.
6. Verificá que solo cargar la página no cambie el estado.
7. Pulsá **Tomar pedido** y comprobá `accepted_by`, `accepted_at`, timeline y auditoría.
8. Repetí el claim con otra sesión: no debe sobrescribir al primer operador.

Para probar idempotencia, repetí la solicitud lógica con la misma key. Para probar seguridad, manipulá precio/opciones y usá un usuario de otro restaurante; el servidor debe recalcular o negar.

## Calidad y seguridad

```powershell
npm run security:check
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run build
npm audit --audit-level=high
supabase test db
```

`npm run security:check` detecta errores estáticos frecuentes sin imprimir el valor encontrado. GitHub Actions ejecuta lint, typecheck, unitarias, smoke E2E en Chromium, build, auditoría, formato/lint/typecheck/tests de Edge Functions, reconstrucción/pgTAP y Gitleaks. El flujo E2E conectado a Supabase se habilita solo con `E2E_LIVE=1` y un entorno aislado con fixtures; no uses credenciales productivas. La prueba opt-in que crea un pedido requiere además `E2E_CREATE_ORDER=1`, `E2E_RESTAURANT_SLUG` y un `E2E_BASE_URL` cuyo origen esté incluido en `APP_ALLOWED_ORIGINS`; nunca abre ni envía el WhatsApp.

### Verificación disponible en este checkout

- Las 22 migraciones se aplicaron en orden al proyecto vinculado. Las 9 suites suman 217 aserciones pgTAP y se ejecutan dentro de transacciones con `ROLLBACK`; incluyen alta inicial y reemplazo seguro de horarios, aislamiento tenant, pedidos, Storage y la matriz exacta de `EXECUTE`. La verificación confirmó 19/19 tablas públicas con RLS, cero grants de tabla para `anon`, cero grants de cliente sobre `private`, ningún `SECURITY DEFINER` sin `search_path` fijo, funciones futuras sin `EXECUTE` implícito y `get_public_menu` como única RPC disponible para `anon`.
- En este host no hay Docker ni Podman; por eso no se pudieron repetir `supabase start`, `supabase db reset`, `supabase test db` ni la generación local de tipos contra el stack oficial. `supabase db lint` tampoco estuvo disponible por falta de `plpgsql_check`.
- Las Edge Functions sí se verificaron con Deno: formato de 33 archivos, lint de 32, typecheck y 28/28 tests del contrato moderno y la lógica compartida.
- El proyecto vinculado tiene las migraciones y Edge Functions desplegadas. El flujo live menú → carrito → checkout → creación → confirmación se verificó contra el restaurante de prueba; la prueba automatizada no abre ni envía WhatsApp.

## Deploy

El frontend se compila con:

```powershell
npm run build
```

Vercel sirve `dist`, reescribe rutas de SPA a `index.html`, no cachea agresivamente el shell y cachea assets con hash. Configurá las tres variables públicas base y, solo si activás Turnstile, `VITE_TURNSTILE_SITE_KEY`. El deploy de Vercel no despliega migraciones ni Edge Functions: aplicalos primero en Supabase y realizá un smoke test de staging.

Este repositorio no contiene evidencia de un despliegue real. Seguir [instalación y despliegue](docs/deployment.md).

## Documentación

- [Arquitectura y límites de confianza](docs/architecture.md)
- [Modelo de datos y snapshots](docs/data-model.md)
- [Seguridad y respuesta a incidentes](docs/security.md)
- [Matriz RLS, RPC y Storage](docs/rls-matrix.md)
- [Flujo completo del pedido](docs/order-flow.md)
- [Instalación y despliegue](docs/deployment.md)
- [Operación, backup y recuperación](docs/operations.md)

## Troubleshooting

### La app indica que faltan variables

Ejecutá nuevamente `npm run setup:project`, reiniciá Vite y verificá que la comprobación final haya terminado correctamente.

### Una Edge Function responde `ORIGIN_NOT_ALLOWED`

`Origin` debe coincidir exactamente con una entrada de `APP_ALLOWED_ORIGINS`, incluido esquema y puerto. No agregues `*`; corregí la lista y redesplegá secretos/función.

### El Super Admin recibe MFA requerido

Es el comportamiento esperado en `aal1`. Completá el challenge TOTP y repetí la operación con una sesión `aal2`. No relajes la RPC o RLS.

### El menú no aparece

Comprobá slug, `status = active`, `public_menu_enabled`, categorías/productos activos y la salida de `get_public_menu`. Estar cerrado impide checkout, pero no debería ocultar un menú publicado.

### `create-order` responde que está cerrado

Revisá zona IANA, día de semana, turnos que cruzan medianoche y `special_hours`. La base usa hora del servidor, no la del dispositivo.

### `npm run supabase:types` no encuentra la CLI

Instalá Supabase CLI y verificá `supabase --version`. Si está en una ruta no estándar, definí `SUPABASE_CLI` con el ejecutable. Para modo local, ejecutá antes `supabase start`.

### Una invitación no llega

Revisá Auth logs, rate limit del proveedor, spam y Redirect URLs. El SMTP incluido de Supabase es limitado; configurá SMTP propio para uso real.

### Realtime duplica avisos

Confirmá una sola suscripción por componente/restaurante y su cleanup al desmontar. Realtime respeta la lectura RLS; nunca lo soluciones abriendo una policy global.

## Fuera de alcance

No incluye pago online, WhatsApp Business API, confirmación real de envío del mensaje, tracking, geocodificación, facturación, inventario, pedidos programados, apps nativas ni impersonación.
