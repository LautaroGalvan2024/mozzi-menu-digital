# Auditoría de backend y continuidad del servicio

Fecha: 17 de noviembre de 2026, America/Buenos_Aires. Base: `main`, commit `e846d92db7e4aef920117b5f3e0b5472bd26e2ff`, con los cambios locales preexistentes conservados.

El backend tiene una base sólida de autorización, transacciones e idempotencia. Conviene conservar PostgreSQL y Supabase como núcleo y corregir fallos específicos antes de hacer una refactorización amplia. La prioridad principal es un fallo reproducido del mantenimiento: un comercio con conteo físico abierto puede impedir que se liberen reservas vencidas de otros comercios.

Esta auditoría no cambia código funcional, dependencias, migraciones ni configuración productiva. Añade este informe y evidencia técnica. Las pruebas con escrituras se ejecutaron exclusivamente en una base local nueva con datos sintéticos. En el proyecto vinculado se consultaron solamente metadatos mediante transacciones de solo lectura, sin pedidos, pagos, invitaciones ni operaciones de Storage.

## Alcance y evidencia

Se revisaron las 39 migraciones en su orden efectivo, 13 Edge Functions, autorización, RLS, Storage, pedidos, stock, pagos, contratos del cliente, API de Vercel, scripts Node, CI y recuperación. Los problemas de cliente incluidos afectan directamente contratos del backend o el ciclo de vida de recursos compartidos.

El negocio corre en PostgreSQL y Edge Functions de Supabase, sobre Deno/TypeScript. Node se utiliza en herramientas y en la función de Vercel para Open Graph. No existe una API Express de negocio que necesite ser reorganizada.

La inspección del proyecto vinculado confirmó:

- Las mismas 39 versiones de migración que el repositorio, sin versiones faltantes ni adicionales.
- 26 tablas públicas, todas con RLS habilitado.
- Sin permiso `USAGE` de `anon` ni `authenticated` sobre el esquema `private`.
- 156 funciones en `public` y `private`: sus definiciones y ACL coinciden exactamente con la reconstrucción local, comparadas por firma y hash de `pg_get_functiondef`.
- Ninguna de las funciones `SECURITY DEFINER` inspeccionadas carece de un `search_path` fijado.

Esto confirma correspondencia de las 156 funciones comparadas y sus permisos de ejecución. No compara íntegramente tablas, índices, constraints, triggers ni políticas RLS. No certifica que los bundles Edge/frontend desplegados sean idénticos al checkout, ni valida ajustes remotos de Auth, políticas de Storage, configuración efectiva de cron, alertas, cuotas o recuperación ante desastre. No se realizaron carga ni explotación sobre producción.

## Prioridades

P1 identifica un defecto de disponibilidad con alcance entre comercios que merece atención inmediata. P2 identifica defectos de fiabilidad, integridad, operación o crecimiento. Las hipótesis sin reproducción se separan de los defectos comprobados.

| ID | Prioridad | Hallazgo | Evidencia |
|---|---|---|---|
| B01 | P1 | Un conteo físico bloquea el vencimiento de reservas de otros comercios | PostgreSQL local, reproducido |
| B02 | P2 | El retorno de un pago puede mostrar otra compra del mismo comercio | Almacenamiento reproducido y recorrido del componente |
| B03 | P2 | El inventario de huérfanos incluye imágenes activas y el cleanup desconoce referencias compartidas | RPC autenticada reproducida y código del cleanup |
| B04 | P2 | La base admite cierre completo y apertura especial para la misma fecha | Escritura autenticada reproducida |
| B05 | P2 | La cola de conciliación sigue recorriendo intentos expirados y todo el historial elegible | PostgreSQL local y selección SQL |
| B06 | P2 | El vencimiento predeterminado de WhatsApp añade dos horas a un vencimiento ya definido | Contratos Edge/SQL |
| B07 | P2 | Los errores del wrapper HTTP no tienen log correlacionable | Handler simulado, sin red |
| B08 | P2 | El guard de algunos scripts locales permite overrides de conexión heredados | Configuración reproducida sin conectar |
| B09 | P2 | El respaldo personalizado combina snapshots distintos | Orden de ejecución de backup/restore |
| B10 | P2 | Las invitaciones escanean el directorio global y tienen recuperación incompleta | Código de Auth/provisioning |
| B11 | P2 | Pruebas existentes de concurrencia y mantenimiento quedan fuera de CI | Workflow y ejecución local |
| B12 | P2 | La auditoría npm falla por una vulnerabilidad en herramientas de desarrollo | npm audit y aviso publicado |

## Hallazgos y cambios compatibles

### B01 El vencimiento de reservas falla entre comercios

`expire_online_reservations` procesa varios comercios dentro de una única transacción. Al intentar liberar una reserva de un comercio con `inventory_cutover_id`, `private.online_stock_operation` arroja `INVENTORY_CUTOVER`. El error revierte también las liberaciones anteriores de comercios sanos.

Referencias: `supabase/migrations/202610270003_online_payments.sql:415`, `supabase/migrations/202611060001_optional_product_stock.sql:273`, `supabase/functions/reconcile-payments/index.ts:56`.

La reproducción colocó primero una reserva vencida de un comercio sano y después otra de un comercio en conteo. El lote devolvió SQLSTATE `22023`; el comercio sano conservó `reserved=1` y su pedido siguió `generated`. El siguiente mantenimiento puede volver a encontrar el mismo obstáculo. No se comprobó que haya ocurrido un incidente productivo.

**Corrección:** conservar la protección del conteo y aislar cada candidato, con omisión temporal, diagnóstico y reintento de los bloqueados. Mantener firma y retorno de la RPC. `SKIP LOCKED` por sí solo no corrige esta excepción de negocio. Conservar el orden de locks restaurante → pedido → intento → saldos y evitar que los candidatos omitidos ocupen indefinidamente todo el límite del lote.

**Cierre:** probar comercio bloqueado al principio y al final, varios lotes, fin del conteo, concurrencia con aprobación y ausencia de liberación duplicada. El vencimiento de WhatsApp no utiliza esta misma liberación online.

### B02 El retorno de Mercado Pago puede recuperar otra compra

El backend incorpora `?order=<actionId>` al retorno. El cliente conserva una sola capacidad de recuperación por comercio, por lo que una compra B reemplaza la referencia de A. Al retornar del pago de A, `PaymentStatusPage` lee B, no compara con el pedido de la URL y elimina los parámetros. La validación de respuesta contra la referencia B no detecta esta discrepancia.

Referencias: `supabase/functions/_shared/mercadopago.ts:229`, `src/features/store/payment-recovery.ts:24`, `src/features/store/PaymentStatusPage.tsx:87` y `:109`.

El probe con las funciones reales de almacenamiento devolvió `returnOrder=A`, `restoredOrder=B`, `matchesRequestedOrder=false`, `storedRecords=1`. La consecuencia en pantalla se determinó leyendo el componente; no se ejecutó un checkout externo. El problema no permite acreditar un pago falso ni demuestra fuga entre comercios, pero puede mostrar el estado y enlace de una compra diferente.

**Corrección:** guardar capacidades por comercio y pedido; usar `order` solamente para elegir una capacidad válida, nunca como prueba de pago. Si la URL especifica un pedido, leer el registro legado solo si su `actionId` coincide. Sin capacidad para A, mostrar recuperación no disponible en lugar de B. Conservar también la recuperación de la última capacidad validada al entrar a `/pago` sin `order`, porque el cliente actual elimina ese parámetro. Mantener los endpoints y sus respuestas.

**Cierre:** dos compras en dos pestañas, regreso a una compra anterior, URL manipulada, token faltante/vencido, compatibilidad con almacenamiento previo y recarga de la ruta legacy sin query.

### B03 Las referencias de imágenes están incompletas

`list_orphan_image_assets` considera referencias de restaurantes, categorías y productos, pero omite familias. También ignora que una ruta primaria representa un conjunto de derivados responsivos. La subida registra todos los objetos y devuelve el primario; el navegador deriva las rutas de tamaños menores.

Referencias: `supabase/migrations/202609280019_asset_orphan_inventory.sql:34`, `src/lib/images/upload.ts:16`, `src/lib/images/responsive.ts:20`, `src/features/catalog/ProductFamilies.tsx:319`.

Como administrador autenticado, la RPC clasificó `family-only.webp`, `responsive-320.webp` y `responsive-640.webp` como `unreferenced_asset` aunque estaban en uso. Además, el editor permite compartir una foto con la familia y luego elimina la foto anterior del producto sin revisar esa referencia: `src/features/catalog/ProductEditorPage.tsx:488` y `:579`.

**Corrección:** reconocer familias y todos los derivados como una misma unidad de imagen. Centralizar la comprobación de referencias antes del borrado y hacerla bajo autorización del tenant. Mantener rutas y formatos actuales. Eliminar objetos mediante la API de Storage, no borrando únicamente su metadata SQL, como indica la [documentación de Storage](https://supabase.com/docs/guides/storage/management/delete-objects).

**Cierre:** foto compartida → reemplazo de variante; derivados activos → no huérfanos; retirada de última referencia → candidato válido; fallo de Storage → reintento seguro. Hasta entonces, el inventario actual no debe usarse como lista automática de borrado.

### B04 La exclusividad de horarios especiales no es una invariancia de base

La RPC valida que una fecha cerrada no tenga turnos abiertos, pero siguen permitidas escrituras directas autenticadas sobre `special_hours`. Un administrador pudo insertar una fila cerrada con `slot_index=0` y otra abierta 09–18 con `slot_index=1` para el mismo comercio y fecha. `SET CONSTRAINTS ALL IMMEDIATE` no rechazó el estado: dos filas, una abierta y una cerrada.

Referencia: `supabase/migrations/202609290003_hours_replacement_safety.sql:61` y `:92`, junto con grants/RLS efectivos sobre `special_hours`. La validación SELECT de la RPC tampoco establece por sí sola una serialización por fecha.

**Corrección:** garantizar la regla en la base con validación diferida y bloqueo consistente, preservando los reemplazos/intercambios de turnos. Antes de revocar escrituras directas, inventariar clientes que las usan. Verificar y resolver datos contradictorios existentes mediante un procedimiento explícito.

**Cierre:** escritura directa autorizada, dos transacciones sobre una misma fecha, cambio de cierre a varios turnos y rechazo entre tenants.

### B05 La conciliación pierde frecuencia a medida que crece el historial

`list_online_reconciliation` selecciona estados financieros `pending`, `rejected`, `requires_refund`, `approved` y `partially_refunded`, sin edad ni próxima fecha de revisión. Después de expirar una reserva en la prueba, el pedido quedó `expired`, su pago `pending` y continuó en la cola. Los pedidos aprobados y entregados también siguen siendo elegibles.

Referencias: `supabase/migrations/202610270003_online_payments.sql:402`, `supabase/functions/reconcile-payments/index.ts:35`, `scripts/database/configure-commerce-maintenance.mjs:13` y `:201`.

El instalador versionado solicita 10 intentos cada 5 minutos. Para una cola estable de 1.000 intentos, una vuelta requiere aproximadamente 500 minutos, es decir, 8 h 20 min. Es un cálculo del diseño, no una medición ni la configuración remota confirmada. Los webhooks siguen siendo la vía principal y los intentos nunca conciliados tienen prioridad.

**Corrección:** incorporar próxima revisión y prioridades con cadencias diferentes para pendientes recientes, expirados recuperables y pagos históricos. Mantener vigilancia de devoluciones/contracargos; no retirar ciegamente todos los aprobados. Separar el presupuesto de expiración del trabajo remoto de conciliación: actualmente la expiración espera a que termine la tanda de llamadas al proveedor.

**Cierre:** simular 1.000/10.000 intentos con estados y antigüedades representativos; medir edad máxima de pendientes y vencidos, duración y recuperación de fallos. Verificar el scheduler efectivo y la respuesta HTTP, no solamente el éxito de encolado de cron.

### B06 La ventana de vencimiento de WhatsApp se aplica dos veces

La creación fija `expires_at = now() + 2 hours`. El handler de mantenimiento calcula `before = now() - olderThanMinutes`, con default 120, y la RPC compara `expires_at <= before`. Un pedido de las 10:00 deja de poder tomarse a las 12:00, pero el mantenimiento predeterminado lo marca vencido hacia las 14:00. La autorización de claim sí respeta el vencimiento real.

Referencias: `supabase/migrations/202610010001_product_quantity_pricing.sql:806`, `supabase/functions/expire-orders/index.ts:22`, `supabase/functions/_shared/schemas.ts:378`, `supabase/migrations/202609280008_order_admin_rpcs.sql:315`. Ya estaba registrado como O09 en la auditoría mayorista previa y continúa vigente.

**Corrección:** definir si el parámetro representa edad de creación o gracia posterior a `expires_at`. Introducir una transición explícita o un parámetro opcional; no reinterpretar silenciosamente un request que un scheduler ya pueda estar enviando. Probar reloj controlado y compatibilidad con llamadas anteriores.

### B07 Los errores no tienen correlación en logs de aplicación

El catch común de `serve` transforma las excepciones en errores sanitizados con `requestId`, pero no las registra. Un handler simulado que arrojó un error produjo HTTP 500 con identificador y cero llamadas a los métodos de log. Los handlers que usan este wrapper registran principalmente éxitos. Esto dificulta investigar un identificador que el cliente reporta.

Referencia: `supabase/functions/_shared/http.ts:142`. Los logs de plataforma pueden conservar estado y duración; no reemplazan el vínculo entre este identificador y un evento de aplicación.

**Corrección:** emitir un evento estructurado y sanitizado con ruta, status, código, duración y `requestId`; añadir opcionalmente un header de correlación. Conservar el cuerpo y códigos actuales. No registrar payloads, Authorization, secretos, teléfonos ni mensajes internos crudos. Probar ausencia de datos sensibles.

### B08 El aislamiento de herramientas depende de variables externas

`localDatabaseEnvironment` valida `PGHOST` y el prefijo de base, pero hereda `PGHOSTADDR`, `PGSERVICE` y `PGSERVICEFILE`. El probe construyó un entorno con `PGHOST=127.0.0.1` y `PGHOSTADDR=192.0.2.1`: el guard lo aceptó. No se abrió ninguna conexión con ese override. [libpq documenta](https://www.postgresql.org/docs/17/libpq-connect.html) que `hostaddr` determina la dirección de conexión.

Referencia: `scripts/database/connection.mjs:31`. El agregador de concurrencia tiene protección adicional; algunos scripts invocados individualmente no. Con credenciales y un destino válidos, una herramienta supuestamente local podría actuar fuera de loopback.

**Corrección:** centralizar rechazo de overrides, validar estrictamente host/base y distinguir bases sintéticas de restauraciones. Probar la construcción del entorno sin conectarse. Durante esta auditoría se eliminaron esos overrides antes de cualquier conexión o prueba local. No cambia ningún contrato de usuario.

### B09 Los respaldos no comparten un punto consistente

El script obtiene conteos, ejecuta tres dumps independientes y después lista/descarga Storage. El verificador de restauración exige coincidencia con aquellos conteos. Un pedido entre el conteo y el dump puede hacer fallar una restauración válida; una imagen sustituida durante la copia puede dejar metadata y archivos de momentos diferentes.

Referencias: `scripts/database/backup-linked.mjs:20`, `:28` y `:32`; `scripts/database/local-test-restore.mjs:53`. No se afirma corrupción interna de `pg_dump`: cada dump tiene consistencia propia y [PostgreSQL ofrece snapshots compartidos](https://www.postgresql.org/docs/17/app-pgdump.html).

**Corrección:** compartir snapshot exportado entre conteos/dumps, o derivar el manifiesto de una restauración del propio dump. Para Storage, usar rutas inmutables y una política de retención que cubra la ventana de respaldo. Verificar recuperación con altas y reemplazos concurrentes en staging, incluyendo tiempos de recuperación y pérdida admisible de datos.

### B10 Las invitaciones necesitan búsqueda acotada y recuperación

Cuando no hay perfil para un email, `invitations.ts` busca hasta 50 páginas de 1.000 usuarios en Auth: el alta normal crece con el directorio global. La búsqueda inicial por igualdad de `email` tampoco coincide con el índice de expresión `lower(email)`.

Referencias: `supabase/functions/_shared/invitations.ts:16` y `:38`, `supabase/migrations/202609280002_identity_restaurants.sql:13`. La [API de listUsers es paginada](https://supabase.com/docs/reference/javascript/auth-admin-listusers); no es una búsqueda exacta por email.

Además, una identidad existente sin confirmar retorna sin reenviar correo. La invitación Auth precede a la transacción de creación/membresía, por lo que un fallo de base puede dejar un alta incompleta. La UI informa el no reenvío; no es un envío oculto ni duplicado.

**Corrección:** lookup exacto e indexado por una vía interna de mínimo privilegio; reconciliar usuarios legacy fuera del request. Incorporar estado durable de provisioning y una acción explícita de reenvío con límites. Mantener la idempotencia y `{user, invited}`. Probar carrera de alta, email preexistente, invitación vencida y fallo posterior al envío.

### B11 La automatización no ejecuta toda la cobertura disponible

CI corre pgTAP y smoke HTTP local, pero no incorpora los harnesses de carreras reales que se ejecutaron en esta auditoría. Vitest incluye solo `src/**/*.test.{ts,tsx}`; las cinco pruebas Node del instalador de mantenimiento también quedan fuera.

Referencias: `.github/workflows/ci.yml:123`, `vite.config.ts:16`, `scripts/database/configure-commerce-maintenance.test.mjs`, `scripts/database/local-test-concurrency.mjs`.

**Corrección:** incorporar las pruebas Node y adaptar los runners nativos de concurrencia a Linux/`psql`, manteniendo su guard de entorno. Agregar regresiones de B01–B04. Los 50 escenarios actuales pasan; eso no cubre automáticamente los casos nuevos.

### B12 npm audit falla en herramientas de desarrollo

`npm audit --json` reportó seis entradas high relacionadas con un mismo aviso raíz de `picomatch` 4.0.7: la cadena incluye Vite, Vitest, plugin-react, fdir y tinyglobby. `npm audit --omit=dev --json` reportó cero vulnerabilidades. Esta última cifra se refiere al árbol npm de producción, no certifica todas las dependencias de Deno ni la aplicación completa.

Referencia: `package-lock.json:3751`. El [aviso GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), consultado el 17/11/2026, describe ReDoS mediante patrones extglob y no identifica una versión corregida. El paso actual de auditoría de CI falla con ese resultado.

**Corrección:** analizar exposición a patrones no confiables en tooling y seguir el parche del mantenedor. Cuando exista una solución compatible, actualizar selectivamente y repetir instalación reproducible/build/tests. Si se necesita una excepción de CI, hacerla específica, justificada y con revisión temporal. No aplicar `npm audit fix --force`: la propuesta automática puede degradar versiones principales y no prueba que desaparezca el riesgo.

## Escalabilidad y rendimiento

### Lecturas públicas y Open Graph

La paginación actual ya reduce mucho el costo respecto del catálogo completo. Un benchmark sintético local, PostgreSQL 17.11, cinco ejecuciones medidas después de un calentamiento, dio:

| Productos | Metadata media | Página menú 24 media | Página tienda 24 media | Catálogo completo media | Tamaño completo JSON |
|---:|---:|---:|---:|---:|---:|
| 500 | 0,75 ms | 2,94 ms | 7,23 ms | 36,36 ms | 246.372 bytes |
| 1.500 | 0,91 ms | 5,27 ms | 13,21 ms | 113,82 ms | 737.876 bytes |
| 5.000 | 0,78 ms | 14,23 ms | 31,45 ms | 385,48 ms | 2.459.876 bytes |

La página de tienda de 5.000 productos produjo 15.247 bytes. Fixtures de productos simples, una categoría por comercio, sin carga HTTP, WAN, compresión ni concurrencia controlada; no representan p95 productivo ni capacidad por plan.

`api/menu-preview.ts:202` sigue solicitando el catálogo completo incluso para la vista previa de un único producto. Cada URL nueva/cache miss paga ese costo y el handler tiene un timeout de cuatro segundos.

**Cambio compatible:** RPC aditiva para metadata de comercio/producto, con la misma visibilidad y aislamiento. Conservar las RPC completas para consumidores existentes, HTML y URLs. Medir después catálogo con variantes/opciones y tráfico de crawlers. Los candidatos de las páginas se agrupan antes del LIMIT: devolver 24 grupos no implica trabajo constante sobre cualquier cardinalidad.

### Revisiones e inventario

Cada actualización de `inventory_balances` incrementa la fila única `catalog_revisions` del comercio. `inventory_apply` actualiza los SKU en un loop, por lo que una operación de N SKU genera N incrementos. Transacciones de stock disjunto compiten por la misma revisión; el polling del cliente también puede invalidar páginas completas con frecuencia.

Referencias: `supabase/migrations/202610240003_inventory_reservations.sql:170`, `supabase/migrations/202610290001_catalog_pagination_and_revisions.sql:284`, `supabase/migrations/202610290002_catalog_revision_trigger_fix.sql:12`.

Es un punto de contención identificado por diseño, sin degradación productiva medida. Medir locks, p95 y recargas; evaluar actualización por conjunto o una revisión por operación. Separar revisiones de stock y catálogo requiere mantener la semántica de la revisión existente mientras haya clientes antiguos. No eliminar invalidaciones que preservan disponibilidad/precios.

### Índices y retención

La reconstrucción confirmó ausencia de índice por `attempt_id` en `online_payment_receipts`, pese a sus agregaciones por intento; los intentos tampoco tienen índices para `last_reconciled_at`/`expires_at`, y los tokens de estado solo tienen PK `(order_id, token_hash)`. Medir planes de reconciliación, expiración y purga con cardinalidades representativas antes de definir índices compuestos o parciales. Un índice candidato prioritario es `receipts(attempt_id)`.

Los tokens auxiliares e idempotencia administrativa no tienen toda su retención automatizada; `docs/operations.md:148` ya lo reconoce. Definir ventanas que respeten recuperación e idempotencia, con limpieza acotada y observable. No borrar ledger ni auditoría como si fueran caché.

### Riesgo adicional de locks en una RPC legacy

La RPC pública `save_product_family` bloquea familia antes de producto; el checkout toma producto antes de familia. Las definiciones efectivas muestran que los locks previos compartidos del restaurante no descartan la inversión. Un interleaving puede terminar en deadlock y rollback de una operación.

Referencias: `supabase/migrations/202610270002_catalog_families.sql:107`, `:118` y `:222`. El wrapper `save_product_family_with_stock` usado por la UI actual sí toma un bloqueo exclusivo anterior. No se reprodujo una carrera de la RPC legacy ni se observó un deadlock productivo.

Antes de corregir: agregar una prueba de dos sesiones sobre el endpoint antiguo; unificar orden de locks preservando su firma. No retirar la RPC como atajo sin conocer sus consumidores.

## Orientación a objetos y responsabilidades

La falta de clases no es por sí sola un defecto. En este sistema, la frontera transaccional de permisos, precios, reservas y estados debe seguir en PostgreSQL. Llevarla a múltiples llamadas Node podría introducir precisamente las operaciones parciales que se busca evitar.

Sí hay una oportunidad clara de aplicar composición, inversión de dependencias y responsabilidades pequeñas. `_shared/mercadopago.ts` concentra configuración, esquemas, OAuth, credenciales, transporte HTTP y conciliación. La separación gradual propuesta es:

| Componente | Responsabilidad | Dependencias explícitas |
|---|---|---|
| `MercadoPagoClient` | HTTP, timeouts y normalización de errores del proveedor | Transporte, configuración |
| `PaymentAccountRepository` | Acceso autorizado a cuentas y leases mediante RPC | Cliente Supabase tipado |
| `PaymentAttemptRepository` | Intentos, comprobantes y transiciones atómicas existentes | Cliente Supabase tipado |
| `PaymentReconciliationService` | Coordinar consulta, validación y aplicación del resultado | Los componentes anteriores, reloj y logger |
| Funciones de dominio | Comparar importes, validar referencias y mapear estados | Datos explícitos, sin I/O |

Clases cuando encapsulen configuración o dependencias; funciones puras para reglas deterministas. Evitar herencias extensas, repositorios CRUD genéricos que oculten tenant/permisos y una clase única que concentre todas las responsabilidades. Los exports actuales pueden permanecer como fachada mientras se extraen piezas internamente.

También conviene tipar el cliente Edge con un contrato de base generado/compartido: `SupabaseClient` se usa sin el parámetro `Database`. Los schemas runtime siguen siendo necesarios aunque se mejore el tipo estático. Activar gradualmente `strict`/`noUncheckedIndexedAccess` en `tsconfig.node.json` ayuda a la función de Vercel.

`ServeOptions.maxBodyBytes` se declara, pero `serve` no lo utiliza: cada handler repite correctamente el límite al llamar `readJson`. No se encontró bypass actual; conviene tener una única política comprobable para que un handler nuevo no diverja.

Supabase recomienda limitar privilegios de las funciones y fijar `search_path` cuando se use `SECURITY DEFINER`; este proyecto ya implementa esas defensas y deben conservarse. Las mejoras de RLS se deben medir teniendo en cuenta si el helper depende de cada fila. Referencias: [funciones de base](https://supabase.com/docs/guides/database/functions) y [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Plan de mejora sin romper consumidores

1. **Congelar y probar contratos.** Inventariar rutas, firmas/argumentos RPC, nombres JSON, códigos de error, representación de importes, tokens y comportamiento de replay. Guardar casos canónicos de consumidores actuales, incluidos los endpoints legacy. Añadir las regresiones B01–B04 antes de tocar lógica.
2. **Corregir disponibilidad e integridad.** B01 primero; después recuperación de pagos, imágenes compartidas y horarios. Cambios pequeños y separados. Preservar todas las invariantes financieras y de stock; no omitir validaciones para que una prueba pase.
3. **Mejorar operación.** Logging sanitizado, aislamiento central del tooling, CI de carreras, conciliación con cadencias y recuperación de backups. Verificar cron/HTTP, edad de reservas y cola, errores y fallos de webhooks en el entorno real.
4. **Optimizar con mediciones.** Preview puntual, índices y revisiones. Medir antes/después bajo el tráfico y tamaño reales del cliente; definir objetivos de latencia y disponibilidad según ese uso.
5. **Extraer responsabilidades.** Aplicar SOLID/OOP dentro de las funciones manteniendo sus fachadas. Una extracción por vez, sin cambio simultáneo de reglas de negocio.

Para cada cambio SQL: migración nueva e incremental; no editar una migración aplicada. Desplegar primero adiciones compatibles de base, luego Edge y finalmente cliente. Mantener un período donde cliente antiguo y nuevo funcionen con el mismo backend. Para cambios incompatibles inevitables, agregar una versión de RPC/endpoint y retirar la anterior solamente cuando sus consumidores hayan migrado.

Una migración aditiva también puede bloquear tráfico. Revisar los locks y el volumen de actualización antes de aplicarla: límites acotados de `lock_timeout`/`statement_timeout`, creación concurrente de índices cuando corresponda y backfills por lotes. Probar el procedimiento de despliegue con tráfico concurrente en staging, además del resultado final del esquema.

La reversión debe contemplar datos escritos por la nueva versión: un rollback de código no revierte automáticamente un cambio de esquema o de estado. Preparar migración correctiva y conservar el contrato anterior. Validar en staging con pagos de prueba y un despliegue acotado; no ejecutar pruebas de carga ni generación de pedidos sintéticos sobre el comercio activo.

## Verificación realizada

| Control | Resultado |
|---|---|
| `npm run security:check` | Pasó |
| `npm run lint` | Sin errores; una advertencia de `Date.now()` durante render en un cambio local previo |
| `npm run typecheck` | Pasó |
| Vitest | 71 archivos, 566 pruebas aprobadas |
| Deno lint y typecheck | Pasaron |
| Deno tests | 105 pruebas aprobadas |
| Deno fmt check | Falló por finales de línea en 12 archivos; no se reformatearon |
| Reconstrucción SQL | 39 migraciones aplicadas en base local nueva |
| pgTAP | 26 suites, 1.109 aserciones aprobadas |
| Concurrencia PostgreSQL | 6 suites, 50 escenarios aprobados, 46 barreras de lock reportadas |
| Pruebas Node del instalador | 5 aprobadas |
| Probes de hallazgos | Reservas entre tenants, cola vencida, recuperación de pago, huérfanos y horarios confirmados con el alcance indicado |
| npm audit completo | 6 entradas high relacionadas con picomatch |
| npm audit sin devDependencies | 0 vulnerabilidades reportadas |
| Comparación SQL remoto/local | 39 migraciones y 156 definiciones/ACL coincidentes |

La base local usa PostgreSQL 17.11; el proyecto vinculado informó 17.6. El sustrato local incluye los esquemas administrados necesarios para SQL, pero no reproduce los servicios Auth, Storage, Realtime o el gateway Edge. Las pruebas SQL/concurrencia no sustituyen un smoke integrado en staging. No se ejecutaron E2E de navegador ni transacciones reales del proveedor durante esta auditoría.

Los casos diagnósticos terminaron con rollback; los harnesses existentes retienen sus fixtures sintéticas en `mozzi_audit_20261117`, separada de las bases previas. Al terminar, se detuvo de forma ordenada el cluster local que se había iniciado para las pruebas. No hubo cambios de producción.

## Evidencia conservada y mantenimiento documental

La carpeta `docs/auditoria-backend-2026-11-17/` conserva probes sintéticos, resultados y logs de concurrencia. Los SQL son evidencia de diagnóstico para una base local reconstruida; no son migraciones ni scripts de producción. Contienen operaciones de escritura aunque terminen en rollback. El probe de recuperación solo utiliza almacenamiento en memoria y puede ejecutarse desde la raíz con `node --import tsx docs/auditoria-backend-2026-11-17/payment-recovery-probe.mjs`.

El benchmark usa `catalog-probe.sql` y `catalog-probe-result.txt`. `schema-comparison.json` registra la coincidencia de funciones/ACL. No se incluyen credenciales, filas de clientes ni dump de datos productivos.

El README todavía describe 23 migraciones y el estado de una rama antigua. Actualizarlo en una tarea documental separada: el estado auditado tiene 39 migraciones, 13 Edge Functions y una cobertura considerablemente mayor. Las advertencias históricas no deben confundirse con hallazgos nuevos ni con el estado actual.
