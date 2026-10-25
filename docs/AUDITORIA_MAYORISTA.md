# Auditoría para operación mayorista

Fecha: **24/10/2026**, America/Buenos_Aires. Etapa: auditoría, diseño y planificación; sin implementación funcional.

Revisión documental posterior: alcance de la primera versión para **un mayorista**. Se conservan los hallazgos y mediciones originales; esta revisión no vuelve a certificar el código, las pruebas ni el despliegue y no implementa correcciones.

## 1. Veredicto ejecutivo

**No apto en las condiciones actuales para comprometer un servicio de catálogo, pedidos e inventario mayorista.** La base puede evolucionar a **apto con correcciones previas** manteniendo React, Vercel y Supabase. No se encontró un impedimento que justifique reescritura, microservicios o infraestructura adicional.

**500 es el límite de un lote de importación, no del catálogo.** El frontend mostró 500, 1.500 y 5.000 artículos sintéticos completos; eso no certifica capacidad de PostgreSQL, tráfico simultáneo ni experiencia aceptable en dispositivos reales. Hoy existen límites de pedidos, riesgos en importación/administración y, sobre todo, **no hay stock numérico ni descuento al entregar**.

La primera entrega se evalúa con el catálogo, pedidos, operadores y pico acordados para ese mayorista. Los escenarios de 10 o 50 comercios y 5.000 productos son referencias de crecimiento y estrés; **no son condiciones automáticas para habilitar ese piloto**. Sí son obligatorias la integridad del inventario, los permisos efectivos, la recuperación de reintentos y la validación de su volumen real en un entorno aislado.

Condiciones antes de ofrecer la primera versión:

1. Corregir la invitación que permite degradar administradores y el procesamiento excesivo de entradas públicas (S01/S03/S04).
2. Evitar actualización destructiva de precios y catálogos inválidos (C02/C10/C11); cerrar C05 si usa opciones y C01 si el catálogo con margen alcanza el límite efectivo de filas. Comprobar esas condiciones antes del piloto.
3. Acordar qué acción representa una entrega física, tamaño del pedido, unidad/caja/fracción, disponibilidad al aceptar y ventas por otros canales; adaptar límites/UX según ese acuerdo (O02/C09).
4. Implementar y probar entrega transaccional con inventario, sin doble descuento ni movimientos parciales (O01 y plan).
5. Resolver idempotencia con formulario modificado y revisión de precios canónicos (O03/O04/C03).
6. Validar instalación reproducible, pruebas DB/concurrencia aisladas, restauración y plan contratado compatible con uso comercial. **Suscripciones, cuotas, consumo y recuperación efectiva no están verificados.**

No se halló una fuga entre comercios en los caminos revisados, pero no equivale a un pentest aprobado: faltan pruebas negativas autenticadas y de concurrencia en base aislada. S01 afecta la separación de facultades dentro de un comercio.

### Alcance de lanzamiento y trabajo posterior

| Grupo | Alcance de la primera versión | Criterio de cierre |
|---|---|---|
| Correcciones indispensables | Permisos S01; entradas públicas S03/S04; importación C02/C10/C11; C01/C05 y límites según alcance comprobado; precios/reintentos del pedido; instalación reproducible y configuración operativa | Casos reproducidos y corregidos, regresiones del flujo vigente y pruebas de permisos en DB real aislada; catálogo completo accesible y pedido coherente |
| Inventario mínimo | Carga inicial, reposición, ajustes y otras ventas; entrega atómica e idempotente; correcciones/devoluciones acordadas; UI e informes que distinguen operaciones vigentes y compensadas; corte y contingencia | Pruebas DB reales de concurrencia, reintentos, rollback y permisos; conciliación de saldos/movimientos y piloto del mayorista |
| Mejoras posteriores | Escala multicomercio B/C, optimizaciones sin cuello demostrado, directorios globales y funciones comerciales adicionales | Se priorizan por crecimiento o necesidad confirmada; un defecto que afecte seguridad o integridad del piloto no se posterga por estar clasificado P2 |

El [plan de implementación](PLAN_MAYORISTA_Y_STOCK.md) concentra tareas, dependencias y estimación. **El lanzamiento completo no se estima en 5–8 jornadas**: ese rango describía tareas individuales. Para el escenario todavía **no aprobado** de unidad entera, sin reservas, devolución completa y carga manual de otras ventas, la base es **33–53 jornadas**, con margen del 20% y redondeo de planificación de **40–64 jornadas**. No es una fecha comprometida ni confirma que ese escenario represente la operación real. El plan desglosa ambiente, correcciones, modelo/RPC, UI/conteo, correcciones/reportes e integración/piloto. Devoluciones parciales y entregas parciales son ampliaciones independientes, con estimaciones provisionales de **4–7** y **8–12 jornadas**, respectivamente; requieren definición antes de incorporarse.

La primera tanda propuesta es **reproducción aislada y S01 de membresías, 3–5 jornadas incluidas en el total**, sin enviar correos reales. Debe preparar la base de prueba, reproducir la omisión y cubrir roles, estado vigente del administrador, protección del último administrador, reinvitaciones, carreras entre sesiones y compatibilidad de altas/reactivaciones permitidas. Su aceptación exige pruebas de DB real y del handler con correo simulado; no habilita stock ni acredita el lanzamiento completo. Esta revisión sólo documenta esa tanda: no la ejecuta.

## 2. Identidad, método y arquitectura

- Repositorio: `https://github.com/LautaroGalvan2024/mozzi-menu-digital.git`; npm `mozzi-menu`, versión declarada 0.0.0.
- Base de la auditoría original: checkout `C:\Users\Nico\Documents\ChatGPT\Mozzi-Menu`, rama `main`, commit **bf183767b8ba6012e2d33d177e473d5534669b9c** (01/10/2026). En esa toma `main...origin/main` no indicaba divergencia y no se hizo fetch; esa evidencia no certificaba el último commit remoto.
- Contexto de esta revisión documental: rama `feature/mayorista-stock`, creada desde `origin/main` actualizado; informes y benchmark preservados en el commit `97c6a36`, según la preparación de la rama realizada en esta sesión. Esto no convierte las mediciones históricas en pruebas repetidas sobre una nueva versión.
- Git inicialmente limpio. No se encontraron `AGENTS.md` en proyecto/directorios ascendientes inspeccionados. Se respetaron README, documentación y restricciones del pedido. Entornos/secretos existentes conservados y no reproducidos.
- Revisión del código propio, API, seis Edge Functions, helpers, **23 migraciones en orden** y pruebas. Se evaluaron definiciones finales, no grants/funciones obsoletas reemplazadas. No se revisó código generado/dependencias línea por línea.
- Ensayos locales sintéticos. Únicas consultas remotas: metadatos/configuración del esquema; sin carga, migraciones, degradaciones, pedidos reales ni mensajes a clientes.
- La auditoría añadió los informes de `docs` y soportes reproducibles de `docs/auditoria-mayorista`, sin cambios funcionales, dependencias nuevas ni despliegues. Esta revisión modifica sólo documentación; la conservación posterior en Git no implica implementación.

**Convenciones:** P1 bloquea compromiso o habilitación del flujo afectado; P2 reduce confiabilidad/operabilidad; P3 opcional. No hay P0 de exposición total demostrada. «Comprobado» significa código/ensayo indicado, no explotación remota. «Riesgo» es condición razonada todavía no reproducida. Los esfuerzos S hasta 1–2 jornadas, M 2–4 y L 5–8 son referencias históricas **por tarea**, más su validación; no son el esfuerzo de lanzamiento ni deben sumarse mecánicamente. La estimación integral y sus supuestos están en el plan enlazado.

| Capa | Implementación real | Implicación |
|---|---|---|
| Frontend | React 19, TypeScript estricto, Vite 8, Router 8, TanStack Query 5, RHF/Zod, Tailwind 4 | SPA con rutas lazy; Excel/ZIP no se cargan en cada visita pública |
| Publicación | `vercel.json` assets/fallback/headers; `api/menu-preview.ts` | Function Vercel sólo Open Graph; negocio en Supabase |
| Identidad | Supabase Auth, perfiles, roles, membresías, TOTP/AAL2 | Nombre/email/localStorage no otorgan permisos |
| Datos | PostgreSQL, RLS, FKs compuestas, checks, triggers/RPC | Precios y estados canónicos en servidor; 20 tablas públicas/3 privadas remotas |
| Archivos | Bucket público `restaurant-assets`, rutas tenant, WebP en cliente | 1 MiB máximo/objeto; Storage fuera de transacción SQL |
| Edge | create-order, register-whatsapp-opened, create-restaurant, invite-restaurant-user, import-products, expire-orders | API administrativa y controles propios; verify_jwt=false del gateway no implica ausencia de Auth en handlers privados |
| Integraciones | wa.me/WhatsApp Web, Turnstile opcional, correo Auth | Sin Business API, confirmación de envío, cobro online ni conexión a ventas externas |
| Realtime | orders/order_events; filtros tenant/cleanup | Pantallas administrativas, no suscripción por producto |
| Inventario | Sólo `products.available` manual | No existencias, movimientos ni reservas |

Modelo: comercio → categorías → productos → grupos/opciones; pedido → ítems/opciones con snapshots; usuarios → membresías. Las opciones son adicionales, **no variantes inventariables/SKU independientes**. Fuentes: `src/App.tsx`, `src/main.tsx`, `src/types/domain.ts`, `api/menu-preview.ts`, `supabase/config.toml` y migraciones.

### Documentado, implementado y desplegado

| Elemento | Evidencia obtenida | Límite |
|---|---|---|
| Supabase vinculado | Ref `coqkgyaekenxccbxlozo` en `.temp` y CLI | No certifica qué deployment/cliente usa ese backend |
| Migraciones remotas | `migration list --linked`: **23/23**, incluida 202610010001 | Historial no es checksum ni excluye cambios manuales |
| Esquema/permisos | SELECT catálogos: 20 tablas con RLS; anon EXECUTE sólo get_public_menu; private sin USAGE anon/authenticated; sin vistas públicas | No reemplaza tests de todas las policies por rol |
| Función sensible | pg_get_functiondef de upsert_restaurant_membership confirma omisión S01 remota | No se ejercitó vulnerabilidad ni comparó fuente Edge desplegada |
| Storage | Bucket público, MIME JPEG/PNG/WebP,1.048.576 bytes | No prueba archivos/restore existentes |
| Realtime | Publicación orders/order_events | No mide latencia/consumo |
| PostgreSQL | Remoto **17.6**; config local **15** | Alinear entorno para certificar reconstrucción |
| Edge | Seis ACTIVE; create-order v7, restantes v6 | No equivalencia fuente Git ni prueba funcional productiva |
| Vercel | `.vercel/project.json`: mozzi-menu-digital, Vite/npm/dist, Node 22.x | Sin verificar deployment activo/plan/headers/consumo |
| CI | `.github/workflows/ci.yml` ejecuta checks en `pull_request` y `push` a `main`: calidad/build/audit, DB/RLS, Edge y secretos | Sin etapa explícita de deploy; consulta original de runs vacía no prueba ausencia de runs por push ni CI verde |
| Integración Git de Vercel | Configuración externa no inspeccionada | Pendiente confirmar si crea previews o despliega automáticamente; no inferirlo del workflow de CI |
| README 197–200 | Declara migración 23 pendiente/baseline anterior | Desactualizado frente al historial remoto de la auditoría |

Comandos remotos de sólo lectura: `supabase migration list --linked`, `supabase functions list --project-ref ...` y `supabase db query --linked` con SELECT de `pg_class`, `pg_proc`, `pg_namespace`, `pg_publication_tables`, `pg_extension` y metadata de `storage.buckets`. pg_cron ausente. `authenticator_settings=null` al consultar sólo db_schemas/db_max_rows **no confirma** max_rows remoto: puede configurarse fuera de esas filas. No se leyó PII de pedidos.

### Permisos finales revisados

| Actor | Lectura | Escritura / acciones |
|---|---|---|
| Anónimo | RPC `get_public_menu` de restaurante activo/publicado; imágenes del bucket público | Edge `create-order` y `register-whatsapp-opened` con controles específicos; sin grants directos a tablas/RPC internas |
| Autenticado sin membresía | Perfil propio y sus roles/membresías autorizados | Solo nombre propio con perfil activo; sin catálogo/pedidos ajenos |
| `order_manager` activo | Catálogo/configuración propios, pedidos e ítems propios | Tomar, completar y cancelar pedidos propios por RPC; sin modificar catálogo, configuración o archivos |
| `restaurant_admin` activo | Lo anterior más miembros, perfiles autorizados, auditoría e inventario de assets propios | Catálogo/configuración/horarios/archivos propios; invitar managers; cambio de status de managers; defecto S01 permite degradar admins vía invitación |
| Super Admin AAL1 | Configuración/catálogo, perfiles y auditoría global según policies | Sin operaciones críticas globales ni lectura de pedidos por la sola condición de Super Admin |
| Super Admin AAL2 | Pedidos y administración global | Acciones globales, roles/membresías y campos protegidos de restaurante |
| `service_role` | Capacidad privilegiada servidor | RPC internas; ningún secreto administrativo debe estar en frontend |

Matiz: si un Super Admin tiene además una membresía de tenant activa, las helpers usan OR con esa membresía; puede ejercer las facultades de su membresía aun con AAL1. Esto es distinto de usar su autoridad global y no se clasificó como bypass.

### Matriz de cobertura

| Módulo | Profundidad | Comprobación y límite |
|---|---|---|
| Catálogo/búsqueda/promos | Alta | RPC final→Zod→render/modal; unitarias/E2E mock y benchmark; DB real pendiente |
| Productos/categorías/importación/imágenes | Alta | Editor/RPC, XLSX/CSV/ZIP, defaults, relaciones/reintentos; parser probado; integración SQL/Storage pendiente |
| Carrito/checkout/WhatsApp | Alta | Límites/precios/fingerprint/snapshots/enlaces; tests; sin enviar mensajes |
| Toma/estados/historial/export/métricas | Alta | SQL/autorización/consultas/fechas; carreras DB pendientes |
| Auth/roles/miembros/RLS/Storage | Alta | Helpers, grants finales, Edge, sesión y metadata remota; pruebas negativas aisladas pendientes |
| Horarios/excepciones | Media/alta | RPC de reemplazo, zona horaria/apertura SQL y tests |
| Pagos/zonas/configuración/marca | Media | Formularios/validaciones/retornos/RLS/campos protegidos y recálculo; no operación remota |
| Superadmin/alta/auditoría | Media/alta | AAL2/invitación/idempotencia/directorios/métricas; sin invitar usuarios |
| Operación/deploy/CI/backups | Media | Scripts/config/docs/metadata; plan/restore/SMTP/alertas/frontend activo pendientes |
| Stock | Ausencia confirmada y diseño | Aceptación propuesta, no tests de un módulo inexistente |

## 3. Capacidad y ajuste mayorista

| Dimensión | Estado/límite | Consecuencia |
|---|---|---|
| Catálogo total | Sin tope500 en tablas/RPC pública | Múltiples lotes; admin sin paginación puede ocultar filas C01 |
| Variantes/SKU | Código por producto único case-insensitive sin baja; opciones sin stock/SKU | Definir identidad de presentaciones/variantes antes de activar inventario |
| Imágenes | Una por producto,1 MiB máximo, objetivo300 KiB | Lazy público; admin eager sobredescarga; total no equivale a carga inicial |
| Renglones | UI/Edge25 entradas; SQL final50 antes de normalizar | Contratos distintos; externo efectivo25 |
| Cantidades |100 unidades **sumadas**,1–100/línea; modal1–20/agregado |25×5 ya excede total; sólo enteros |
| Promos | Packs combinables2–20,máximo19 reglas por configuración | No precios por cliente/caja ni umbral general |
| Concurrencia | Sin máximo certificado backend | Rate limits, contador por comercio y Realtime importan |
| Historia | Lista25, filtros fecha/status; CSV por1000/en memoria; retención indefinida | OFFSET/count/búsquedas/índices requieren volumen |
| Comercios | Aislamiento lógico en proyecto compartido | RLS no reserva CPU/egress por tenant |

La app limita **10/IP,5/teléfono,100/comercio por10 min**, incluidos reintentos que llegan al contador. No son cuotas Supabase. Validar al crear no garantiza disponibilidad futura.

### Importaciones, imágenes y límites de entrada

| Recurso | Límite implementado y evidencia | Significado |
|---|---|---|
| XLSX/CSV |10 MiB (`ImportProductsPage.tsx:72–75`) |CSV sólo Productos; XLSX Productos/GruposOpciones/Opciones |
| Lote |500 productos/2.500 grupos/10.000 opciones (`import-products.ts:284–287`, Edge schemas227–232, migración018:43–61) |Máximos por lote sujetos también a bytes; no catálogo total |
| Solicitud |2 MiB UTF-8 Edge (`import-products/index.ts:7,55–58`);2 MiB pg_column_size SQL(018:43–44) |Representaciones diferentes; archivo XLSX comprimido válido puede exceder JSON o JSONB |
| ZIP |100 MiB comprimidos/250 MiB extraídos acumulados/15 MiB por original (`ImportProductsPage.tsx:144–180`) |Se valida antes de confirmar metadata; nombres seguros y sólo referenciadas |
| Imagen procesada |Máximo lado1.200 px,objetivo300 KiB,máximo1 MiB (`processImage.ts:1–5,35–69`) |300 KiB es objetivo, no garantía; JPEG/PNG/WebP→WebP, SVG excluido |

Modos: `create_only` informa conflictos antes de escribir; `create_or_update` reconcilia por código y tiene el problema C02; `skip_existing` deja intacto el grafo e imagen de códigos existentes e importa los nuevos. Metadata es **todo o nada por lote**; no confirma filas buenas de un lote inválido. Imágenes se suben después y pueden fallar individualmente: reporte CSV sanitizado/reintento disponibles, con limitaciones C06/C07. Repetir metadata puede sobreescribir cambios posteriores; no es equivalente a un registro idempotente de importación. No existe stock real que el importador pueda sobrescribir hoy: su futura carga debe ser separada.

Código de producto único case-insensitive por comercio sin baja lógica; una baja libera el código, por lo que historia/stock deben usar UUID. Los códigos de grupo son únicos por lote en parser/Edge aunque SQL los identifica por producto: usar códigos específicos por producto al importar. No hay gestión masiva de reglas de cantidad: cambiar precio base por CSV conserva reglas previas y exige revisión comercial(C09).

Storage es público: una imagen sigue accesible por URL aunque se desactive el producto. El menú proyecta alias/titular/instrucciones de pago y motivo de horario especial intencionalmente; no son campos para notas internas. Pedidos/perfiles/auditoría no aparecen en la RPC pública.

Flujo real: admin/importación confirma metadata transaccional e imágenes aparte → catálogo JSON completo/búsqueda por nombre, descripción y código/anclas categorías → carrito local con opciones/promos → Edge valida/limita → SQL revalida precios, horario, pagos/envío/mínimos y guarda snapshots → respuesta canónica/URL WhatsApp → abrir registra intento, **no envío** → tomar exige sesión y botón → accepted → completed sin stock. GET no toma pedido. Cancelar/expirar preservan historia; snapshots no cambian al editar/desactivar producto. Registrar medio de pago no confirma cobro.

## 4. Hallazgos detallados

C: catálogo/importación; O: pedidos; S: seguridad; G: transversal. Las validaciones propuestas no se presentan como ejecutadas. Los tamaños exploratorios de estas fichas se conservan como referencia técnica: el plan revisado define cuáles corresponden al piloto y cuáles quedan para crecimiento. No se exige validar 5.000 productos ni optimizar escalas mayores para cerrar un piloto cuyo alcance real sea menor.

Referencias abreviadas de migraciones: 003=`202609280003_catalog.sql`;005=`202609280005_orders_audit_private.sql`;007=`202609280007_public_read_rpcs.sql`;008=`202609280008_order_admin_rpcs.sql`;009=`202609280009_order_creation_rpcs.sql`;010=`202609280010_tenant_import_rpcs.sql`;014=`202609280014_reporting_rpc.sql`;015=`202609280015_member_management_and_admin_hardening.sql`;018=`202609280018_transactional_admin_writes.sql`;20261001=`202610010001_product_quantity_pricing.sql`. Todas en `supabase/migrations`. Nombres TSX abreviados se encuentran en `src/features` del módulo indicado; helpers Edge en `supabase/functions/_shared`. Líneas referidas al commit auditado.

### C01 — P1 — Administración puede truncar y ocultar productos a partir del límite de filas

**Tipo:** defecto comprobado de consulta; umbral productivo pendiente. **Evidencia:** `src/features/catalog/ProductsPage.tsx`, queryFn línea 18 hace `select(...).eq(restaurant_id).is(deleted_at,null).order(sort_order)` sin `range`, `limit`, `count` ni paginación; línea 20 filtra solo lo recibido. `supabase/config.toml:8` fija `max_rows=1000` local. Editor también lee opciones/categorías sin paginar (`ProductEditorPage:115-128,161-175`). **Condición:** cantidad de filas supera el máximo efectivo de API (1.001 productos en configuración local). **Impacto:** un código existente puede figurar como inexistente en búsqueda/admin; importador admite seguir creando sin que todos se gestionen. 500 o 501 no disparan este defecto con límite 1.000. **Solución mínima:** paginación server-side con orden determinista `sort_order,id`, búsqueda por código/nombre y filtros server-side, contador/indicador de más páginas; nunca aumentar `max_rows` como sustituto de una consulta completa. Revisar otros select de catálogo. **Esfuerzo:** M (2–4 jornadas con pruebas). **Validación:** fixtures aislados de 999/1.000/1.001/1.500/5.000, encontrar primer/último SKU y navegación sin duplicar/omitir, filtros con empates de orden; verificar ajuste API desplegado. No ejecutado contra DB.

### C02 — P1 — Actualizar precios por CSV puede reactivar agotados y borrar metadata

**Tipo:** defecto comprobado y reproducción local del payload. **Evidencia:** parser `src/lib/import-products.ts:147-159,198-211` convierte campos ausentes en descripción vacía, promoción/fechas null, `active=true`, `available=true`, `featured=false`, orden 0. El modo por defecto es `create_or_update` (`ImportProductsPage:53`) y RPC final `...018:103-117` escribe todos esos campos. Preview muestra solo primeras 20 filas y no la diferencia contra existente (`ImportProductsPage:298`). **Condición:** operador usa columnas obligatorias para actualizar precios de productos existentes, o reimporta una planilla vieja tras cambios manuales. **Impacto:** republica ocultos/agotados, elimina promoción/descripción y orden sin aviso. No hay stock real que pueda sobrescribirse hoy, pero este patrón no debe extenderse a inventario. **Solución mínima:** modo explícito «solo precios»/patch por campos presentes; distinguir ausente, vacío intencional y valor; previsualización de cambios y conteo de afectados. Existencias deben quedar fuera de importación general de metadata. **Esfuerzo:** M (2–4 jornadas). **Validación:** producto existente oculto/agotado/con promo, importar precio y verificar preservación; limpiar intencionalmente solo con acción explícita; reimportar mismo archivo y verificar resultado. Parser reproducido sin DB; efecto SQL confirmado por código.

### C03 — P2 — El catálogo abierto puede conservar precios/disponibilidad sin actualizar indefinidamente

**Tipo:** defecto de sincronización comprobado; efecto comercial depende del flujo. **Evidencia:** `usePublicMenu.ts:6-12` solo staleTime=60 s; `main.tsx:12` desactiva refetch al enfocar; no polling/realtime de catálogo. Invalidaciones de editor/import/admin (`ProductEditorPage:467`, `ProductsPage:29-31`, `ImportProductsPage:239-244`) afectan el QueryClient de ese navegador. **Condición:** cliente deja menú abierto mientras otro equipo cambia precio/agotado o pasa una hora de apertura/promoción. **Impacto:** datos mostrados y carrito pueden envejecer hasta remount/reconexión/refetch; staleTime no es un refresco cada minuto. Backend vuelve a validar al crear pedido, por lo que no equivale a aceptar precios manipulados. **Solución mínima:** revisar versión/refrescar al volver a foco o antes de confirmar, mostrar diferencias y pedir revisión del total actualizado; actualización visible acotada de disponibilidad sin realtime por SKU. Invalidation también al archivar (`ProductEditorPage:484-492` hoy no invalida). **Esfuerzo:** M (2–3 jornadas). **Validación:** dos navegadores, cambio de precio/activo/agotado, promoción que vence y vuelta a foco; observar precio confirmado y rechazo claro de producto no disponible.

### C04 — P2 — Render completo y fotos eager del admin multiplican costo de catálogos grandes

**Tipo:** comportamiento comprobado; magnitud de backend/producción pendiente; frontend local medido en sección 6. **Evidencia:** menú `PublicMenuPage:147-189` monta todos los productos; búsqueda 35-41 recorre todos por pulsación y el map vuelve a ejecutar formateo/promos; `effectiveQuantityPrices` (`quantity-pricing:117-127`) ejecuta DP por regla. Admin map completo `ProductsPage:51-80`, imágenes sin lazy 57. RPC final reconstruye JSON por concatenación `...202610010001:237-251`. **Condición:** 500–5.000 productos, muchas promos por cantidad, celulares, fotos. **Impacto:** DOM/memoria/CPU y descarga evitables; admin puede pedir hasta todas sus imágenes visibles en datos aunque estén fuera de pantalla. **Solución mínima:** primero lazy para admin y paginación/filtros C01; acotar render público por categoría/carga incremental conservando búsqueda de todo catálogo (si se pagina DB, búsqueda también server-side). Cachear resultado de promos/formateador y memoizar tarjetas solo donde profiling confirme. Perfilar SQL con EXPLAIN antes de reescribir wrapper a agregación por conjuntos; no introducir virtualización por costumbre. **Esfuerzo:** S lazy, M listado, M SQL si se confirma. **Validación:** escenarios 500/1.500/5.000 con 0/19 reglas, latencia de buscar último SKU, long tasks, DOM, heap, bytes y solicitudes antes/después; móvil lento. No atribuir un mock frontend a rendimiento DB.

### C05 — P2 — Importador acepta un producto imposible de pedir por opciones obligatorias insuficientes

**Tipo:** defecto comprobado de validación; parser reproducido. **Evidencia:** `import-products.ts:223-282` y `_shared/schemas.ts:201-287` validan min/max y referencias pero no número de opciones activas por grupo; SQL final `...018:144-195` tampoco. Editor sí comprueba `minSelect <= activeOptionCount` (`ProductEditorPage:389-395`). `ProductDialog:57-62` impide agregar si faltan selecciones. **Condición:** grupo activo obligatorio min 2/max 2 con 1 opción activa (o ninguna) en importación. **Impacto:** importación «exitosa» publica producto que ningún cliente puede añadir; mismo problema si se desactiva opción requerida desde otro mecanismo. **Solución mínima:** validar grafo final en RPC y reportar grupo/fila antes de commit; aplicar a editor/import/direct writes autorizados y validar suma de mínimos frente a máximo 30 opciones de pedido. **Esfuerzo:** M (1–3 jornadas). **Validación:** grupo insuficiente/inactivo, actualización que desactiva última opción, transacción sin cambios parciales y mensajes accionables. Parser local devuelve errors=[] para el ejemplo; DB no ejecutada.

### C06 — P2 — Compensación de imágenes importadas puede borrar la imagen ya asociada tras resultado incierto

**Tipo:** riesgo razonado apoyado en rama comprobada, sin fallo de red reproducido. **Evidencia:** `ImportProductsPage.tsx:166-170` sube, actualiza `products.image_path` y ante cualquier `updateError` ejecuta cleanupAsset(path). A diferencia del editor (`ProductEditorPage:459-465`), no relee asociación. **Condición:** el update confirma en DB pero se pierde la respuesta/timeout, o otro operador cambia imagen mientras se ejecuta limpieza de rutas viejas (172-175). **Impacto:** referencia de producto a archivo borrado; compensación insegura en frontera PostgreSQL/Storage. **Solución mínima:** ante error ambiguo releer producto y retener asset si asociación es vigente o no se puede comprobar; compare-and-set de imagen/version, limpieza posterior solo de rutas no referenciadas. **Esfuerzo:** S–M (1–2 jornadas). **Validación:** mock que confirma update y devuelve timeout; comprobar que no elimina ruta referenciada, reintento y dos operadores; SQL y Storage no se pueden volver atómicos con transacción local.

### C07 — P2 — Tamaños, reintentos y reporte de importación generan trabajo evitable

**Tipo:** varios defectos/limitaciones UX comprobados. **Evidencia:** ausencia de preflight JSON byte-size en `runImport` 188-210 frente 2 MiB Edge; `retryImages` 254-260 reejecuta todas las imágenes 123-144, exitosas incluidas, con UUID nuevo y limpieza; botón reintento solo aparece si `imageErrors.length` (302) pese advertencia que se pueden cargar después (298); parser `rowsToRecords:109-112` elimina filas vacías y después enumera `index+2` (142-143), así que reporta número desplazado. **Condición:** lote grande en opciones/texto, fallo parcial imagen, importar sin ZIP y luego adjuntarlo, o filas vacías previas al error. **Impacto:** rechazos tardíos, subir de nuevo cientos de imágenes, reporte que apunta a otra fila; sin ZIP inicial hay que repetir metadata para disparar subida desde UI. **Solución mínima:** medir JSON UTF-8 antes de envío y dividir a lotes controlados; conservar fila/hoja original; mantener resultados por imagen y reintentar solo pendientes; botón «cargar imágenes pendientes» independiente. **Esfuerzo:** M (2–4 jornadas). **Validación:** 2 MiB−1/+1, 500 productos con grupos/opciones, 1 imagen fallida de 500 sin repetir 499, ausencia ZIP, fila vacía y error. Metadata sigue all-or-nothing por lote: no prometer continuación de filas fallidas dentro de una misma transacción.

### C08 — P2 — Guardados de catálogo concurrentes pueden sobrescribir cambios de otro operador

**Tipo:** riesgo razonado por falta comprobada de precondición de versión. **Evidencia:** editor carga snapshot (`ProductEditorPage:130-177,206-246`) y manda objeto completo (`421-458`); RPC `...018:394-410` actualiza todos los campos por ID sin `updated_at/version` esperado, wrapper de reglas `...202610010001:342-370` sincroniza reglas de snapshot. Import upsert mismo patrón 103-117. **Condición:** A abre ficha, B cambia precio/agotado, A guarda otro campo más tarde. **Impacto:** última escritura repone valores viejos y puede reactivar producto. Una transacción hace atómico cada guardado, no impide esta actualización perdida. **Solución mínima:** versión de producto y compare-and-set en RPC con conflicto recuperable; al importar precios informar cambios desde revisión previa. **Esfuerzo:** M (2–3 jornadas). **Validación:** dos sesiones y versiones cruzadas; segunda rechazada con comparación de diferencias, sin perder ninguna actualización.

### C09 — P2 — Operación de precios y cantidades exige demasiadas acciones para mayorista

**Tipo:** limitación funcional comprobada; prioridad condicionada a catálogo real. **Evidencia:** administración de tarjetas sin selección masiva/filtros (`ProductsPage:36-81`), precio editado por ficha; modal público solo +/− y máximo 20 por agregado (`ProductDialog:157-159`). Promociones por cantidad editables individualmente (`ProductEditorPage:295-310,379-388`); `ImportProduct` no tiene quantityPrices (`import-products.ts:3-17`) ni Edge schema (`171-199`) y RPC import no las toca. **Condición:** actualizar cientos de precios, dar de baja grupos de productos, pedir cajas/bultos o >20 unidades. **Impacto:** error manual y operación lenta; CSV de precios base conserva reglas de cantidad antiguas, que pueden seguir descontando mucho más de lo esperado tras aumento. **Solución mínima:** lista compacta con filtro/código, cantidad numérica directa con límites claros, acciones masivas de precio/activo/disponible con preview; opción explícita para mantener/actualizar/suspender promos por cantidad en cambios masivos. No modelar caja/bulto hasta definir conversión/SKU. **Esfuerzo:** M–L (3–6 jornadas según alcance). **Validación:** tareas reales con 500+, límite 25 líneas y total 100 visible antes de checkout; 100 cambios de precio preservan campos y revisan promos.

### C10 — P2 — Precio de texto con miles anglosajones se acepta con valor erróneo

**Tipo:** defecto defensivo comprobado con formato fuera del contrato documentado. **Evidencia:** `import-products.ts:55-66` si encuentra coma elimina puntos y la cambia por punto. Prueba local: `'1,234.56' → 123 centavos`, `'1.234,56' → 123456`, `'1234.56' → 123456`, `'1.234' → 123`. `docs/operations.md:81` pide números sin separador de miles; la UI no rechaza el formato ambiguo. **Condición:** CSV de proveedor exportado con miles/locale distinto o texto de precio ambiguo. **Impacto:** publicación con precio erróneo sin error de validación; servidor recibe un entero válido y no puede inferir intención. **Solución mínima:** formato estricto anunciado, rechazo de agrupaciones ambiguas, ejemplos y preview de normalización; preferir celdas numéricas XLSX y códigos como texto para conservar ceros iniciales. **Esfuerzo:** S (0,5–1 jornada). **Validación:** formatos locales admitidos, anglosajón rechazado o importación con locale explícito; precios muy grandes, decimales y sin separadores. No afirmar que el formato rechazable estaba prometido por la documentación.

### C11 — P1 — Un grupo con máximo cero puede romper la lectura del catálogo entero

**Tipo:** incompatibilidad comprobada entre validación de escritura y lectura; contrato de lectura reproducido localmente. **Evidencia:** `ProductEditorPage.tsx:391` acepta grupo no obligatorio con minSelect=0/maxSelect=0 (no verifica máximo mínimo 1). El input tiene `min=1` (693), pero guardar es un botón de un `div`, no submit de un form con validación HTML (507,783), y el valor escrito es `Number(event.target.value)` (698). RPC base `...018:469-487` lo guarda y constraint final `...015:4-8` admite 0–20. `src/lib/validation/schemas.ts:47` exige maxSelect positivo; `public-menu/api.ts:15-18` rechaza el **documento completo** si falla un grupo. **Condición:** administrador vacía el campo Máximo o escribe 0 en un grupo opcional activo de producto publicado. **Impacto:** todo el comercio muestra «configuración inválida», no solo ese producto. **Solución mínima:** alinear máximo 1–20 en editor/RPC/constraint, permitir «grupo inactivo» como mecanismo explícito en vez de máximo cero; revisar filas existentes antes de nueva constraint. **Esfuerzo:** S (0,5–1 jornada más validación de datos). **Validación:** guardar grupo min0/max0 falla sin mutaciones, grupo inactivo y máximo1 funcionan; prueba integrada valida documento de menú completo; no ejecutar corrección de datos en esta auditoría.

### O01 — P1 — No existe inventario ni descuento por entrega (hecho)

- **Evidencia:** `supabase/migrations/202609280003_catalog.sql:29–58`, especialmente `available` en 42; `supabase/migrations/202609280008_order_admin_rpcs.sql:199–235`; `src/features/orders/OrderDetailPage.tsx:136–144`. No hay saldos, ingresos, movimientos, reservas ni RPC de inventario en migraciones.
- **Condición:** se ofrece control de stock o se marca un pedido como Completado.
- **Impacto:** no satisface el requisito confirmado; la disponibilidad es una bandera manual y nunca decrece por vender. `completed` significa operación finalizada, no existe una semántica garantizada de entrega física.
- **Solución mínima:** saldos/movimientos, política por comercio, snapshots de unidad y una operación transaccional de entrega descrita en PLAN_MAYORISTA_Y_STOCK.md; convertir el botón a “Confirmar entrega” y su semántica operativa; conservar estados existentes si `completed` se define formalmente como entregado.
- **Esfuerzo:** L describía el núcleo transaccional aislado, no el MVP ni el lanzamiento completo. Modelo, permisos, UI, corte, reportes, correcciones, validación e implementación integral se desglosan y estiman en el plan; reestimar tras acordar unidades/devoluciones.
- **Validación:** criterios AC01–AC15 del plan. No presentar `available` como stock real.

### O02 — P1 si los pedidos reales exceden los topes — Límites rígidos de pedido y captura de cantidades (hecho)

- **Evidencia:** `CheckoutPage.tsx:126`, `CartPage.tsx:35–36`, `supabase/functions/_shared/schemas.ts:100–107,145–163`, SQL vigente `202610010001:575–598`; `ProductDialog.tsx:157–159`; `CartProvider.tsx:14,210–215`; `src/lib/quantity-pricing.ts:41–43`.
- **Condición:** 26 configuraciones diferentes o suma de cantidades >100. El modal sólo permite agregar hasta 20 de una vez; luego el carrito permite llegar a 100 por línea, a fuerza de pulsaciones.
- **Impacto:** un catálogo de 500+ productos puede existir, pero una compra mayorista de 30 productos o 10×12 unidades no pasa. Son límites defensivos codificados, no cuotas de Supabase ni capacidad total del catálogo, y no hay configuración por comercio.
- **Detalle:** UI y Edge limitan **25 renglones enviados**; SQL acepta 1–50 renglones antes de canonicalizar. **100 unidades es la suma de todo el pedido**, además del máximo por renglón. Ofertas admiten cantidades 2–20 y pueden reutilizarse para completar 100; esto no implica “sólo 20 unidades vendibles”.
- **Solución mínima:** acordar máximo comercial de SKU/renglones/unidades, exponer límites del comercio desde una sola política con techo global técnico, unificar Edge/SQL/TS, campo de cantidad numérico validado y mensajes anticipados. Ampliar implica revisar DP y tamaño del mensaje WhatsApp, no sólo cambiar un número. Para pedidos extensos priorizar resumen+enlace seguro manteniendo el detalle canónico en DB; probar clientes WhatsApp reales sin clientes reales.
- **Esfuerzo:** M para unificación/UI/pruebas; aumenta si hacen falta unidades fraccionadas.
- **Validación:** 25/26 líneas, 100/101 unidades, límite nuevo±1, mismo producto con notas/opciones distintas, suma global, fracción/negativo/overflow, payload grande y WhatsApp largo.

### O03 — P1 — Reintento con datos de entrega/pago cambiados devuelve silenciosamente el pedido anterior (hecho de código; reproducción end-to-end pendiente)

- **Evidencia:** `src/lib/checkout-attempt.ts:27–35,38–69` fingerprint sólo de líneas; `CheckoutPage.tsx:135–155` misma key si no cambia carrito; SQL `202610010001:486–508,861–881` devuelve pedido de la misma key antes de comparar contenido. `IDEMPOTENCY_CONFLICT` existe en `_shared/errors.ts` pero este RPC no lo genera.
- **Condición:** primer POST se confirma pero la respuesta se pierde; cliente modifica domicilio, teléfono, pago o notas generales y reintenta el mismo carrito durante la misma sesión/TTL de 2 horas.
- **Impacto:** UI acepta un replay con datos anteriores; puede entregarse al domicilio previo o aplicarse otro medio de pago. Crear automáticamente una nueva key al editar sin resolver el primer intento también podría duplicar pedidos: no es solución suficiente.
- **Horizonte adicional:** la protección DB por key no vence, pero `ATTEMPT_TTL_MS` es 2 horas (`checkout-attempt.ts:3,47–60`). Tras recargar más tarde se genera otra key, y un pedido cuyo primer resultado fue ambiguo puede duplicarse aunque el browser mantenga el mismo carrito. En otra pestaña no existe necesariamente el mismo sessionStorage. No prometer idempotencia ilimitada entre sesiones; conservar recuperación del intento y una acción explícita de nuevo pedido.
- **Solución mínima:** persistir hash canónico de la solicitud completa salvo datos volátiles/antispam; una key con hash distinto responde conflicto explícito. Tras resultado ambiguo, recuperar/resolver el intento original antes de permitir reemplazarlo; si quedó creado, editar por un flujo autorizado o cancelar y crear uno nuevo. Mismo payload+key continúa siendo replay seguro.
- **Esfuerzo:** M.
- **Validación:** timeout después de commit + mismo payload produce un pedido; timeout + dirección/pago distintos produce conflicto y ningún pedido adicional; retry concurrente; recarga; storage deshabilitado; recuperar intento expirado sin duplicación.

### O04 — P2 — La revalidación del carrito no identifica líneas que ya no pueden comprarse (hecho)

- **Evidencia:** `CartProvider.tsx:140–156` conserva producto ausente y opción inexistente; `CartPage.tsx:35–36` muestra líneas sin estado de validez; `CheckoutPage.tsx:118–127,179–185` no preconfirma cambio de total.
- **Condición:** se desactiva/elimina lógicamente producto, opción o grupo entre agregar y checkout; cambia precio durante el flujo.
- **Impacto:** DB rechaza correctamente el pedido (no hay manipulación de precio), pero el cliente vuelve a un carrito que no identifica qué corregir. Un precio nuevo puede persistirse tras ver otra estimación sin un paso de aceptación de la diferencia.
- **Solución mínima:** marcar línea inválida con motivo y ofrecer quitar/reconfigurar; comparar resumen cotizado con resumen confirmado y presentar cambios claramente antes de enviar WhatsApp. No borrar silenciosamente notas ni sustituir variantes.
- **Esfuerzo:** M.
- **Validación:** desactivar producto/opción seleccionada, cambiar min/max del grupo, subir precio/terminar promo mientras checkout está abierto; verificar rechazo atómico y explicación precisa.

### O05 — P2 — CSV de historial no tiene un recorrido estable bajo crecimiento concurrente (hecho del algoritmo, impacto a validar con datos)

- **Evidencia:** `OrdersPage.tsx:128–147` lotes OFFSET de 1000 ordenados sólo por `created_at`, parada por longitud del lote; `OrdersPage.tsx:75–84` listado usa exact count e ILIKE `%texto%` sin debounce; índices `005:65–70` no cubren búsquedas substring.
- **Condición:** nuevas filas dentro del rango durante exportación, empates de timestamp, gran historial/rango o configuración remota `max_rows` menor a 1000 (esta última no comprobada). Cambios de estado de pedidos mientras la exportación filtra por estado también mueven filas entre páginas.
- **Impacto:** OFFSET puede duplicar/omitir filas; si servidor devuelve menos de 1000 por límite, exportación termina como si estuviera completa. Muchos resultados se guardan todos en memoria. La lentitud de substring/count es riesgo razonado, no benchmark ejecutado.
- **Solución mínima:** cursor estable `(created_at,id)`, corte de creación fijo al iniciar, columnas mínimas, detectar truncamiento configurado y hacer visible el alcance. Si se exige consistencia exacta de estados durante exportación, usar un RPC con snapshot explícito acotado o documentar semántica; un corte temporal por sí solo no congela cambios de estado. Debounce de búsqueda; evaluar índice sólo con EXPLAIN/datos reales.
- **Esfuerzo:** M; S para debounce/proyección.
- **Validación:** >2.000 pedidos sintéticos, timestamps iguales, inserción y transición entre lotes; comprobar IDs únicos y completitud; entorno con max_rows 500; medir memoria/transferencia y EXPLAIN con 100 k pedidos distribuidos entre comercios.

### O06 — P2 — “Completado hoy” no representa entregas de hoy (hecho; impacto mayorista)

- **Evidencia:** `202609280014_reporting_rpc.sql:21–62` todos los agregados recortan `created_at`, aunque `completedAmountCents` filtre status; `AdminDashboardPage.tsx:47–50,108–125` título Hoy e Importe completado.
- **Condición:** pedido creado ayer y entregado hoy, frecuente en operaciones mayoristas; dashboard abierto durante cambio de día (`now` se captura sólo al montar).
- **Impacto:** ese importe no aparece hoy como entrega, y aparecerá en la cohorte de ayer. No es contabilidad de cobros: ni `accepted` ni `completed` prueban pago. `byPaymentMethod` incluye todos los estados; no usarlo como venta confirmada.
- **Solución mínima:** distinguir métricas por fecha de creación y por fecha de entrega (`completed_at`); etiquetar exactamente la cohorte/estado, recalcular rango al cambiar día, medir índice tenant+completed_at si es necesario. Para stock, derivar salidas de movimientos con su fecha efectiva.
- **Esfuerzo:** S–M.
- **Validación:** pedido creado antes de medianoche, entregado después; cancelado luego de tomar; ambas zonas horarias; abierta durante medianoche; comparar contra movimientos.

### O07 — P3 condicionada al negocio — Promos exactas por configuración no equivalen a política mayorista (hecho funcional)

- **Evidencia:** `202610010001:3–18,631–647,720–729`; `quantity-pricing.ts:29–104,137–143`; tests `quantity-pricing.test.ts:169–207` y SQL `010_product_quantity_pricing.sql:389–442` confirman scopes separados.
- **Condición:** se espera “precio por 12 a partir de 12” o sumar variantes/notas del mismo SKU para alcanzar un tramo. Hoy 12 unidades se descomponen en ofertas reutilizables; 6+6 con notas distintas se precian por separado.
- **Impacto:** la política comercial puede diferir aunque el algoritmo actual sea consistente entre TS/SQL. No hay evidencia de un requisito de listas por cliente, así que no son módulos obligatorios.
- **Solución mínima:** confirmar semántica comercial; conservar algoritmo actual si coincide; si se necesita precio umbral o agrupación por SKU, definir una regla explícita y snapshots sin alterar histórico.
- **Esfuerzo:** S de definición; M de cambio sólo si se confirma.
- **Validación:** casos 11/12/13, cajas y unidades si se venden ambas, notas diferentes, varias opciones, promociones temporales vs ofertas por cantidad.

### O08 — P2 — Recargar la confirmación antes de enviar WhatsApp pierde el acceso al mensaje (hecho; decisión explícita de privacidad)

- **Evidencia:** `OrderGeneratedPage.tsx:17–37` mantiene respuesta sólo en estado local, borra `location.state`; efecto 25–29 vacía carrito; `CheckoutPage.tsx:181` elimina intento. El propio mensaje de error confirma que la pantalla no se recupera tras reload.
- **Condición:** recarga/cierre de pestaña tras generar pero antes de enviar.
- **Impacto:** pedido existe y puede no llegar al WhatsApp del comercio; cliente no puede reconstruirlo con el carrito ya vacío. Puede crear de nuevo para intentar resolver, con otra key.
- **Solución mínima:** ofrecer recuperación temporal del resultado mediante token opaco de sólo lectura/alcance mínimo, guardar sólo referencia efímera (sin PII) y conservar un intento resuelto recuperable hasta confirmar recepción o vencer. No habilitar lectura anónima por `actionId`.
- **Esfuerzo:** M; priorizar con O03 para un único flujo de recuperación.
- **Validación:** reload, cerrar/abrir, navegación atrás, token vencido/de otro pedido, permisos mínimos y no exposición del detalle mediante UUID público.

### O09 — P2 — El mantenimiento aplica dos veces la ventana de vencimiento (hecho, configuración cron remota pendiente)

- **Evidencia:** `supabase/functions/expire-orders/index.ts:21–27` calcula `before = now - olderThanMinutes`; `supabase/functions/_shared/schemas.ts:289–291` default 120 minutos; `supabase/migrations/202609280008_order_admin_rpcs.sql:312–318` compara `expires_at <= p_before`; `202610010001_product_quantity_pricing.sql:806` ya guarda `expires_at = now + 2 hours`.
- **Condición:** invocar Edge de mantenimiento con defaults (cron remoto no comprobado en este subanálisis).
- **Impacto:** pedido creado a las 10:00 vence para claim a las 12:00, pero mantenimiento lo marca expired recién aproximadamente a las 14:00. Dashboard mantiene generated/whatsapp_opened no tomables durante dos horas extra. No permite tomarlos vencidos: `claim_order` verifica su propio expires_at.
- **Solución mínima:** comparar vencimiento con hora actual y usar la ventana sólo al asignar expires_at, o renombrar parámetro como gracia posterior al vencimiento si esa fuese la regla real. Definir un único significado.
- **Esfuerzo:** S.
- **Validación:** reloj fijo, creado 10:00/expires12:00; mantenimiento antes, en y después de las12:00; claim y scheduler deben coincidir; configurar scheduler actual sólo tras revisión operativa autorizada.

### S01 — P1 — Invitación puede degradar administradores existentes y dejar un tenant sin admin

- **Problema:** el permiso para invitar un `order_manager` se aplica al rol solicitado, pero el upsert sobre un miembro existente sobrescribe su rol sin comprobar el rol anterior. La protección del último administrador existe solamente en la otra RPC de cambio de status.
- **Evidencia:** `supabase/functions/invite-restaurant-user/index.ts:25–48`; `_shared/invitations.ts:68–70` devuelve el usuario existente; `supabase/migrations/202609280010_tenant_import_rpcs.sql:203–223` valida p_role pero ejecuta `ON CONFLICT ... SET role=excluded.role,status=excluded.status`. `202609280015_member_management_and_admin_hardening.sql:65–128` protege administradores solo en `set_restaurant_member_status`. Ninguna migración posterior reemplaza `upsert_restaurant_membership`. Se verificó que la definición remota conserva esta omisión; el handler desplegado no fue comparado.
- **Condición:** un admin activo envía una invitación como manager usando el email de otro admin del mismo tenant, o su propio email. No exige acceso a otro tenant ni conocimiento de un secreto.
- **Impacto:** el admin puede degradar al otro admin y luego suspenderlo mediante la RPC permitida; el único admin puede degradarse a sí mismo y dejar el tenant sin administración local. Incumple el límite documentado de gestionar solo managers y exige rescate del Super Admin.
- **Solución mínima:** bloquear membresías del tenant con orden determinista, releer actor y objetivo, impedir que un admin de tenant altere un objetivo cuyo rol anterior sea admin y conservar al menos un admin activo para cualquier degradación/suspensión autorizada. Definir invitación repetida del mismo rol como no-op; evitar usar la invitación como editor implícito de roles.
- **Esfuerzo:** M, aproximadamente 1–2 días de desarrollo y prueba, sin servicio adicional.
- **Validación propuesta:** pgTAP de admin A intentando reinvitar admin B y a sí mismo como manager; último admin protegido para Super Admin y solicitudes concurrentes; invitación de nuevo manager, repetición y reactivación permitida siguen operativas. E2E aislado del handler autenticado. No se ejecutó una degradación remota.

### S02 — P2 — Registro público de WhatsApp carece de límite de intentos

- **Problema:** cada payload sintácticamente válido llega a una RPC con capacidad administrativa; no hay rate limit por IP/acción. La RPC bloquea la fila del pedido antes de autenticar el token.
- **Evidencia:** `supabase/functions/register-whatsapp-opened/index.ts:15–29`; `supabase/migrations/202609280009_order_creation_rpcs.sql:609–618`. `create-order` sí implementa rate limit explícito, esta función no lo reutiliza.
- **Condición:** muchas llamadas con UUID/token bien formados, incluso token incorrecto; conocer un actionId añade contención de la fila. CORS no autentica llamadas realizadas fuera de un navegador.
- **Impacto:** consumo de Edge/DB y potencial contención de la operación. No permite leer ni aceptar pedidos y no se demostró DoS remoto.
- **Solución mínima:** límite acotado específico por origen de red/acción antes del trabajo sensible; validar asociación/token antes de tomar un bloqueo cuando sea posible, manteniendo la transición idempotente; error genérico constante. Reutilizar PostgreSQL y capacidades del proveedor actual, sin nueva infraestructura.
- **Esfuerzo:** S/M, 0,5–1,5 días.
- **Validación propuesta:** solicitudes inválidas quedan acotadas y responden 429; evento válido y replay no duplican evento; comprobar que pedidos ajenos no son legibles. Pruebas de concurrencia solo aisladas.

### S03 — P1 — Validación de colecciones públicas amplifica trabajo antes del control antiabuso

- **Problema:** Zod 3.25.76 recorre una colección sobredimensionada y crea errores por elemento aun cuando `.max(25)` ya la invalida. El slice de errores a 20 limita la respuesta, no el costo de construirlos. La validación ocurre antes de Turnstile y rate limit.
- **Evidencia:** `_shared/deps.ts:8` fija Zod 3.25.76; `_shared/schemas.ts:155,294–297`; `_shared/http.ts:68`; `create-order/index.ts:21–41`.
- **Medición local:** Deno 2.9.6, Windows x64, V8 15.0.245.2; una llamada real a `createOrderSchema.safeParse` con 5.000 elementos null produjo 5.001 issues en 10,5 ms; JSON de 25.314 bytes, inferior a los 192 KiB admitidos. Fue una única muestra acotada y sin red; no mide límite de concurrencia ni agotamiento de memoria remoto.
- **Condición:** payload anónimo de tamaño permitido con arrays grandes de valores inválidos. Importación autenticada también usa colecciones y hasta 2 MiB de cuerpo.
- **Impacto:** amplificación de CPU/memoria antes del contador antiabuso. Se comprobó recorrido/errores excesivos, no caída ni explotación remota.
- **Fuente oficial:** el [cambio de Zod #6652](https://github.com/colinhacks/zod/pull/6652) coloca los límites antes del recorrido; el [aviso GHSA-mrhx-c7 xc-m3 w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), consultado 24/10/2026, declara afectadas versiones anteriores a 4.6.6. La actualización ofrecida cambia de versión mayor: evaluar compatibilidad y no ejecutar `audit fix --force` a ciegas.
- **Solución mínima:** prevalidar cardinalidades máximas de arrays antes del parse profundo y cortar respuestas/trabajo; actualizar Zod de frontend/Edge y ambos locks a una versión corregida compatible con los esquemas. Completar S04. No subir límites mayoristas sin preservar estas cotas.
- **Esfuerzo:** M, 1–3 días incluyendo compatibilidad y pruebas.
- **Validación:** el mismo payload excesivo debe abortar en un error acotado antes de iterar sus elementos; payloads de máximos admitidos válidos siguen funcionando; helpers, importación, checkout y errores mantienen contrato; repetir auditoría de dependencias.

### S04 — P2 — El límite de cuerpo se comprueba después de leerlo por completo

- **Problema:** sin `Content-Length` confiable, `readJson` consume `request.arrayBuffer()` completo y solo después verifica byteLength. Los límites de 4 KiB/192 KiB/2 MiB no son cotas de memoria durante lectura.
- **Evidencia:** `supabase/functions/_shared/http.ts:45–53`; todos los handlers públicos usan esta función.
- **Medición local:** stream sintético sin Content-Length, límite 4.096 bytes; se consumieron 1.048.576 bytes completos y luego retornó `PAYLOAD_TOO_LARGE`/413. Una única lectura de 1 MiB, sin servidor/red. El test existente `http_test.ts:5–15` comprueba el rechazo final, no el corte anticipado.
- **Condición:** cuerpo transmitido sin longitud declarada o con declaración menor; gateway no lo corta antes. El límite efectivo externo queda pendiente de comprobar, por lo que no se afirmó memoria ilimitada en producción.
- **Impacto:** memoria/transferencia de trabajo proporcional al cuerpo realmente enviado antes del rechazo.
- **Solución mínima:** leer stream por chunks, sumar bytes y cancelar al superar el límite; timeout acotado y una sola decodificación/parse del cuerpo admitido.
- **Esfuerzo:** S, 0,5–1 día, combinable con S03.
- **Validación:** stream por encima del límite se cancela en límite+un chunk; Content-Length engañoso, UTF-8 inválido y JSON vacío/malformado conservan errores correctos.

### Riesgos adicionales de seguridad y operación

| ID / prioridad | Hecho y condición | Impacto y solución mínima | Esfuerzo / validación |
|---|---|---|---|
| S05 / P2, riesgo | `_shared/request-meta.ts:1–14` prioriza cf-connecting-ip, x-real-ip y primer x-forwarded-for sin validación de IP ni definición del proxy confiable. No se verificó qué headers sobrescribe Supabase | Si sobreviven cabeceras controladas por cliente, se puede evadir dimensión IP; si falta IP, todos comparten `unavailable`. Confirmar contrato del gateway y aceptar solo origen confiable/formato IP; mantener límites teléfono/tenant | S; prueba de cabeceras en staging y lectura de trazas sin PII, no ataque remoto |
| S06 / P2, riesgo comercial | `check_order_rate_limits` fija 10/IP, 5/teléfono, 100/tenant por diez minutos (`202609280009:92–94`), consume también reintentos; Turnstile es opcional y `.env.edge.production` local tiene false | Compartir NAT y ráfagas mayoristas puede bloquear clientes; con Turnstile apagado es fácil falsificar honeypot/fecha. Acordar pico, parametrizar límites por tenant y activar/validar Turnstile si el riesgo lo exige, sin prometer cuotas nuevas | S/M; pruebas sintéticas de carga válidas/rechazadas, NAT compartido y replay en staging. Estado remoto de Turnstile pendiente |
| S07 / P2, operación | `docs/operations.md:134–138` no activa scheduler; expire limpia rate_limits pero no tokens/idempotencia; pg_cron remoto ausente según lectura remota de esta auditoría | Expirados/auxiliares se acumulan si nadie invoca mantenimiento. Configurar mantenimiento dentro de capacidades actuales disponibles, con secreto protegido y alerta de fallo; definir retención antes de borrar | S/M; confirmar scheduler externo existente si lo hay y última ejecución; no asumir que ausencia pg_cron implica ausencia total de scheduler |
| S08 / P2, fiabilidad de onboarding | `create-restaurant/index.ts:33–48` e `invite-restaurant-user/index.ts:33–49` resuelven/envían invitación Auth antes de confirmar la transacción de negocio | Si la DB rechaza por slug/reglas, queda un usuario/invitación sin membresía. No es escalada: acceso falla cerrado. Prevalidar conflictos, registrar estado y permitir reintento/reenvío sin crear tenants duplicados | M; provocar fallo DB con proveedor email simulado y comprobar recuperación/avisos claros; no emails reales |

**S09 — P3 — Costo del fallback de invitaciones.** Revisar el fallback de `_shared/invitations.ts:37–58`: ante email no existente recorre hasta 50 páginas de 1.000 usuarios de Auth antes de invitar. No es una fuga al cliente, pero hace crecer costo/latencia de nuevas invitaciones con el total de usuarios de la plataforma. El directorio profiles ya cubre usuarios creados por trigger; limitar el fallback legado a una operación explícita de reparación evita convertirlo en recorrido rutinario. Mejora P2/P3, S, probar usuario nuevo, existente, legado y carrera de invitación.

### G01 — P1 — Verificación reproducible y dependencias fuera de verde

**Evidencia:** `npm audit --audit-level=high --json` reportó 6 paquetes vulnerables:4 high(Zod,Vite,source-map-js,undici),2 moderate(Vitest,@vitest/mocker),0 critical; `--omit=dev` deja Zod high. Lock fija Vite 8.3.1/Vitest 5.0.2/source-map-js1.2.1, instalado8.3.2/5.0.3/1.2.2. React 19.3.0/TS6.0.3 coinciden. Deno fmt falla2 archivos. `.github/workflows/ci.yml` exige estos checks. **Condición:** construir con lock o dependencias locales divergentes. **Impacto:** pruebas locales no equivalen a npm ci limpio; alertas de herramientas no demuestran explotación del sitio estático, pero Zod es runtime/frontend/Edge(S03). **Solución mínima:** actualización controlada de versiones/locks, mitigación S03, formato y repeat limpio con Node 22/PG alineado. No se aplicó audit fix. **Esfuerzo:** M, compartido con S03. **Validación:** npm ci en entorno limpio, suites/audit completos, evaluar alcance real de avisos sin audit fix --force ni upgrade mayor ciego.

### G02 — P1 de habilitación — Plan comercial y recuperación sin verificar

**Evidencia:** `.vercel/project.json`, `supabase/config.toml`, `docs/deployment.md`, `docs/operations.md` describen servicios/procedimientos, no contrato o restore ejecutado. **Condición:** vender sin verificar cuotas/derechos de uso/backups DB+archivos/RPO-RTO. **Impacto:** no se puede garantizar suscripción suficiente ni recuperación. Si Vercel fuera Hobby, su uso comercial no está permitido ([Hobby](https://vercel.com/docs/plans/hobby), [términos §4](https://vercel.com/legal/terms), consulta24/10/2026); **el plan actual es desconocido**, no se afirma que sea Hobby. **Solución mínima:** confirmar plan/consumo y probar restore con capacidades ya contratadas; si no alcanza, declarar límite y negociar alcance, no suponer upgrade autorizado. **Esfuerzo:** S/M operativo. **Validación:** evidencia plan/métricas/backup, restore DB+objetos y RPO/RTO observado antes de SLA.

### G03 — P2 — Métricas/directorios globales sobre listas sin paginar

**Evidencia:** `SuperAdminDashboardPage.tsx:9` descarga estados de restaurantes/pedidos24 h/membresías y cuenta arrays; `platform-directory.ts:64–69`, query de `RestaurantsPage.tsx` y `RestaurantScope.tsx:52–58` sin rango. `AuditPage.tsx:9` sólo últimos200 eventos, explícitamente. **Condición:** superar max_rows o requerir auditoría vieja. **Impacto:** totales/directorio incompletos con apariencia válida. **Solución mínima:** RPC agregada, paginación estable/búsqueda servidor y filtros fecha/actor/tenant de auditoría. **Esfuerzo:** M. **Validación:**1.001/5.000 filas, totals SQL referencia, último comercio accesible; no elevar indiscriminadamente max_rows.

### G04 — P2/P3 — Componentes densos y reglas duplicadas dificultan cambios seguros

**Evidencia:** `CategoriesPage.tsx:11`, `PaymentMethodsPage.tsx:17–22`, `DeliveryZonesPage.tsx:14–16`, `SuperAdminDashboardPage.tsx:9` concentran consulta/validación/mutación/UI en líneas enormes; límites/esquemas repetidos divergen O02/C11. **Condición:** agregar stock sin aclarar contratos. **Impacto:** revisión difícil y regresiones. **Solución mínima:** formatear/extraer consultas y validaciones al intervenir módulos, contratos de casos SQL/TS probados; no refactorización global previa. **Esfuerzo:** S incremental/M contratos. **Validación:** flujos críticos y equivalencia montos/errores. Assets Vite de ejemplo son limpieza opcional P3 sin impacto comercial demostrado.

### G05 — P3 — Open Graph descarga catálogo para proyectar sólo marca

**Evidencia:** `api/menu-preview.ts:201–217` llama get_public_menu y proyecta restaurante; timeout4 s/cache CDN 300 s en 275–277. **Condición:** crawler/cache miss/catálogo grande. **Impacto:** trabajo/transferencia evitables, posible timeout; cache reduce frecuencia. **Solución mínima:** RPC de metadata pública acotada con control de publicación si perfilado justifica. **Esfuerzo:** S. **Validación:** OG idéntico, ocultación de no publicados, bytes/latencia reducidos. Sin otro proveedor.

## 5. Aspectos que conviene conservar

RLS y FKs compuestas, schema privado/grants explícitos/search_path vacío, recálculo SQL de dinero en centavos, snapshots/baja lógica, idempotencia y claim condicionado, transacciones de metadata/horarios, modos create_only/skip_existing, rasterizado/rutas UUID/caché/lazy de fotos, errores saneados/CORS/MFA, query cache limpia al cambiar principal, filtros por zona horaria, rutas lazy y suites frontend/Edge/SQL. Ampliar estos mecanismos para stock, no reemplazarlos por controles de UI.

## 6. Verificaciones y mediciones

### Entorno y resultado general

Windows x64, AMD Ryzen 7 3700X (16 hilos), 17.126.653.952 bytes RAM (~16 GiB), Node 24.14.1/npm 11.6.1. Build Vite 8.3.2/React 19.3.0/TS 6.0.3 instalados. Deno 2.9.6 existente fuera de PATH, CLI Supabase 2.119.0. No se instaló software. Vercel indica Node 22: repetir con paridad.

| Comando/caso | Resultado | Alcance |
|---|---|---|
| npm run lint / typecheck | PASS/PASS | Frontend/tooling |
| npm run security:check | PASS | Escaneo propio; no historial completo ni pentest |
| npm run test | **98/98**,26 archivos,11,50 s | Unitarias/componentes jsdom |
| npm run build | PASS;999 ms fase bundle reportada por Vite | tsc+assets, no backend |
| npm run test:e2e aislado | **5 passed/4 skipped**,9,0 s | Chromium: landing/login/404,menú/promos/checkout/WhatsApp mock; live deshabilitado |
| deno lint / task check | PASS33 archivos/PASS helpers+6 handlers | Edge |
| deno task test | **31/31**,~1 s tests | Helpers, no integración SQL |
| deno fmt --check | FAIL2/34 | schemas_test.ts:49 formato; schemas.ts finales de línea |
| npm audit --audit-level=high | FAIL4 high/2 moderate | Lock; G01/S03 |
| npm audit --omit=dev | FAIL1 high Zod | Runtime |
| Parser importación | Defaults/opciones/miles/filas/límites reproducidos | Memoria, detalle abajo |
| Payloads públicos Edge | S03:5.000 null→5.001 issues;S04:consume1 MiB antes de rechazar4 KiB | Local acotado, sin red/DoS |
| pgTAP | **No ejecutado** |10 suites/276 aserciones declaradas; falta runtime Docker/Podman local |
| Concurrencia/stock futuro | **No ejecutado** | Criterios en plan, no hay implementación |

Se forzó `E2E_LIVE=0`/`E2E_CREATE_ORDER=0`, configuración pública sintética/base local; Supabase/WhatsApp interceptados. Deno desde supabase/functions con binario existente; sin secretos productivos en ensayos. Consulta de runs GitHub no certificó CI. No se sustituyó la prueba DB por build.

Bundle: entrada307,43 kB(gzip96,49); Supabase214,98(55,32); CSS83,85(13,84); página pública23,67(7,48); importador187,05(57,50). Son tamaños de archivos, no suma transferida por sesión; importador lazy. No justifican cambiar framework.

### Benchmark reproducible

En un checkout sin configuración pública, asignar estas variables **sólo al proceso PowerShell** antes del build. No editar .env ni desplegar este build de prueba:

```powershell
$env:VITE_SUPABASE_URL = 'https://audit-isolated.invalid'
$env:VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuvwxyz123456'
$env:VITE_APP_BASE_URL = 'http://127.0.0.1:4175'
$env:VITE_TURNSTILE_SITE_KEY = ''
npm run build
npm run preview -- --host 127.0.0.1 --port 4175 --strictPort
# En otra terminal, desde la raíz:
node docs/auditoria-mayorista/benchmark-catalogo.mjs
```

Usa Playwright incluido y Chromium instalado; no invoca create-order ni backend real. Guardar una copia del JSON si se quiere comparar: cada ejecución reemplaza benchmark-resultados.json.

[Script](auditoria-mayorista/benchmark-catalogo.mjs) y [resultados por repetición](auditoria-mayorista/benchmark-resultados.json). Ejecutar build, preview127.0.0.1:4175 y script Node; no requiere DB. Toda salida de red externa interceptada/bloqueada. Duración total211,3 s;24/10/2026 20:50:46–20:54:18 hora Buenos Aires; Chromium 153.0.8010.12.

27 corridas:3 repeticiones×3 volúmenes×3 modos; concurrencia **1 navegador/1 comercio**,20 categorías, sin grupos/opciones, historial o escrituras. Desktop1440×900 sin fotos/demora; móvil390×844 CPU4 x, foto sintética WebP600×600 de217.682 bytes/producto. Móvil agrega demora por respuesta80 ms+cuerpo/500.000 B/s: **no es ancho de banda compartido ni simulación fiel de celular/Supabase**. Promos suma19 reglas/producto. Contextos nuevos. Tiempo inicial=navegación→todos los articles+dos frames, no LCP; búsqueda=fill completo del último SKU→un resultado, no tipeo individual.

| Productos | Modo | Inicial mediana ms | Buscar mediana ms | Mayor long task ms | JSON crudo bytes | JSON gzip teórico bytes |
|---:|---|---:|---:|---:|---:|---:|
|500|Desktop|588|54|109|232.468|7.163|
|500|Móvil|2.215|195|580|256.860|8.599|
|500|Móvil+19 promos|3.708|177|917|646.360|11.611|
|1.500|Desktop|804|64|277|691.469|20.581|
|1.500|Móvil|4.166|282|1.156|765.362|25.207|
|1.500|Móvil+19 promos|8.559|302|2.297|1.933.862|33.259|
|5.000|Desktop|1.612|159|814|2.301.469|64.242|
|5.000|Móvil|12.020|722|3.557|2.550.362|80.001|
|5.000|Móvil+19 promos|26.611|823|7.863|6.445.362|104.803|

27/27 completaron, una RPC mock por carga,0 errores JS/solicitudes externas inesperadas; todos los artículos presentes y último SKU encontrado. DOM4.666→50.166 nodos. Móvil solicitó inicialmente19–22 fotos(~4–4,6 MiB de cuerpos), aun con5.000 productos: lazy funciona, DOM sigue completo. Resource Timing de assets locales222.043 bytes/corrida, separado de cuerpos mock. Heap JS observado≈7–21 MiB con GC variable; no es memoria total de navegador/bitmaps.

Demora usa JSON sin gzip; fixtures repetitivos comprimen excepcionalmente bien. JSON crudo/gzip, Resource Timing y bytes mock son medidas distintas; no sumarlas como factura/egress remoto. No hay DB/RLS/Realtime/concurrencia/historial en estas mediciones. Tres muestras no estiman p95 de producción. La lentitud/tareas largas justifican acotar render y cálculos;5.000 es estrés, no promesa comercial. Al paginar conservar búsqueda completa.

### Ensayos focalizados de importación

Entorno medido: Windows (`win32`), Node v24.14.1, `node --import tsx --input-type=module -`, módulos instalados existentes; todo en memoria, sin DB/red y concurrencia 1. Se importó realmente `parseImportSheets` del código local. Una ejecución por volumen, sin warmup controlado; los tiempos describen parser sintético en Node, **no** carga XLSX real, navegador, DB, importación end-to-end ni capacidad de producción.

| Caso | Resultado medido |
|---|---|
| CSV mínimo 1 producto | Sin errores, payload trae defaults destructivos enumerados en C02 |
| Grupo obligatorio min=2 con 1 opción | `errors=[]` (C05) |
| Precio texto `1,234.56` | 123 centavos, sin error (C10) |
| Zod de grupo público con min0/max0 | `success=false`, error `too_small` en `maxSelect` (C11); constraint SQL final admite 0, confirmado por lectura |
| Header + fila vacía + precio inválido | Reporta «Productos fila 2» aunque es fila 3 (C07) |
| 500 productos simples | 500 parseados, sin error, 2,036 ms |
| 501 productos simples | 501 parseados, error límite 500, 1,073 ms |
| 1.500 productos simples | 1.500 parseados, error límite 500, 2,441 ms |
| 5.000 productos simples | 5.000 parseados, error límite 500, 8,504 ms |
| JSON 500 productos (desc 2.000, nombre 160, categoría 100) + 2.500 grupos + 10.000 opciones con campos válidos | **2.590.297 bytes UTF-8**, excede 2.097.152; no enviado. Los máximos individuales no se pueden asumir simultáneamente admisibles |

Reproducción mínima, sin modificaciones: desde raíz ejecutar con Node/tsx instalado `import {parseImportSheets} from './src/lib/import-products.ts'` y pasar `{Productos:[['codigo','nombre','categoria','precio'],['P1','Producto','Categoria','1,234.56']]}`; para defaults cambiar precio por número 200 y examinar salida. Para opciones agregar `GruposOpciones` headers `producto_codigo,grupo_codigo,nombre,obligatorio,minimo,maximo` con `P1,G1,Tamaño,sí,2,2` y `Opciones` headers `grupo_codigo,opcion_codigo,nombre,precio_adicional` con `G1,O1,Única,0`. Para límites generar N filas con códigos únicos. No ejecutar `runImport` ni conectar a Supabase productivo.

Comando reproducible completo de las comprobaciones focalizadas, desde PowerShell en la raíz (solo memoria y lectura del código local):

```powershell
@'
import { parseImportSheets } from './src/lib/import-products.ts';
import { publicMenuSchema } from './src/lib/validation/schemas.ts';
const headers=['codigo','nombre','categoria','precio'];
const product=['P1','Producto','Categoria',200];
console.log('defaults',parseImportSheets({Productos:[headers,product]}));
console.log('insufficient-options',parseImportSheets({
 Productos:[headers,product],
 GruposOpciones:[['producto_codigo','grupo_codigo','nombre','obligatorio','minimo','maximo'],['P1','G1','Tamano','si',2,2]],
 Opciones:[['grupo_codigo','opcion_codigo','nombre','precio_adicional'],['G1','O1','Unica',0]]
}));
for(const value of ['1,234.56','1.234,56','1234.56','1.234'])
 console.log('price',value,parseImportSheets({Productos:[headers,['P1','Producto','Categoria',value]]}));
console.log('row-number',parseImportSheets({Productos:[headers,[],['P1','Producto','Categoria','INVALID']]}));
for(const size of [500,501,1500,5000]) {
 const start=performance.now();
 const result=parseImportSheets({Productos:[headers,...Array.from({length:size},(_,i)=>['P'+i,'Producto '+i,'Categoria',100])]});
 console.log('limit',{size,count:result.products.length,errors:result.errors,ms:performance.now()-start});
}
const group=publicMenuSchema.shape.categories.element.shape.products.element.shape.optionGroups.element;
console.log('max-zero',group.safeParse({id:'10000000-0000-4000-8000-000000000001',name:'Opcional',required:false,minSelect:0,maxSelect:0,sortOrder:0,options:[]}));
'@ | node --import tsx --input-type=module -
```

Tests existentes revisados: `src/tests/import-products.test.ts` cubre centavos, duplicados, columnas, promoción inválida, referencias y categorías; `ImportProductsPage.test.tsx` cubre selección sobredimensionada y ZIP corrupto; no cubren C02/C05/C06/C07 en su totalidad.

### Procedimiento de capacidad pendiente

Reconstruir migraciones/pgTAP en Supabase **local aislado**, PostgreSQL alineado, o staging ya disponible dentro del plan. Nunca reset/carga sobre --linked. **Antes de activar inventario son obligatorias pruebas sobre DB real aislada** de dos sesiones concurrentes, reintento después de commit/timeout, fallos antes de commit, atomicidad de varios productos y permisos por rol/comercio. Los mocks, el build, el benchmark de render y los tests secuenciales no certifican esas garantías. Si falta ese entorno o una prueba crítica falla, no activar stock.

Para el primer mayorista se acuerda y prueba su catálogo completo, historial inicial/proyectado, imágenes, tamaño de pedido y pico de clientes/operadores. El fixture A es un punto de partida: debe ajustarse a su volumen real **superior a 500** si corresponde. Los fixtures B y C se conservan para evaluar crecimiento multicomercio; **no condicionan el primer piloto** mientras no formen parte del alcance acordado. La prueba negativa con un segundo tenant sintético sigue siendo obligatoria para aislamiento aunque se lance un solo mayorista.

| Fixture propuesto | Catálogo/fotos | Historial y comercios | Simultaneidad |
|---|---|---|---|
|A: referencia del piloto, ajustar al mayorista|500/20 categorías/1 foto de 150 KiB media|10.000 pedidos, 1 comercio|5 clientes + 2 operadores|
|B: crecimiento posterior|1.500/40 categorías/1 foto de 150 KiB|100.000 pedidos totales, 10 comercios, 70% en principal|20 clientes + 5 operadores|
|C: estrés posterior|5.000/80 categorías/1 foto de 300 KiB|500.000 pedidos totales, 50 comercios|50 clientes + 10 operadores|

Seleccionar las variantes que representen al piloto y sus límites; no ejecutar todas las combinaciones exploratorias por obligación. Ejemplos: categoría grande, 0/3/19 reglas y 0/2 grupos × 4 opciones. Pedidos de 1/10/25 líneas y 1/50/100 unidades; 26 líneas/101 unidades deben fallar hoy. Mayores límites sólo tras implementación y acuerdo. Propuesta de medición: 2 min de calentamiento + 10 min medidos, 3 repeticiones por caso elegido; llegada controlada sin exceder rate limit salvo caso explícito de abuso. Cache fría/caliente, menú/historial/exportación/pedido/entrega futura. Medir p50/p95/p99, QPS, errores clasificados (incluido 429 legítimo), bytes, CPU/IO/locks/conexiones y reparto por tenant.

EXPLAIN(ANALYZE,BUFFERS) **sólo SELECT aislados**; medir con rol/JWT equivalente para incluir RLS, no extrapolar service_role. Ya hay índices tenant+created_at,tenant+status+created_at y catálogo/grupos/opciones: conservar y perfilar antes de agregar. `%texto%` no queda resuelto por un B-tree ordinario; pg_trgm sólo si evidencia lo justifica. Orden estable con id/keyset para historia profunda. Realtime=eventos×suscriptores+lecturas por invalidación; probar ráfagas/reconexión sin suscripción por SKU.

Umbrales de piloto propuestos, no prometidos: todos los SKU accesibles,0 errores de integridad/aislamiento; búsqueda<200 ms p95 y primera lista usable<3 s en dispositivo/red acordados; RPC lectura/pedido/entrega<1 s p95 al pico objetivo salvo contención controlada. Ninguna medición actual certifica estos objetivos.

### Controles operativos mínimos antes de activar stock

- **Entrega:** confirmar con el negocio qué evento físico habilita el descuento: entrega al cliente, retiro efectivamente realizado u otro hito definido. Abrir WhatsApp, aceptar, preparar y cobrar no se reinterpretan automáticamente como entrega. Reservar al aceptar sigue siendo una decisión pendiente, compatible con descontar existencia física sólo al entregar.
- **Corte de existencias:** contar y registrar en una ventana sin ingresos, entregas, devoluciones ni salidas por otros canales para los SKU afectados. Si no se puede detener la operación, registrar y conciliar todos los movimientos entre el momento del conteo físico y su carga, con frontera por SKU y responsable si se cuentan a distintas horas; cargar después un conteo viejo como saldo actual no es seguro. No duplicar movimientos ya incorporados al saldo. Resolver también los pedidos pendientes, sin descontar históricos ni inventar existencias.
- **Contingencia:** pausar en servidor las operaciones de inventario afectadas y bloquear nuevos pedidos que dependan de esa operación mientras no pueda garantizarse consistencia. Conservar saldos, movimientos, idempotencia, snapshots y protecciones de los pedidos ya creados. Nunca desactivar stock ni volver a una RPC anterior para permitir entregas sin débito. Las operaciones pendientes se resuelven con trazabilidad y conciliación antes de reanudar.
- **Correcciones y reportes:** una entrega corregida o devuelta conserva su registro original y compensación vinculada. UI, filtros, exportaciones y métricas deben distinguir entregas vigentes, corregidas y devueltas. Un pedido reemplazante queda vinculado: original corregido y reemplazo no cuentan como dos entregas comerciales vigentes. Si hubo una devolución física y otra expedición real, ambas salidas sí aparecen en el bruto físico y se calcula el neto con el retorno; no borrar movimientos por compartir raíz. Probar estados, fechas y cantidades sin multiplicación por joins. Recibir mercadería no vendible no repone stock vendible ni confirma reembolso. El plan define estas diferencias.
- **Otras ventas y sistema principal:** si existe otro sistema, definir cuál mantiene la existencia principal y cómo se registran diferencias y ventas externas. No asumir sincronización ni dos saldos igualmente autoritativos. En el escenario manual, asignar responsable y frecuencia de registro/conciliación; si no se pueden garantizar, limitar la promesa de actualización del stock.

Estos controles y los criterios de aceptación de DB del [plan](PLAN_MAYORISTA_Y_STOCK.md) forman parte del lanzamiento mínimo; no requieren ejecutar escenarios multicomercio de gran escala.

## 7. Costos y mantenimiento

No se obtuvo plan, cuota remanente, compute, factura o uso actual. No se citan precios ni se autoriza aumento. Viabilidad **arquitectónica** favorable; suficiencia **económica/contractual** pendiente G02. Conservar proveedores y arquitectura **no demuestra que alcance el mismo abono**: el piloto necesita verificar planes, consumo disponible y recuperación. Si no alcanza, se revisa el alcance con el usuario; no se presupone ni autoriza otro plan.

| Consumo | Operaciones | Estimación/reducción |
|---|---|---|
| DB CPU/IO |Menú JSON,pedido/counter/rate limits,RLS,métricas,importación,entrega|Medir por query×QPS/tenant;proyección/paginación/índices probados/transacciones breves|
| Disco DB |Catálogo,pedidos,ítems/opciones snapshots,eventos,auditoría,tokens|Productos×bytes+pedidos×(cabecera+líneas+eventos)+índices;pg_total_relation_size en staging|
| Storage |Fotos nuevas/reemplazos/huérfanos|Productos×fracción con foto×bytes medios+marca+objetos retenidos|
| Egress Supabase |JSON/fotos/respuestas Edge/Realtime/admin/export|Sesiones×(JSON no cacheado+fotos vistas no cacheadas)+admin/export;medir cache efectiva|
| Edge |Crear/registrar/invitar/importar/expirar|Intentos exitosos+fallidos+replay;fotos van directo a Storage|
| Realtime |Cambios orders/events|Eventos×suscriptores autorizados+queries invalidadas;agrupar refresh si perfilado justifica|
| Vercel |Assets/requests/builds/OG cache misses|Cache hashes/rutas lazy;G05 reduce trabajo OG|
| Auth/email |Sesiones/MFA/invitaciones/recuperación|Confirmar SMTP/config/capacidad existentes;no suponer nuevo proveedor|

Ejemplo **parametrizado**, no consumo medido:150 KiB/foto×500/1.500/5.000=73,24/219,73/732,42 MiB;300 KiB duplica; máximo1 MiB implica500/1.500/5.000 MiB.50 fotos vistas/sesión fría×150 KiB=7,32 MiB;1.000 sesiones≈7,15 GiB sólo fotos. Sumar JSON/assets/comercios y usar cache real. Total de fotos no es descarga inicial pública.

Fuentes consultadas24/10/2026: [categorías de consumo Supabase](https://supabase.com/docs/guides/platform/manage-your-usage); [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) autoriza eventos por suscriptor, por lo que deben medirse filtros/fan-out. No prometer escala ilimitada cambiando compute.

**Backups:** confirmar elegibilidad/retención de plan; **backup PostgreSQL no contiene objetos de Storage** ([fuente oficial](https://supabase.com/docs/guides/platform/backups)). No activar PITR pago por defecto. Si recursos actuales no cumplen RPO/RTO sin cambio autorizado, reducir compromiso o declarar incompatibilidad. Probar restore DB+objetos/roles/config, con copia en destino ya disponible. Nada de esto está demostrado por documentación del repo.

**Mantenimiento:** no hay scheduler versionado; pg_cron remoto ausente no excluye un scheduler externo no inspeccionado. expire-orders llama expire_orders, que también limpia rate_limits antiguos; cleanup_rate_limits existe además separadamente. Tokens/idempotencia/pedidos/auditoría carecen de retención automática completa. [Supabase Cron](https://supabase.com/docs/guides/cron), si disponible en el proyecto, permite agendar funciones controladas y observar jobs sin otro servicio; no se habilitó. Definir retención antes de borrar; nunca purgar claves de entrega mientras el pedido pueda reintentarse. Huérfanos: inventario list_orphan_image_assets, revisión/gracia, no borrado ciego.

**Logs/alertas:** Edge safeLog/requestId, Auth logs, audit_logs/order_events existen; alertas activas/retención contratada no verificadas. Definir controles por429/fallos de entrega/importación/cuotas/backup/jobs usando capacidades actuales, sin PII/secretos. Mantenimiento residual: revisión de incidentes/consumo, parches, restore ensayado, limpieza controlada, conteos y ventas externas registradas. La conciliación física no desaparece con software.

## 8. Información imprescindible pendiente

1. Qué significa **entregado** en la operación real y qué acción autorizada lo confirma. El requisito de descontar al entregar está confirmado; su hito físico no debe quedar implícito en el nombre `completed`.
2. Catálogo y tamaño habitual/máximo de pedido, pico por 10 min y clientes/operadores del **primer mayorista**; aceptar o adaptar límites actuales. La escala multicomercio se estima después.
3. Unidad, caja, bulto o fracción; códigos por presentación/variante y conversiones exactas. Unidad entera es un supuesto de estimación, no una decisión aprobada.
4. Si aceptar un pedido debe reservar disponibilidad. Sin reserva puede haber faltantes al entregar; si se garantiza mercadería al aceptar, la reserva pasa a alcance necesario antes de ofrecer esa garantía.
5. Conteo físico inicial, ventana sin movimientos o conciliación entre conteo y registro; tratamiento de pedidos pendientes; responsables de ventas externas, reposiciones y ajustes.
6. Si existe otro sistema de stock, cuál será la fuente principal y quién registrará/conciliará las diferencias. No hay integración autorizada ni demostrada.
7. Devoluciones físicas y correcciones administrativas; confirmar por separado si se necesitan **devoluciones parciales** y **entregas parciales**. Definir cómo se presentan y contabilizan las operaciones compensadas y pedidos reemplazantes.
8. Planes Vercel/Supabase y recursos/uso, backup DB+Storage/RPO/RTO, dominio/deployment de referencia, integración Git externa de Vercel, Auth/SMTP/Turnstile. No confirmar mismo abono ni automatismo de despliegue sin esa evidencia.

## 9. Respuestas finales

1. **¿Sirve hoy?** No apto en condiciones actuales para la solución completa pedida. La base de catálogo/pedidos es aprovechable y >500 no exige otro stack. La primera versión apunta a un mayorista y su volumen acordado, no a aprobar toda la matriz de crecimiento.
2. **¿Demostrado?** Código/arquitectura/límites/defectos/ausencia de stock, checks locales, render sintético y metadata remota de la auditoría original. Faltan backend/concurrencia, paridad de despliegue, tests DB, plan y recuperación; esta revisión sólo actualiza documentación.
3. **¿Bloqueantes?** Correcciones indispensables, reglas comerciales definidas, inventario mínimo con reportes/corte/contingencia seguros, pruebas de DB real y piloto del mayorista validado. B/C multicomercio quedan para crecimiento posterior.
4. **¿Stock al entregar?** Hito físico confirmado por el negocio y RPC autorizada con bloqueo de pedido+saldos, necesidades canónicas agregadas, validación total, descuento/movimientos/estado en una transacción y replay del mismo resultado. Pruebas DB de concurrencia, reintentos, fallos y permisos obligatorias antes de activar; nunca bypass en contingencia. Ver plan.
5. **¿Mismos servicios y suscripciones?** Arquitectura sí. Mismo abono todavía no confirmado: planes, uso y recuperación siguen pendientes; si no alcanzan, se revisa el alcance sin upgrade implícito.
6. **¿Primero?** Tanda de reproducción aislada + S01, 3–5 jornadas incluidas en el total y sin correos reales; después el resto de correcciones e inventario mínimo. El escenario de lanzamiento aún no aprobado estima 40–64 jornadas con margen, no 5–8; desglose, dependencias y ampliaciones en el [plan](PLAN_MAYORISTA_Y_STOCK.md).
