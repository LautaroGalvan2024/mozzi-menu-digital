# Plan mayorista y stock al entregar

Fecha: **24/10/2026**, revisión de alcance previa a implementación. Diseño propuesto, **no implementado**. Código auditado: `bf183767b8ba6012e2d33d177e473d5534669b9c`. Esta revisión se trabaja en `feature/mayorista-stock`, creada después de actualizar referencias y comprobar que `origin/main` seguía en esa base. Los documentos y mediciones anteriores se preservaron en `97c6a36`. Hallazgos y límites de evidencia en [AUDITORIA_MAYORISTA.md](AUDITORIA_MAYORISTA.md). Esta entrega modifica documentación; no modifica funcionalidad ni ejecuta migraciones.

Regla confirmada: **las existencias físicas se descuentan sólo al confirmar entrega**. `generated`, abrir WhatsApp y `accepted` no descuentan existencia física. **Sigue pendiente qué hito del negocio significa “entregado”**: despacho, recepción del cliente o retiro, quién lo confirma y cómo se trata mercadería en tránsito. También sigue pendiente si `accepted` debe reservar. Se propone conservar `completed` por compatibilidad y vincularlo al hito acordado; no se da esa semántica por aprobada ni se usa como confirmación de cobro.

El objetivo cabe en React/PostgreSQL/Supabase/Vercel actuales. La suficiencia de suscripciones y la posibilidad de uso comercial aún requieren G02; no se autorizan upgrades ni otros servicios. No se agregan ERP, contabilidad, logística, microservicios ni integraciones inventadas.

## Alcance de la primera versión

El lanzamiento se limita a **un mayorista piloto**, con su catálogo, operadores, canales y pico de pedidos acordados. La compatibilidad de los comercios actuales se conserva; no se desarrolla una solución universal para otros rubros. Los requisitos se separan en tres grupos:

1. **Correcciones indispensables:** permisos S01, entradas acotadas S03/S04, importación segura C02/C10/C11, idempotencia de pedidos O03 y reproducibilidad G01. C05 aplica si usa opciones; C01 y O02 se cierran cuando el catálogo o los pedidos reales alcanzan sus límites. Se comprueban esas condiciones antes del piloto, sin presumirlas resueltas.
2. **Inventario mínimo:** entrega atómica, saldos y movimientos inmutables, permisos, ingresos/ajustes, corte físico, tratamiento de pendientes, ventas externas conforme a la fuente principal acordada, correcciones/devoluciones y reportes coherentes, pausa segura y validación real. Las decisiones comerciales de la sección siguiente fijan su alcance definitivo.
3. **Mejoras posteriores:** escalas muy superiores al piloto, optimización SQL/virtualización sin cuello medido, directorios globales, rediseños, precios avanzados e integraciones no requeridas. No bloquean el piloto por estar incluidas en la auditoría.

Los resultados sintéticos de 1.500/5.000 productos se conservan como evidencia exploratoria. No hay obligación de repetir toda la matriz A/B/C ni de optimizar para 50 comercios antes de operar uno. Sí es obligatorio medir el catálogo y pico acordados del mayorista, con margen documentado, y corregir cualquier problema que afecte ese alcance. Un mock del backend sólo evalúa frontend y contratos simulados, **no certifica capacidad ni integridad productiva**.

## Decisiones comerciales pendientes — ninguna se presume confirmada

| ID | Decisión que debe registrar el mayorista | Impacto en alcance y aceptación |
|---|---|---|
| D01 | Qué significa entregado; despacho, recepción o retiro; quién confirma; tratamiento del tránsito | Define el momento del débito y de `completed_at`. Si el conteo excluye mercadería en tránsito pero el débito espera recepción, hace falta una conciliación/modelo explícito; no mezclar ambas bases |
| D02 | Si aceptar garantiza/reserva mercadería | Si reserva es necesaria, se incorpora antes del piloto. Si no, debe aceptar expresamente que pendientes compiten por stock y definir cómo resolver faltantes |
| D03 | Venta por unidad, caja, ambas o fracciones; equivalencias y SKU compartidos | Determina unidad base, conversiones exactas, snapshots, cantidades/precios y límites en UI/Edge/SQL. No deducir caja de una promoción |
| D04 | Qué ventas ocurren fuera de la app, quién las registra y cuándo | Define la captura de salidas de local/teléfono/otros canales y el desfase tolerable; una carga al cierre no permite prometer saldo exacto durante el día |
| D05 | Si otro sistema lleva stock y cuál será la fuente principal | Evitar dos saldos editables considerados oficiales. Si manda otro sistema, acordar sincronización/conciliación y reestimar; no ofrecer stock autoritativo de la app sin resolverlo |
| D06 | Devoluciones completas o también parciales; recepción y condición de mercadería; permisos | Define retorno vendible, tratamiento de dañados y límites acumulados. Devolución parcial y entrega parcial son decisiones independientes |
| D07 | Si necesita entregas parciales, sustituciones o pedido reemplazante | El mínimo técnico es una entrega completa por pedido; si no sirve, ampliar antes del piloto. Acordar qué constituye una corrección administrativa versus una nueva expedición real |
| D08 | Catálogo, pedido máximo, operadores simultáneos y dispositivos/redes reales | Fija pruebas de límites y carga del piloto, con margen acordado; 25 líneas/100 unidades actuales no se dan por suficientes |
| D09 | Responsables, ventana/corte físico, pendientes al inicio y frecuencia de conciliación | Permite activar saldos sin perder ni duplicar movimientos entre contar y registrar |

Registrar respuesta, responsable y fecha. Las correcciones independientes de estas decisiones pueden avanzar por etapas; **no se activa inventario con D01–D09 sin resolver en lo que afecte al piloto**. El escenario de estimación al final es una hipótesis para dimensionar, no aceptación comercial de estas propuestas.

## Diseño mínimo propuesto de stock (no implementado)

### Modelo y límites deliberados

La arquitectura actual es suficiente para resolver consistencia dentro de PostgreSQL/Supabase; no requiere colas, Redis, VPS ni otro servicio. No implica que capacidad/plan contratado estén verificados.

- `restaurants.inventory_mode`: `never_enabled` para comercios que nunca activaron stock; primera activación a `enforced`; luego sólo `enforced` ↔ `paused`. `inventory_started_at` inmutable tras activación y versión de política. **No existe desactivación que vuelva a crear pedidos sin control.** Estado validado en servidor; constraint/RPC impiden volver a `never_enabled` y falsificar snapshots. El frontend sólo lo presenta.
- `restaurants.inventory_cutover_in_progress`: bandera persistida del corte, inicialmente falsa, en la misma fila de política. Se activa/audita con lock exclusivo antes del conteo; **prevalece sobre `never_enabled`** y bloquea operaciones afectadas en todas las rutas vigentes, incluidas RPC usadas por UI antigua. No es un cuarto modo ni se controla desde el cliente. Sólo finalización del lote de apertura/ajuste conciliado y, cuando corresponda, activación la libera atómicamente; abortar un corte exige revisión y registro explícitos, nunca liberación automática por timeout.
- `products.track_inventory` o configuración vinculada: decidir qué productos administran existencias. Para el mayorista, todos sus SKU físicos se activan explícitamente. `available` sigue siendo bloqueo comercial manual y se combina con stock cuando se proyecta disponibilidad; no reemplaza cantidad.
- `inventory_balances(restaurant_id, product_id, on_hand_base_units bigint NOT NULL CHECK >=0, initialized_at, updated_at)`, PK `(restaurant_id,product_id)`, FK compuesta a products. **Fila ausente significa no inicializado**, no stock cero inventado. Una fila con cero sólo nace de conteo inicial explícito. Nunca editar saldo desde frontend.
- `inventory_operations(id, restaurant_id, kind, order_id nullable, idempotency_key, request_hash, reason, actor_user_id, created_at, reverses_operation_id nullable)`. UNIQUE `(restaurant_id,idempotency_key)`; índice único parcial para una entrega por `(restaurant_id,order_id)`; FKs compuestas tenant. `kind`: opening, receipt, delivery, adjustment, physical_return, delivery_correction, external_sale. Motivo obligatorio para ajuste/corrección y canal/ref para venta fuera de app. Política sencilla sin tablas de proveedores/logística.
- `inventory_movements(id, operation_id, restaurant_id, product_id, delta_base_units bigint CHECK <>0, balance_after bigint CHECK >=0, order_item/source reference opcional, created_at)`. FK compuestas a operación y saldo; UNIQUE `(operation_id,product_id)` si cada operación agrega por producto. Saldos son lectura rápida; movimientos inmutables permiten reconciliar `saldo = suma movimientos`. Carga inicial cero puede tener operación/registro de conteo sin movimiento delta=0; no forzar movimientos falsos.
- `orders.inventory_policy_snapshot`/versión e `order_items.inventory_tracked_snapshot`, `stock_product_id_snapshot`, `sales_unit_snapshot`, `base_units_per_sale_snapshot`, `stock_quantity_base_snapshot`. Se calculan en servidor al crear, nunca desde precio, código libre ni datos reenviados por el cliente. Para el mayorista activado ningún pedido nuevo recibe política legacy, incluso durante contingencia. Una línea futura con producto no rastreable o conversión faltante impide entrega y solicita corrección explícita. Reconciliar las líneas repetidas por stock_product_id, independientemente de notas/opciones que afectan precio.
- Índices: movimientos `(restaurant_id,product_id,created_at DESC,id)` y `(restaurant_id,order_id)` vía operación; operaciones por idempotencia/entrega. Sin índices indiscriminados ni almacenamiento duplicado de PII.

**Unidades pendientes:** actualmente cantidades son enteros; `code` identifica producto, opciones no inventario. MVP recomendable: un producto = un SKU físico, venta y stock en la misma unidad entera. No asumir que una promo 6× implica caja. Si el mayorista necesita unidad+caja del mismo saldo, hace falta una presentación con conversión fija a unidad base y snapshot (ejemplo hipotético que requeriría confirmación: caja de 12 → 12 unidades). Si necesita fracciones, elegir unidad mínima entera exacta (gramos/ml) o numeric con escala acordada y adaptar todas las validaciones, precios, DP, UI e importación; nunca float. No prometer fracciones ni variantes con stock en el MVP sin especificarlas. Dos presentaciones que comparten stock deben mapearse explícitamente al mismo SKU y agruparse antes de descontar.

### Operación única de entrega y concurrencia

Se puede mantener `complete_order(uuid)` como interfaz compatible, pero debe delegar a la única lógica `deliver_order`/helper privado. **No dejar un RPC antiguo ni un UPDATE directo que permita saltar stock.** API pública recibe order_id y opcional UUID de operación; cantidades/precios/actor/tenant se derivan en servidor. La idempotencia semántica por pedido protege aun con claves distintas.

Pseudoflujo dentro de **una sola transacción DB**:

1. Exigir auth.uid, perfil activo y rol permitido. Consultar tenant del pedido y comprobar pertenencia antes de devolver estado o resultado de replay. `SECURITY DEFINER SET search_path=''`, nombres calificados y EXECUTE sólo authenticated; helper privado no invocable anónimamente. La autoridad de política es la fila de `restaurants`: tomar `FOR SHARE`, compatible entre operaciones ordinarias; activación/pausa toman `FOR UPDATE` en esa misma fila. Mantenerlo hasta commit para serializar el corte sin serializar todas las entregas entre sí.
2. `SELECT orders ... FOR UPDATE` por ID, tenant autorizado. Esta fila serializa entregar, cancelar y cualquier futura edición/corrección. Todas las rutas respetan **política → pedidos en orden → operación original si aplica → saldos en orden**; nunca tomar saldo antes del pedido ni política después. Revalidar autorización con el contrato de membresías antes de mutar.
3. Si ya existe operación de entrega: devolver resultado persistido y flag `alreadyDelivered`, incluyendo si fue luego corregida/devuelta; **nunca volver a descontar**. Si es un completed histórico terminal previo al corte, sin ledger y con snapshot legacy explícito: devolver legado completado sin crear movimiento retroactivo. Si política tracked y completed sin ledger: error de integridad, no inventar éxito ni descontar a ciegas.
4. Si no es replay, exigir estado anterior `accepted`. Con política `paused` o `inventory_cutover_in_progress=true`, devolver `INVENTORY_PAUSED` o `INVENTORY_CUTOVER` antes de mutar. El camino histórico sin stock sólo existe en un comercio `never_enabled`, sin corte en curso, sin fecha de activación y con pedido legacy; un snapshot legacy abierto en un comercio ya activado es error de integridad, no permiso para entregar. Con política `enforced`, exigir snapshot controlado completo y efectuar el débito. Leer líneas persistidas y multiplicar conversiones snapshot con comprobación de rango; sumar por producto/SKU físico. No confiar en carrito ni ids/cantidades enviados de nuevo.
5. Bloquear **todas las filas de saldo** requeridas con `FOR UPDATE` en orden determinista de `(restaurant_id,product_id)`. Confirmar que no falta ninguna y que cada on_hand alcanza la suma. No usar lectura previa en JS ni secuencia de peticiones por producto. No usar SKIP LOCKED para descontar pedidos: se espera o se devuelve error reintentable, no se saltean ítems.
6. Insertar operación de entrega protegida por UNIQUE; ejecutar `UPDATE ... SET on_hand=on_hand-required ... AND on_hand>=required` y comprobar filas, insertar movimientos con delta negativo y saldo resultante. Validación de todos antes de mutar facilita errores legibles; CHECK>=0 es defensa adicional.
7. Cambiar accepted→completed, completed_by/auth.uid y completed_at, registrar order_events y audit_logs vinculados a operation_id. Retornar resumen estable. Toda excepción aborta saldo, movimientos, evento y estado juntos. No capturar excepciones para continuar con un subconjunto.

**Dos operadores, mismo pedido:** el segundo espera lock del pedido y obtiene replay tras el primer commit; una sola entrega/evento. **Timeout post-commit:** repetir devuelve la misma operación aunque la respuesta anterior se perdiera. **Dos pedidos, mismas últimas unidades:** locks de saldo comunes serializan; el segundo vuelve a ver saldo actualizado y falla completo por insuficiencia. **Varios SKU:** orden determinista reduce deadlocks; si ocurre deadlock/transitorio, retry acotado de la transacción completa con misma idempotency key; nunca de sentencias individuales. Todas las reposiciones/ajustes/devoluciones usan el mismo orden de locks para evitar actualizaciones perdidas.

El servidor devuelve códigos de negocio: NOT_ACCEPTED, INVENTORY_PAUSED, INVENTORY_CUTOVER, INVENTORY_NOT_INITIALIZED, INSUFFICIENT_STOCK (lista mínima autorizada), ALREADY_DELIVERED, IDEMPOTENCY_CONFLICT. UI bloquea botón mientras está pendiente y refresca respuesta, pero eso es comodidad: la garantía reside en la transacción y constraints.

### Pausa operativa sin desactivar protecciones

| Estado del comercio | Nuevos pedidos, aceptación y salidas | Lectura, corrección y recuperación |
|---|---|---|
| `never_enabled` | Conserva comportamiento actual sin inventario si no hay corte en curso; `inventory_cutover_in_progress` bloquea creación/aceptación/entrega/salidas afectadas también por RPC antigua | No inventa saldos ni movimientos históricos; replay histórico sólo lectura |
| `enforced` | Nuevos pedidos con snapshot obligatorio; entrega y salida externa siempre transaccionales con stock | Operaciones autorizadas y auditadas |
| `paused` | Se bloquean crear pedidos afectados, aceptar, entregar y registrar nuevas salidas externas por UI, Edge, RPC vigente o antiguo. No se generan nuevos snapshots legacy | Lecturas y replay de operaciones ya confirmadas siguen disponibles; cancelación sin salida puede permitirse. Conteos/conciliaciones/correcciones sólo por RPC de mantenimiento autorizado, sin habilitar ventas |

Al confirmar la pausa, todas las operaciones anteriores que tenían lock compartido ya terminaron; las posteriores observan `paused` y fallan sin efectos. La pausa no se declara efectiva antes de obtener el lock exclusivo. Probar carreras de pausa contra creación/aceptación/entrega, incluidas sesiones con frontend anterior. La operación física de los canales afectados también debe detenerse: si no puede garantizarse, el comercio permanece pausado hasta registrar y conciliar esas salidas. Una devolución recibida durante contingencia se separa físicamente y se documenta para conciliación; no se vuelve vendible por un flag.

Conservar saldos, movimientos, claves de idempotencia, snapshots y guardias del RPC de pedidos existentes. Un rollback de UI no restaura funciones capaces de eludir stock. La reanudación exige conciliación verificada y queda auditada. Esta pausa es una contingencia del mayorista; no cambia el flujo de otros comercios `never_enabled`.

### Estados, cancelaciones, correcciones y devoluciones

| Transición/acción | Efecto en existencia | Regla |
|---|---|---|
| Crear/generated | Ninguno | El escenario sin reservas no promete disponibilidad futura; D02 sigue pendiente |
| Intento WhatsApp/whatsapp_opened | Ninguno | No demuestra envío ni aceptación |
| Tomar/accepted | Ningún débito físico | Reserva sólo si D02 lo exige; sin reserva, aceptación no garantiza unidades futuras |
| accepted→completed (entregado) | Débito atómico una vez | Entrega física confirmada; actor y movimientos |
| generated/whatsapp_opened/accepted→cancelled | Ninguno | Nunca reponer lo no descontado; si luego se implementan reservas, sólo liberarlas |
| generated/whatsapp_opened→expired | Ninguno | No restaurar existencia |
| Editar pendiente | Ninguno en saldo sin reservas | Hoy no existe edición; mínimo cancelar/recrear. Si se implementa, RPC lock de pedido, recalcular precios/conversiones, versión y evento; no alterar snapshots silenciosamente |
| Modificar/reabrir entregado | Prohibido por flujo ordinario | No borrar entrega ni habilitar segundo débito |
| Entrega registrada por error | Compensación trazable autorizada | Sólo si no hubo salida física, motivo y referencia a entrega; conserva original y evento de corrección |
| Devolución física | Entrada explícita después de recepción | No automática por cancelación administrativa; actor, motivo y operación original |

**Corrección administrativa:** una entrega marcada por error, sin salida física, genera compensación completa autorizada con motivo/actor y referencia única a la entrega. El original queda `completed` histórico con resultado operativo **corregida**; no se reabre ni vuelve a descontar. Si sólo se corrige texto o precio y hubo salida real, no se repone mercadería: el ajuste monetario es otro contrato y no se infiere de este flujo.

**Devolución física:** requiere recepción real. El resultado operativo queda **devuelta** o **devuelta parcialmente** (sólo si D06 incorpora parciales). No equivale a cancelación ni confirma reintegro de dinero. La mercancía dañada/no vendible no vuelve automáticamente a `on_hand` vendible: registrar recepción y destino/no reposición, según D06; el saldo sigue la cantidad efectivamente reincorporada. El mínimo sin parciales contempla una compensación completa por entrega y excluye una segunda corrección/devolución completa. Si se confirma retorno parcial, `source_delivery_operation_id` admite varias operaciones, con cantidades por línea/SKU original, idempotencia y límite acumulado recibido <= entregado bajo lock del original; la unicidad de reversión total no debe bloquear retornos parciales legítimos. Una corrección total tras devolución parcial se rechaza en el mínimo, para evitar reponer dos veces.

**Reemplazo:** nuevo pedido con `replaces_order_id`, `root_order_id` y motivo; referencias dentro del mismo tenant, sin ciclos ni sucesores concurrentes para la misma corrección. Conservar la cadena completa. Una entrega inválida corregida no cuenta junto a la válida de su reemplazante como dos entregas comerciales. Un reemplazo posterior a una devolución física sí puede representar otra expedición real: registrar ambas salidas físicas y la devolución, aunque pertenezcan al mismo caso comercial. No deduplicar movimientos reales por compartir raíz.

**Interfaz y reportes mínimos obligatorios:** lista, detalle, tablero y CSV distinguen “entrega vigente”, “entrega corregida”, “devuelta” y, si corresponde, “devuelta parcialmente”; muestran operación original, motivo, fecha, actor y enlace al reemplazante. `status=completed` solo no alcanza como filtro. El pedido reemplazante tiene su propio estado y no convierte la entrega original en vigente.

| Medida | Regla verificable |
|---|---|
| Casos comerciales entregados vigentes | Contar por raíz los casos con entrega válida vigente según el contrato acordado; excluir originales corregidos y devoluciones totales; mostrar parciales por separado si se habilitan |
| Unidades entregadas netas | Salidas válidas menos cantidades físicamente devueltas, con detalle de correcciones; no sumar el original corregido y su reemplazo. No confundir cantidad devuelta con cantidad reincorporada vendible |
| Expediciones físicas brutas | Mostrar salidas reales y retornos por separado; una entrega corregida sin salida física se excluye. Una expedición real de reemplazo no se oculta |
| Saldo de inventario | Apertura + ingresos + ajustes + reposiciones por corrección/retorno vendible − entregas/salidas externas; siempre igual a suma de movimientos |
| Fechas e importes | Entrega por `completed_at` acordado, corrección/devolución por su fecha propia. La vista de vigencia puede cambiar retrospectivamente; el libro de movimientos por fecha conserva el evento y ajuste de cada día. Importe asociado a una entrega errónea de $100 seguida de reemplazo de $100: vigente $100, no $200; mientras el reemplazo no se entrega, vigente $0. Valorar devoluciones requiere regla explícita para descuentos/envío/redondeos; no inferir reintegro ni ingresos cobrados. Exportar vínculos y eventos para explicar netos |

Ejemplo mínimo: entrega A de 10 marcada por error → corrección +10 → reemplazo B entrega 10: una entrega comercial vigente, 10 unidades netas, historial A visible como corregida y saldo neto −10. Si A sí salió y volvió completa antes de B: dos expediciones físicas brutas, una devolución de 10 y 10 unidades netas; no dos casos comerciales vigentes. Probar ambos y correcciones de un período anterior, mostrando ajustes en su fecha sin alterar silenciosamente el historial.

### Existencia, disponibilidad y reservas

| Política | Ventaja | Consecuencia/Complejidad |
|---|---|---|
| Validar y descontar al entregar | Menor cambio, coincide con regla confirmada; saldos siempre físicos | Varios pendientes pueden competir por últimas unidades. El primero que entrega gana; aceptación no garantiza disponibilidad; requiere faltantes/cancelación/sustitución acordada |
| Reservar al tomar, consumir al entregar | Permite prometer disponible al aceptar sin adelantar descuento físico | `available = on_hand - reserved`, ledger/estados de reserva, liberación al cancelar/editar, expiración de reservas/retenciones y locks adicionales; las ventas externas deben respetarla |

**Recomendación:** MVP sin reservas sólo si el mayorista acepta explícitamente el riesgo de pendientes concurrentes; mostrar “sujeto a disponibilidad hasta entrega” y faltantes al operador. Si aceptar un pedido debe garantizar mercadería, la reserva al tomar pasa a requisito comercial y se diseña antes de vender esa promesa. Validar al crear no reserva ni garantiza disponibilidad posterior. Consultar stock antes de aceptar es informativo; puede cambiar inmediatamente después.

### Permisos y acceso

- Lectura saldos/movimientos: `restaurant_admin` y `order_manager` activos del mismo comercio; considerar ocultar ajustes internos al gestor si negocio lo pide, sin inventar nuevos roles por defecto.
- Entregar: roles que actualmente `private.can_manage_orders` autoriza, manteniendo superadmin con AAL2. Pertenencia y perfil se revisan en servidor incluso en replay.
- Carga inicial, ingresos, ajustes, ventas fuera de app, correcciones y devolución: `restaurant_admin` del comercio; superadmin AAL2 sólo soporte explícito auditado. `order_manager` no ajusta inventario arbitrariamente.
- RLS de lectura tenant; sin INSERT/UPDATE/DELETE de saldo/ledger para anon/authenticated, sólo RPCs estrechos. Revocar PUBLIC por defecto y verificar grants explícitos en migraciones nuevas. Movimientos/operaciones append-only, UPDATE/DELETE protegidos. Un GUC interno no reemplaza permisos/RLS.
- Menú público sólo devuelve disponibilidad necesaria (o cantidad pública si negocio lo autoriza); nunca actor/motivos/costos/ledger. Para productos sin control conservar `available`. Para controlados usar `available AND stock>0`, sin prometer disponibilidad futura.

### Ventas por otros canales

No existe integración demostrada con caja, local, teléfono u otro sistema. Antes de diseñar la operación final, resolver D04/D05. Si la app será fuente principal y el mayorista acepta captura manual, agregar una salida externa con producto, cantidad, canal/ref/motivo y actor, con la misma idempotencia, pausa y locks. Registrar al hito de entrega acordado también en ese canal, con responsable y plazo explícitos. Un pedido de la app no se vuelve a registrar como venta externa: referencia de origen única y revisión de duplicados.

Si otro sistema es la fuente principal, documentar dirección del intercambio, identificadores, frecuencia, resolución de conflictos, reconciliación y qué operaciones bloquea una desconexión. **Esa integración no está incluida en el mínimo ni estimada sin contrato.** Una carga manual desde el sistema principal sólo es viable con corte/conciliación y límites operativos acordados; no equivale a sincronización automática ni a stock exacto en tiempo real. Si no se puede evitar doble contabilización o pérdida de salidas, no activar el stock de la app como autoritativo.

Importación de productos **no escribe stock**; conteo/reposición se carga por operación separada con preview, motivo, idempotency key y totales. El inventario sólo representa las existencias del alcance físico acordado; D01 debe hacer compatible ese alcance con mercadería en tránsito.

### Corte del conteo físico y ajustes posteriores

**Alternativa mínima: ventana sin movimientos.** Cerrar operativamente todos los canales del alcance y bloquear en servidor creación/aceptación/entrega/salidas afectadas durante el corte (`inventory_cutover_in_progress` para primera carga; `paused` y corte para recuentos). No mantener una transacción SQL abierta durante el conteo físico. Registrar sesión de conteo, SKU, unidad, cantidad, persona, `counted_at`, `recorded_at` y frontera de movimientos. Verificar que tampoco hubo ingresos, devoluciones ni movimientos físicos no cargados. Las RPC de mantenimiento rechazan movimientos ordinarios durante esa ventana; sólo el lote de corte puede finalizar o una conciliación explícita puede sustituirla. Aplicar apertura/ajuste y, cuando corresponda, activación en una transacción corta con locks y versión esperada; liberar la ventana sólo tras confirmación y conciliación. Finalizar un recuento no levanta por sí solo una pausa por otra contingencia.

**Alternativa si no se puede detener todo: conciliación explícita.** Registrar por SKU el instante/frontera de su conteo, y todos los movimientos físicos posteriores hasta el registro. No usar una fecha global para productos contados a distintas horas. Calcular `cantidad objetivo al registrar = cantidad contada + entradas posteriores − salidas posteriores` en la misma unidad y ámbito físico. Conservar evidencia, referencias de origen y quién concilia; una marca horaria sola no prueba que estén todas las operaciones ni su orden. Para saldos ya activos, usar también una frontera/version del ledger y reconciliar salidas físicas todavía no registradas.

En ajustes posteriores, después de bloquear el saldo y revalidar la frontera: `delta de ajuste = cantidad objetivo conciliada − saldo actual`. Los movimientos ya reflejados en saldo se usan para trasladar el conteo al momento actual, **no se insertan otra vez**. Ejemplo: saldo 10, conteo 10 a las 10:00, entrega registrada de 2 a las 10:05; a las 10:10 el objetivo es 8 y el saldo es 8: ajuste 0, nunca reponer 2. Para apertura sin ledger previo, elegir y documentar una sola representación: saldo inicial conciliado al corte, con movimientos previos sustentados en el acta de conciliación y sin volver a debitarlos, o apertura al conteo y movimientos posteriores identificados una vez. El mínimo usa la primera; no mezclar ambas.

Preview muestra conteo, frontera, movimientos conciliados y saldo resultante por SKU. Si cambia la versión después del preview, recalcular y pedir nueva revisión; no sobrescribir. `expected_version` detecta escrituras registradas, **no mercadería movida sin cargar**. Si falta evidencia, detener/recontar; “conté ayer y subo hoy” sin conciliación se rechaza. La carga inicial cero es explícita; ausencia de conteo sigue siendo no inicializado. Guardar el acta y los identificadores necesarios sin incluir PII ajena al inventario.

### Incorporación compatible, corte y reversión

1. Migración aditiva futura: `never_enabled` para comercios sin inventario, sin llenar existencias ni tocar históricos. Probar instalación limpia **y actualización de la base vigente con datos sintéticos**; compatibilidad de UI/Edge anteriores y nuevos. No ejecutar en esta revisión.
2. Resolver D01–D09 y ejecutar la ventana o conciliación de conteo descrita arriba. Preview por UUID/código resuelto dentro del comercio, duplicados/unidades validados. Cada saldo inicial tiene su corte y evidencia.
3. Antes de activar deben quedar **cero pedidos abiertos entregables con política legacy**: cerrarlos correctamente o incorporarlos en lote explícito auditado con mapeos/cantidades/snapshot, sin adelantar débito. Pedidos completed/cancelled/expired históricos no generan movimientos retroactivos. La mercadería pendiente aún dentro del ámbito contado forma parte del conteo, según D01.
4. Activar bajo lock exclusivo de política tras comprobar saldos, cobertura SKU y pendientes; registrar fecha/política. Creaciones e importaciones en curso deben quedar ordenadas respecto del corte. Toda alta nueva de SKU físico hereda control obligatorio/no inicializado; importación no crea excepciones silenciosas.
5. Piloto del mayorista, con gates reales aprobados y autorización expresa para producción. Revisar saldo físico y ledger cada jornada inicial; luego frecuencia acordada. Alertar sobre inconsistencias mediante capacidades existentes.
6. Contingencia: pasar a `paused`, conservar saldos/ledger/idempotencia/políticas y protecciones de pedidos existentes. Bloquear nuevas operaciones afectadas, incluidos pedidos y salidas externas; no ofrecer un modo de “seguir entregando sin stock”. No restaurar DB antigua ni funciones antiguas para borrar/eludir efectos. Compensar errores concretos con trazabilidad y reanudar sólo tras conciliación.

### Archivos y flujos concretos a modificar en la etapa futura

| Cambio | Lugares |
|---|---|
| Modelo/RLS/constraints/funciones inventario y hardened complete_order | Nuevas migraciones aditivas `supabase/migrations`, tests `supabase/tests`; regenerar `src/types/database.generated.ts` |
| Snapshot política/conversión al crear; hash idempotencia | Última `create_order_transaction` mediante nueva migración; `create-order/index.ts`, `_shared/schemas.ts`, `_shared/errors.ts` |
| Recuperación de checkout y cambio de total | `CheckoutPage.tsx`, `OrderGeneratedPage.tsx`, `checkout-attempt.ts`, schemas/domain; endpoint estrecho de recuperación si se incorpora |
| Cantidades/limites/líneas inválidas | `CartProvider.tsx`, `CartPage.tsx`, `ProductDialog.tsx`, `quantity-pricing.ts`, Edge schema y SQL |
| Entregar/mostrar faltantes/movimientos y actor | `OrderDetailPage.tsx`, `ClaimOrderPage.tsx`, `orderSchemas.ts`, `OrderStatus.tsx`, `src/lib/orders.ts`; nuevo panel inventario |
| Activación/carga inicial/reposiciones/ajustes | `RestaurantSettingsPage.tsx`, `ProductEditorPage.tsx`, `ProductsPage.tsx`, rutas `App.tsx`/`AdminLayout.tsx`; importación de stock separada de catálogo |
| Disponibilidad pública | `get_public_menu` wrapper vigente y helper, `PublicProduct`, API/Zod/usePublicMenu; caché invalidada al cambiar stock sin publicar ledger |
| Fechas de entrega, estados vigente/corregida/devuelta, vínculos de reemplazo y reportes netos | `get_order_metrics` nueva versión, `AdminDashboardPage.tsx`, `OrdersPage.tsx`, `OrderStatus.tsx`, detalle y CSV; agrupar antes de unir ítems/movimientos para no multiplicar importes |

### Criterios de aceptación futuros (no ejecutados)

| ID | Caso | Resultado obligatorio |
|---|---|---|
| AC01 | Entrega normal de 2 SKU con saldo | Estado+actor+evento+todos los movimientos/saldos se confirman juntos; snapshot monetario intacto |
| AC02 | Doble clic y reintento con igual o distinta key, mismo pedido | Una operación de entrega, un débito por SKU, una transición; retorno ya entregado |
| AC03 | Timeout después del commit / desconexión | Retry devuelve la misma operación/estado/saldo, sin nuevos movimientos |
| AC04 | Dos sesiones reales entregan mismo pedido simultáneamente | Un ganador; otro replay; actor original intacto |
| AC05 | Dos pedidos de 4 unidades compiten por 5 | Uno completed y saldo 1; otro accepted/insuficiencia sin movimientos; nunca -3 |
| AC06 | Uno de varios SKU insuficiente o sin saldo inicial | No se modifica ningún saldo/estado/evento; identifica faltante autorizado |
| AC07 | Excepción inyectada entre débito y evento/cambio estado | Rollback total; retry posterior una sola entrega |
| AC08 | Cancelación antes de entregar y carrera cancelar/entregar | Cancelar no repone; una transición gana según lock; no estado cancelado con débito oculto |
| AC09 | Corrección de entrega falsa repetida/concurrente | Compensación una vez con motivo/actor/referencia, original visible; no segunda entrega con mismo ID |
| AC10 | Devolución real y solicitud de corrección posterior | No doble reposición; suma retornada nunca excede lo entregado; cancelación administrativa no suma stock |
| AC11 | Anon, miembro de otro comercio, perfil suspendido, gestor intentando ajuste | Denegado antes de cualquier lectura sensible o mutación, incluso replay y RPC antiguo |
| AC12 | Producto repetido con distintas notas/opciones | Suma total por SKU físico para saldo; descuentos monetarios conservan su regla definida |
| AC13 | Caja/unidad compartiendo SKU, conversión modificada luego (si requerida) | Consume conversión snapshot exacta, agrupada; cambia catálogo sin reescribir pendiente/histórico |
| AC14 | Activación con pendientes/históricos y rollback UI | Ningún histórico recibe stock retroactivo; no quedan pendientes legacy entregables tras el corte; ningún RPC antiguo salta el débito |
| AC15 | Ingreso/ajuste/salida externa/importación repetida y concurrente | Clave+hash idempotentes, locks comunes, actor/motivo, saldo no negativo y conciliación ledger exacta |
| AC16 | Pausa vs creación/aceptación/entrega/salida externa, por UI antigua/nueva y RPC | Confirmada la pausa no se confirma ninguna nueva operación afectada; las anteriores terminan antes. No aparecen snapshots legacy; replay confirmado sigue sin efectos |
| AC17 | Intentar volver a never_enabled; activación vs creación/alta de SKU/importación | Transición prohibida tras activación; nueva operación toma política controlada o se bloquea; cobertura de SKU nunca se omite |
| AC18 | Corte inicial en never_enabled vs RPC antigua; conteo 10 y salida 2 entre conteo/registro; ingreso/devolución intermedios y horarios por SKU | Corte bloquea operaciones nuevas incluso legacy y mantenimiento ordinario. Fuera de ventana inmóvil, conciliación determina saldo correcto sin duplicar; sin evidencia o ante cambio de versión, rechaza y requiere revisión/recuento. Apertura cero y retry de lote funcionan |
| AC19 | Corrección total y reemplazo; timeout y dos creadores de reemplazo | Lista/detalle/tablero/CSV muestran original corregido y vínculo; un sucesor vigente, una entrega comercial válida, 10 unidades netas en el ejemplo; no importe duplicado |
| AC20 | Entrega ayer, corrección/devolución hoy y reemplazo mañana | Vista vigente distingue estados; reporte de movimientos conserva fechas y ajustes explícitos. Ningún join multiplica cantidades/importes |
| AC21 | Devolución total recibida, parte no vendible; intento de devolución sobre entrega corregida | Cantidad recibida y repuesta diferenciadas; sólo lo apto incrementa saldo; operación inválida no muta. No genera reintegro monetario automático |
| AC22 | Referencias a otro tenant/ciclo/reemplazo no autorizado; stock público | Denegación sin fuga; no actor/motivo/ledger público; aislamiento y permisos reales |
| AC23, condicional D06 | Retornos parciales 3+7 de 10, luego 1; dos sesiones intentan 6+6; timeout/retry | Acumulado <=10 por línea original, reposición única, cantidad retornable exacta; sólo una solicitud íntegra gana la carrera de 6+6, sin parcialidad accidental |
| AC24, condicional D02/D03/D07 | Reservas, conversiones/fracciones o entregas parciales confirmadas | Añadir suite del contrato acordado antes de activar; no marcar aprobado porque el escenario simple pase |

Las pruebas SQL existentes hacen replay/claim secuenciales (`002_orders_claim_storage.sql:86–159`) y promociones/histórico (`010_product_quantity_pricing.sql:345–442`); no reemplazan pruebas de dos conexiones simultáneas sobre el stock futuro. **AC01–AC22 aplicables deben ejecutarse con DB real aislada antes de activar**, más AC23/AC24 si se confirma su alcance. Procedimiento: seed sintético tenant A/B y roles, barrera de inicio en dos sesiones SQL, evidencia de solapamiento/locks, fallos antes de commit y respuesta perdida después, conteo de operaciones/eventos y suma movimientos=saldo. Permisos con roles/JWT reales, no service_role para simular RLS. `Promise.all` sin solapamiento demostrado, build verde y backend simulado no satisfacen este gate. Sin entorno DB, queda pendiente y se bloquea la activación; no se sustituye por inspección.


## Precisiones de integridad para implementar

- **Política estable:** al crear pedido, leer/bloquear la política del comercio de forma compatible con su activación y guardar versión. La activación debe serializarse con creaciones en curso. No leer el flag en JS y escribir el pedido después. Para el mayorista, los nuevos SKU físicos deben heredar control obligatorio/no inicializado; importación general no puede crear una excepción `track_inventory=false`. Excepciones sólo por administrador, explícitas/auditadas y válidas para pedidos futuros.
- **Datos históricos:** un código se puede reutilizar tras baja; ledger/referencias usan UUID estable y tenant. No se hace merge de saldos por nombre/código mutable. Una opción que representa físicamente otro SKU exige un mapeo explícito; hasta resolverlo el producto controlado no se publica/vende como si compartiera stock.
- **Invariantes DB:** PK/FKs compuestas, on_hand>=0, delta no nulo, unicidad entrega/operación, ledger append-only y ausencia de grants de escritura directa. Toda ruta vigente de completed delega en la misma función; revisar triggers de guardia de orders y comprobar que ningún RPC alternativo complete sin movimiento cuando policy lo exige. Considerar constraint trigger diferido que verifique la relación completed↔operación de entrega para pedidos tracked, sin depender de un flag UI. El service_role sigue siendo una credencial altamente privilegiada, no una frontera frente a un administrador DB malicioso.
- **Orden de locks:** fila de política en `restaurants` compartida → pedidos por UUID → operación original si aplica → saldos por UUID. Activación/pausa toma esa fila exclusiva primero. Ingresos/ajustes sin pedido omiten el lock de pedido pero conservan el orden aplicable. La creación vigente ya bloquea `restaurants FOR SHARE`; reutilizar esa autoridad, sin segunda fila de política. Cambios de SKU/conversión/importaciones que afecten control también respetan política antes de producto. Revalidar actor/rol; una invitación no puede saltarse S01.
- **Idempotencia por contenido y negocio:** mismo UUID+hash devuelve respuesta guardada; UUID reutilizado con otro payload produce conflicto. Una nueva key para el mismo pedido tampoco permite otra entrega: protege el índice único por pedido. El resultado de replay indica saldo **al momento de la operación**; si se muestra saldo actual se lee/rotula separadamente. Nunca prometer exactamente una petición HTTP: se garantiza un único efecto confirmado.
- **Importes/unidades:** usar bigint o numeric de escala fijada, validar overflow de suma/multiplicación y representación segura en TypeScript. Snapshots físicos no se recalculan con conversiones cambiadas en catálogo. Los precios/promos siguen las reglas de agrupación actuales hasta que se acuerde otro contrato; stock siempre agrega por SKU físico.
- **Carga inicial/ajustes:** nunca upsert de existencia desde Excel general. Operación separada con idempotencia, preview, actor, corte físico y conciliación conforme a la sección de conteo. Versión esperada complementa pero no sustituye la frontera física. Reposición normalmente es delta positivo, no sustitución de saldo. Cero explícito inicializa; ausencia bloquea.
- **Pendientes al corte:** cerrar pendientes antes del inicio es la opción más simple. Si no es viable, revisar uno por uno en lote explícito, mapear UUID/unidades y establecer snapshot sin descontar todavía. El conteo físico inicial incluye mercadería aún no entregada. No se dejan pendientes entregables por un camino legacy silencioso. Pedidos históricos terminales nunca se debitan retroactivamente.

```mermaid
flowchart TD
  A[Operador confirma entrega] --> B[RPC verifica actor y comercio]
  B --> P[Lock compartido de política]
  P --> C[Bloquear pedido]
  C --> D{Entrega ya registrada}
  D -->|Sí| E[Devolver resultado original]
  D -->|No| F[Exigir accepted y política activa]
  F --> G[Sumar necesidades canónicas por SKU]
  G --> H[Bloquear saldos en orden y validar todos]
  H --> I{Alcanzan todos}
  I -->|No| J[Error sin ningún cambio]
  I -->|Sí| K[Débitos + movimientos + completed + auditoría]
  K --> L[Un único commit]
```

Las cajas P–L pertenecen a una sola transacción. Cualquier error de K revierte también los débitos; no existe commit intermedio por producto. Si se pierde la respuesta de L, repetir vuelve a E, también durante pausa y siempre con autorización. Un pedido nuevo con política pausada falla en F sin mutar.

## Plan priorizado por entregas pequeñas

Cada entrega resuelve un objetivo, mantiene la app operativa y tiene commit y validación propios. Las referencias B/I/R enlazan los hallazgos de auditoría; no son una orden de implementar todo en un único cambio. Una decisión comercial que agregue reservas, fracciones, parciales o integración modifica alcance y estimación antes de empezar esa parte.

### A. Correcciones indispensables y preparación del piloto

| ID / hallazgos | Cambio acotado | Criterio de cierre y condición |
|---|---|---|
| B00 / G01 | Entorno aislado reproducible: versiones/lock, PG compatible, baseline y datos sintéticos | Registrar fallos previos separados; ejecutar suites actuales y migraciones sólo en DB local desechable cuando se autorice implementación. Hoy faltó Docker/Podman; no declarar pgTAP aprobado |
| B01 / S01 | Impedir degradación de administradores mediante invitación y preservar último admin | Actor/objetivo/roles previos validados bajo locks; nuevo manager, repetición y reactivación permitida siguen funcionando; pruebas reales de permisos/carreras. Primera tanda definida abajo |
| B02 / S03,S04,G01 | Acotar cuerpo antes de leerlo entero y cardinalidad antes de Zod; dependencia afectada y formato CI | Separar corrección de límites de cualquier actualización de dependencias. Rechazo temprano, límites válidos y suites reproducibles; evaluar compatibilidad, no migrar toda la librería por rutina |
| B03 / C02,C10,C11; C05 si usa opciones | Importación de precios que preserve otros campos; decimales inequívocos; contrato de grupos válido | Commits separados para patch de precios y grupos. Precio no reactiva agotado ni borra promo/metadata; max0 no rompe catálogo; opciones activas suficientes. Preview y lote atómico; revisar datos antes de constraint nueva |
| B04 / C01 | Gestión completa del catálogo del mayorista | Medir catálogo real y max_rows efectivo. Si puede truncarse dentro del alcance con margen, paginar/buscar en servidor antes del piloto; probar límite±1 y último SKU. 5.000 productos no es un gate por sí mismo |
| B05 / O02,C09,O07 | Cantidades y límites que cubran pedidos reales | Acordar D03/D08; unificar UI/Edge/SQL sólo a topes necesarios, entrada numérica si necesaria, overflow y WhatsApp verificables. No añadir precios por tramos ni acciones masivas sin necesidad |
| B06 / O03 y mínimos O04/O08/C03 | Intento recuperable, hash del pedido completo y conflicto explícito; revisión de líneas/precio | Timeout después del commit no duplica pedido; datos cambiados no devuelven éxito engañoso; resolver intento anterior antes de nueva key. Recuperación de alcance mínimo, sin exponer PII ni UUID como permiso |
| B07 / G02 | Planes, uso, recuperación y disparadores de publicación | Verificar plan real y uso Supabase/Vercel, elegibilidad comercial, cuotas, backups DB/Storage y restore aislado, Auth/CSP/SMTP/Turnstile pertinentes. No asegurar mismo abono ni autorizar pagos implícitos |

B00/B01/B02/B03/B06/B07 son preparación del lanzamiento según flujos utilizados. B04/B05 y C05 se deciden con evidencia del piloto; si el defecto afecta el catálogo/pedido acordado, pasa a indispensable. Una vulnerabilidad o fallo de integridad aplicable no se posterga por llamarlo piloto. Las tareas de esta tabla se dividen por objetivo; no se mezclan con inventario ni rediseño visual.

### B. Inventario mínimo para ese mayorista

| ID | Entrega concreta | Dependencias / aceptación |
|---|---|---|
| I01 | Migración nueva aditiva: política estable, saldos, operaciones/movimientos, snapshots, constraints/RLS/grants e índices necesarios | D01–D05, B00/B01/B05; cero distinto de no inicializado, aislamiento real, esquema compatible sin alterar migraciones aplicadas |
| I02 | RPC única de entrega y wrapper compatible; política, locks ordenados y ledger/estado/auditoría atómicos | I01; AC01–AC08/AC11–AC17, dos sesiones reales y fallos. No activar aún |
| I03 | Apertura, ingresos, ajustes y salida externa acordada, por RPC idempotente y UI mínima | I01, D04/D05/D09; corte físico verificable, AC15/AC18; catálogo no escribe stock; fuente principal resuelta |
| I04 | Corrección administrativa y devolución completa, estado visible y pedido reemplazante trazable | I02, D06/D07; AC09/AC10/AC19–AC22; no doble reposición, no doble conteo ni reintegro monetario automático |
| I05 | UI de entrega/faltantes, saldos/movimientos, pausa/reanudación; disponibilidad pública acotada | I02–I04; mismo diseño actual, errores recuperables, manual available respetado, no exponer ledger; stock mostrado no es reserva |
| I06 | Métricas y CSV con estados vigente/corregida/devuelta, fechas y netos definidos | I04; AC19/AC20, agregados sin multiplicación de joins, enlaces de reemplazo. La corrección mínima de O06 entra aquí, no queda relegada como optimización |
| I07 | Integración real, actualización desde base vigente, ensayo de corte/pausa/recuperación y piloto | Todas las anteriores y gates de este documento. Activación sólo después de evidencia y autorización de producción |

La hipótesis más simple es unidad entera, un SKU físico por producto, sin reservas, entrega completa y devolución completa, con captura manual de otros canales siendo la app fuente principal. **No está confirmada.** Si no cubre al mayorista, se ajusta antes de implementar el contrato de stock. La pausa, el corte físico, los reportes correctos y las pruebas reales pertenecen al mínimo, no a una fase opcional.

### C. Mejoras posteriores o condicionadas a necesidad demostrada

| ID / hallazgo | Trabajo que puede esperar | Cuándo pasa a requisito del piloto |
|---|---|---|
| R01 / C04 | Render incremental, memoización, optimización SQL y fotos | Cuando medición con catálogo/dispositivo/pico acordados muestre impacto que impide operar. Elegir el cambio mínimo y comparar antes/después; no repetir 27 corridas automáticamente |
| R02 / C06–C08 | CAS general de catálogo, reintentos de imágenes, preflight y UX de importación | Si habrá edición concurrente o importación de fotos con fallos en el piloto, proteger la ruta usada; no borrado de imagen ante resultado incierto. Mejoras de comodidad restantes después |
| R03 / O05,G03 | Exportación histórica avanzada y directorios globales completos | Si el volumen real trunca/duplica reportes necesarios. Los estados/fechas/netos de I06 sí son indispensables desde stock |
| R04 / S02,S05,S06 | Refuerzo de rate limit/IP, NAT y registro WhatsApp | Verificar protección y carga reales; si hay abuso/riesgo aplicable no mitigado, cerrar antes de exponer el flujo. No ampliar topes sin cotas |
| R05 / O09,S07 | Vencimiento coherente, job/retención de auxiliares observables | Si el piloto depende de expiración automática, confirmar ejecución y corregir doble ventana; nunca purgar ledger/idempotencia comercial por esta tarea |
| R06 / S08,S09 | Onboarding recuperable y fallback Auth acotado | Si alta/invitaciones del piloto presentan el fallo; no envíos de email reales de prueba |
| R07 / G04,G05 | Refactorizaciones, RPC OG, índices nuevos, virtualización | Sólo con beneficio demostrado; no son condición universal del lanzamiento |
| R08 / capacidad | Escenarios grandes B/C, más comercios e historial muy superior | Antes de comprometer ese volumen futuro. No bloquean piloto de un mayorista ya medido |

### Ampliaciones comerciales con estimación independiente

Estimaciones incrementales orientativas de desarrollo y pruebas sobre inventario mínimo terminado; no sumar automáticamente porque hay solapamientos. Ninguna decisión está aprobada por estar en esta tabla.

| Cambio | Alcance adicional | Jornadas orientativas |
|---|---|---|
| Reserva al aceptar | Saldo reservado separado, liberación/consumo/expiración y ventas externas que respetan reserva; no adelanta débito físico | 5–9, reestimar con política de vencimiento |
| Unidad/caja del mismo SKU | Presentaciones y conversión snapshot exacta, UI/importación y agrupación por saldo común | 4–8 |
| Fracciones | Unidad mínima o escala exacta, cantidades/precios/validaciones y compatibilidad de importación/promos | 5–10, según contrato; puede solaparse con conversiones |
| **Devoluciones parciales** | Una entrega por pedido, varios retornos con detalle por línea original, cantidad recibida/repuesta y retornable; AC23, UI/reportes y carreras | **4–7**, sin reintegros monetarios ni fracciones; valorar descuentos/reembolso requiere alcance aparte |
| **Entregas parciales** | Varias salidas por pedido, remanentes y estados, cancelar pendiente; reemplaza unicidad de entrega por pedido y adapta idempotencia/reportes | **8–12**, distinta de devolver parte de una entrega completa |
| Otro sistema como fuente principal | Contrato de intercambio, conflictos, identificación, cortes y operación durante desconexión | Sin estimación responsable hasta relevar su API/proceso; fuera de la base |

Para devoluciones parciales el detalle conserva `order_item_id`, cantidad recibida y repuesta en unidad base; después agrega por SKU para saldo. Los precios/promos/portes originales no se prorratean por suposición ni se alteran al retornar. Un intercambio sin cargo y una compra nueva deben clasificarse expresamente antes de usar la misma raíz comercial; el mínimo garantizado de reemplazo cubre una entrega corregida por error.

## Primera tanda concreta de implementación — propuesta, no ejecutada

**Objetivo:** reproducir la base en aislamiento y cerrar **S01: invitaciones que degradan administradores**. Alcance acotado, sin inventario, importaciones, rediseño, refactorización general ni cambios de planes. Estimación **3–5 jornadas** incluyendo preparación y pruebas pertinentes, absorbidas en B00/B01 y en el total de lanzamiento; no es todo el proyecto. Si el entorno requiere trabajo adicional, registrarlo antes de ampliar esta tanda.

1. **T0 — Baseline verificable.** Confirmar rama/estado y fetch antes de comenzar. Preparar entorno local aislado con versiones alineadas a CI y PG remoto, sin credenciales/clientes productivos. Ejecutar checks actuales y registrar SHA/versiones/resultados, incluidos fallos preexistentes de dependencias/formato y pruebas omitidas. No arreglarlos incidentalmente: tienen entregas propias. Verificar que las pruebas SQL sí se ejecutan; si falta runtime DB, esta tanda no puede declararse validada.
2. **T1 — Una corrección de membresías.** Crear una migración nueva que reemplace la definición de `upsert_restaurant_membership` sin cambiar su contrato público innecesariamente. Revalidar actor, objetivo, rol previo y administradores activos bajo locks coherentes con `set_restaurant_member_status`; no permitir que invitar manager sea una degradación implícita de admin. Preservar alta/reinvitación/reativación permitidas. Cambiar el handler sólo si el contrato de error lo exige, y en un commit separado.
3. **T2 — Evidencia y revisión.** Pruebas de autorización pgTAP y concurrencia con dos conexiones independientes; handler contra servicios locales con email interceptado. Revisar diff, permisos, compatibilidad y ruta de pausa antes de cada commit. Commit de corrección con pruebas asociadas; preparación de entorno y ajustes de handler/CI, si necesarios, separados por objetivo. Entregar resultados y fallos sin ocultarlos; no hacer merge/push/despliegue/migración remota en esta revisión documental.

| Criterio de aceptación de la tanda | Evidencia requerida |
|---|---|
| Admin A no degrada a admin B ni a sí mismo enviando invitación manager | Rechazo/no cambio de rol en DB real y error del handler coherente; membresía previa conservada |
| Último admin activo no desaparece por degradación/suspensión, incluso con soporte privilegiado | Pruebas de todas las RPC relacionadas y dos conexiones compitiendo; siempre >=1 admin activo en el tenant ya provisionado. Bootstrap de tenant nuevo conserva su flujo |
| Permisos siguen vigentes | Anon, gestor, actor suspendido, otro tenant y superadmin sin AAL2 denegados según contrato; superadmin autorizado conserva acciones válidas sin eludir último admin |
| Camino permitido no regresa | Nuevo manager, reinvitación del mismo rol como no-op y reactivación autorizada funcionan; sin duplicar membresía ni enviar correos reales |
| Reintentos/fallos no dejan cambio parcial | Dos invitaciones iguales/cambios concurrentes, fallo DB y retry mantienen estado íntegro; locks de upsert y suspensión con orden compatible |
| Despliegue futuro compatible | Migración nueva probada desde base vigente sintética; llamadas de frontend/Edge anteriores y nuevos siguen funcionando o rechazan con error previsto. No tocar migraciones aplicadas |
| Entrega revisable | Diff sólo de S01 y pruebas/preparación justificadas; checks pertinentes con resultados y fallos previos diferenciados; SHA y guía de reversión. Si falla autorización, no se considera cerrada |

La prueba AAL2 del camino de invitación se ejecuta en el handler con JWT verificado. Su RPC invocada con `service_role` debe revalidar actor/roles, pero una llamada administrativa directa no acredita MFA del usuario original. Diferenciar ambas evidencias en el resultado.

Reversión de T1: pausar invitaciones/gestión afectada mientras se corrige hacia adelante; conservar miembros existentes y el endurecimiento de permisos. No restaurar el upsert vulnerable para recuperar comodidad operativa. La base puede seguir atendiendo pedidos con sus flujos actuales si no están afectados. Esta tanda se implementará sólo tras la instrucción posterior del usuario; **hoy se entrega su definición y aceptación**.

## Validación obligatoria antes de activar stock

| Puerta | Qué debe estar ejecutado y registrado | Qué no la sustituye |
|---|---|---|
| V1 — Contrato y base | D01–D09 aplicables resueltas; B indispensables cerradas; instalación limpia y upgrade con datos sintéticos previos; frontend/Edge/esquema compatibles | Una hipótesis comercial, diff revisado o sólo build |
| V2 — Integridad/seguridad real | AC01–AC22 aplicables y condicionales acordadas con PostgreSQL real, permisos/RLS, dos conexiones y barreras, retries, fallo antes de commit y respuesta perdida después; conciliación de todos los saldos | Mocks, pruebas secuenciales o acciones con service_role para “probar” permisos |
| V3 — Integración operativa | Auth→Edge→RPC→UI y Storage pertinente en entorno aislado; operador ensaya apertura/corte, pedido/entrega, faltantes, devolución/corrección/reemplazo, salida externa, pausa y recuperación; smoke del build compilado | Los E2E conectados omitidos por defecto o smoke sólo del servidor de desarrollo |
| V4 — Capacidad y costo del piloto | Catálogo, pedidos, opciones, imágenes, historial y concurrencia del mayorista con margen acordado; latencias/errores/consumo reales, planes y recuperación verificados | El benchmark frontend simulado ni pruebas de 5.000 productos sin backend |
| V5 — Activación controlada | Corte físico validado, pendientes sin bypass, respaldo y restore ensayado, conciliación inicial, responsable de seguimiento y autorización expresa de producción | Una rama local o CI verde |

Fijar objetivos de latencia con el dispositivo/red reales; los valores sugeridos en la auditoría no son una promesa. La ausencia de movimientos negativos/duplicados, integridad transaccional y aislamiento de tenants no se negocian por rendimiento. Si hay límites de plan/capacidad, reducir el compromiso o reestimar antes de activar; no incorporar otro proveedor por defecto.

## Estimación del lanzamiento completo

Escenario de referencia **pendiente de confirmación**: un mayorista, unidad entera y un SKU por producto, sin reservas, entregas y devoluciones completas, app como fuente principal, otros canales registrados manualmente, sin integración externa ni reintegros monetarios. Se preservan arquitectura/servicios actuales. Incluye el mínimo de correcciones aplicables, stock, UI, reportes, conteo, pruebas y acompañamiento inicial; no es sólo la función de débito.

| Bloque sin doble conteo | Jornadas de trabajo orientativas |
|---|---:|
| Entorno aislado, baseline reproducible y cierre del contrato operativo | 3–5 |
| Correcciones indispensables del piloto, con pruebas propias | 8–13 |
| Modelo, migraciones incrementales, permisos y transacciones de stock | 8–12 |
| UI operativa, conteo/corte, ingresos/ajustes y ventas externas manuales | 5–8 |
| Correcciones/devoluciones completas, reemplazos y reportes coherentes | 4–7 |
| Integración real, concurrencia/fallos, capacidad del piloto, recuperación y lanzamiento acompañado | 5–8 |
| **Base total** | **33–53** |
| **Rango de planificación con ~20% de contingencia, redondeado** | **40–64** |

Cada bloque incluye sus pruebas unitarias/contratos; el último cubre integración transversal y ensayo operativo, sin sumar nuevamente esas pruebas. La tanda S01 de 3–5 jornadas forma parte de los dos primeros bloques. Una tarea L de **5–8 jornadas no representa el proyecto completo**. Son jornadas de esfuerzo de un desarrollador familiarizado, no días calendario ni cotización; esperas de decisiones/accesos, conteo físico del negocio y agenda de autorización se registran aparte. Reestimar tras la primera tanda y D01–D09 con evidencia del entorno. Si el piloto necesita ampliaciones de la tabla anterior, no queda cubierto por esta base automáticamente.

Mantener proveedores no demuestra mismo costo mensual. Antes de afirmarlo, registrar planes y condiciones reales de Supabase/Vercel, uso actual, cuotas/compute/disco/egress/funciones/Realtime/Storage, proyección con carga medida y margen, más backups/retención/recuperación disponibles. Sin esos datos, **costo mensual pendiente de verificación**; no hay upgrade ni compra autorizados. El mantenimiento residual comprende conciliación física, carga de otros canales, excepciones, actualización de dependencias y revisión de consumo; asignar responsables, sin prometer operación sin atención.

## Flujo Git, CI/CD y despliegue posterior

- Antes de cada etapa: revisar rama y cambios locales, actualizar referencias, preservar trabajo ajeno y continuar en rama de feature desde base vigente. Nunca trabajar directamente en `main`, descartar cambios ni forzar push. Si se acumulan objetivos, separarlos en commits/revisiones pequeñas.
- Revisar diff antes de cada commit; sólo fuentes, pruebas y documentación del objetivo. Sin secretos, datos de clientes ni temporales. Las migraciones nuevas son incrementales; no editar las aplicadas, resetear bases existentes ni usar una restauración destructiva como rollback de funcionalidad.
- CI versionada en `.github/workflows/ci.yml`: ejecuta en `pull_request` y `push` a `main`; quality (Node 22, npm ci, seguridad, lint, tipos, pruebas, Playwright, build, audit), pgTAP en Supabase local, Deno y Gitleaks. El reset de ese job es de su DB local desechable, no permiso para resetear otra base.
- No contiene comando de despliegue productivo, harness de concurrencia real ni integración completa conectada. Los E2E live se omiten por defecto y el smoke usa servidor de desarrollo. Añadir comprobaciones aisladas pertinentes al implementar, sin desactivar fallos para obtener verde; registrar resultados con SHA/versiones y conservar evidencia.
- `vercel.json` define rutas/headers, no confirma qué rama despliega. Revisar integración Git de Vercel, previews, rama productiva, secretos y protecciones antes de publicar: un push/PR puede disparar preview según configuración externa todavía no verificada. Vercel no aplica por sí solo las migraciones Supabase. Esta revisión queda **local, sin push ni despliegue**.
- Despliegue futuro: migración compatible en `never_enabled` → Edge/frontend compatibles → gates aislados → autorización expresa → corte del mayorista y activación controlada. Mantener funciones que protegen pedidos controlados aunque se revierta frontend. En contingencia usar `paused`, preservar datos y corregir hacia adelante. No merge a `main`, producción ni migraciones productivas sin autorización expresa.

## Verificación de esta entrega documental

Se preservó la auditoría/benchmark original en un commit y se revisan ambos documentos en otro objetivo. Verificado en esta entrega: diff limitado a los dos documentos respecto de `97c6a36`, `git diff --check` sin errores, estructura de tablas/bloques Markdown y seis enlaces locales válidos, revisión cruzada de decisiones/estados/estimación y `npm run security:check` sin hallazgos. No cambiaron los soportes del benchmark ni archivos funcionales. Los resultados históricos de tests/benchmark siguen identificados en la auditoría; **esta revisión no vuelve a ejecutarlos ni acredita stock implementado**. Las pruebas de DB real, concurrencia e integración descritas arriba son requisitos pendientes de la implementación posterior, no resultados obtenidos hoy.
