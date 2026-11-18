# Verificación de los cambios del backend · 17 de noviembre de 2026

La rama `codex/backend-hardening` contiene la implementación de la [auditoría](AUDITORIA_BACKEND_2026-11-17.md). La referencia de compatibilidad fue `e846d92db7e4aef920117b5f3e0b5472bd26e2ff`, junto con los cambios locales que ya estaban en el proyecto. El trabajo se probó en PostgreSQL 17.11 local, Deno, Node y Chromium. Producción sigue en su versión anterior.

## Aceptación con servicios conectados · 18 de noviembre de 2026

Pasaron los **cuatro casos conectados**, con cero fallos y cero omisiones, sobre el frontend compilado de la rama y un Mozzi Demo sintético. Se usó una base nueva con las 43 migraciones, PostgreSQL 17.11, PostgREST 14.18, Supabase Auth 2.197.0 y los handlers Deno originales. Un gateway local en loopback encaminó las solicitudes. Para ejecutar Auth en Windows se adaptó únicamente la apertura del socket. La verificación cubre estos servicios y esta rama, no la configuración de un despliegue alojado.

1. Navegación del menú al checkout con un producto conocido.
2. Creación de un pedido sintético por la Edge Function y recuperación de la misma confirmación al recargar.
3. Login real de un operador ordinario con una sola membresía activa y carga de la lista de pedidos del comercio.
4. El GET del enlace para tomar un pedido y su apertura en Chromium conservaron el estado y el historial del pedido.

El operador invitó un usuario de prueba desde el endpoint de la aplicación. El servidor SMTP local capturó un correo. Repetir la solicitud y solicitar un reenvío inmediato conservó esa cantidad. El enlace abrió el formulario de contraseña, el invitado inició sesión y su membresía pasó a activa. La entrega a un proveedor de correo externo queda sin medir.

Para pagos se usaron PostgreSQL y las funciones originales de creación, webhook firmado y consulta de estado. Un simulador HTTP local representó al proveedor. Los tres estados aprobado, pendiente y rechazado coincidieron con la consulta posterior y permanecieron estables al repetir el evento. **Falta una compra en Checkout Pro sandbox oficial** con comprador y vendedor de prueba para validar OAuth, el checkout del proveedor y un webhook recibido por HTTPS.

En el comercio publicado Mozzi Demo también se agregó un producto al carrito y se llegó al checkout usando solamente recursos públicos. No se generó ningún pedido, pago ni envío allí. La rama y las migraciones siguen pendientes de publicación. [Evidencia de la corrida](auditoria-backend-2026-11-17/aceptacion-conectada-2026-11-18.json).

## Cambios que afectan al cliente

| Operación | Comportamiento verificado |
| --- | --- |
| Volver de Mercado Pago | Dos compras en el mismo navegador conservan referencias distintas. Una URL con el identificador de A usa únicamente la referencia de A. Las referencias de la versión anterior siguen funcionando. El estado financiero se consulta al servidor. |
| Vencer y conciliar pedidos | Un recuento o bloqueo de inventario en un comercio puede posponer su reserva. Los demás comercios continúan. La RPC anterior sigue devolviendo un entero. El mantenimiento registra resultados por lote y agenda revisiones con distinta frecuencia según estado y antigüedad. Los pagos históricos siguen siendo reconciliables. |
| Vencimiento por WhatsApp | El job usa el vencimiento guardado en el pedido. Si una integración envía explícitamente `olderThanMinutes`, conserva su margen adicional. |
| Reemplazar o quitar una imagen | PostgreSQL comprueba referencias de comercio, categoría, producto y familia, incluidas variantes de tamaño y rutas antiguas. Una preparación de borrado impide reasignar la imagen mientras Storage borra los bytes. Los clientes antiguos que borran directamente pueden dejar un objeto pendiente de limpieza. |
| Guardar horarios o editar una familia | La base impide guardar un cierre total y una franja abierta para la misma fecha. Edición de familias y checkout coordinan sus locks. Las escrituras válidas conservan sus contratos. |
| Invitar o reenviar | La búsqueda por correo usa el índice del directorio. Primero se prepara la identidad, luego la transacción registra la membresía y el envío pendiente. El correo se solicita después del commit. Un error de SMTP permite reintentar desde Usuarios. Los reenvíos tienen límite de frecuencia y vuelven a comprobar rol, membresía y confirmación. Una identidad preparada antes de un fallo de negocio queda disponible para reintentar con el mismo correo. |
| Compartir un enlace | La vista previa obtiene solo sus campos públicos. Un despliegue con la base anterior usa la RPC histórica cuando PostgREST informa que falta la nueva. La visibilidad de comercio, categoría, familia y producto se sigue comprobando en SQL. |

Las operaciones financieras y de autorización permanecen transaccionales en PostgreSQL. El cliente de Mercado Pago encapsula transporte y errores del proveedor. El servicio de mantenimiento coordina el trabajo con tiempo acotado. La clase de invitaciones coordina Auth y los envíos pendientes. Las Edge Functions comparten el tipo de base, el límite de cuerpo de solicitud y el identificador de diagnóstico.

## Compatibilidad y regresión

Se reconstruyeron las 43 migraciones desde una base vacía con los esquemas administrados de Auth y Storage. En otra base se aplicaron primero las 39 anteriores, se insertaron datos sintéticos y después se aplicaron las cuatro nuevas.

- Las 63 RPC públicas preexistentes conservaron firma, nombres y valores predeterminados de argumentos, retorno, modo de seguridad y permisos de ejecución. Hay siete RPC adicionales. La comparación cubre el contrato SQL. Las pruebas funcionales cubren los cambios de comportamiento señalados arriba.
- En el ensayo de actualización coincidió el contenido completo de seis tablas de negocio con fixtures de comercios, categorías, familias, productos, perfiles y membresías. Una invitación histórica siguió figurando como enviada.
- Pasaron 30 suites SQL con 1.261 aserciones. Las pruebas con sesiones reales cubrieron 64 escenarios concurrentes, entre ellos checkout frente a expiración, edición de familia, asignación de imagen frente a limpieza, horarios incompatibles y doble reclamación de una invitación.
- Las pruebas operativas de Node cubren conexión a loopback, inventarios de archivos y mantenimiento. La integración de backup comprobó cinco escenarios con PostgreSQL real y un transporte de Storage simulado. Se restauró un dump tomado durante escrituras concurrentes. Los bytes de Storage se contrastaron con el inventario y sus checksums.
- Los tests de Chromium del servicio usan datos simulados. Los cuatro casos optativos con servicio conectado requieren un entorno con fixtures. El stack completo de Auth, PostgREST, Storage y Edge por HTTP está configurado en CI. Este host carece de Docker. El SMTP y Mercado Pago reales quedan fuera de la verificación local.

La corrida final pasó 585 pruebas de aplicación, 121 pruebas Deno, 12 pruebas operativas Node y 85 escenarios de Chromium. Pasaron el formato y lint de Edge, el lint del proyecto, el chequeo de tipos, el build, los presupuestos de transferencia y el control estático de seguridad. En Chromium con red móvil simulada y CPU ralentizada cuatro veces, el menú llegó a LCP en 2060 ms y la tienda en 2056 ms. La tarea inicial más larga de la tienda fue de 130 ms, con CLS 0. La primera apertura monta encabezado y catálogo en cuadros sucesivos. Se comprobó el recorrido con teclado, scroll, filtros y regreso desde un detalle. [Resultados de implementación](auditoria-backend-2026-11-17/resultados-implementacion.json).

## Publicación y vuelta a la versión anterior

1. Aplicar en staging con el mismo esquema y volúmenes representativos. Ejecutar la [comprobación previa de solo lectura](auditoria-backend-2026-11-17/preflight-implementacion.sql). Una fecha con cierre incompatible o dos identidades para un mismo correo requieren revisión del titular antes de migrar. Medir la duración del backfill y de la creación de índices y restricciones, que pueden bloquear escrituras. Elegir una ventana y usar un tiempo máximo de espera de locks acorde a esa medición.
2. Verificar la restauración del backup y registrar las versiones del frontend y de las funciones instaladas. El backup nuevo comparte snapshot entre los dumps y el inventario. Un reemplazo concurrente de un objeto puede impedir cerrar la copia hasta que exista una ventana estable.
3. Aplicar las cuatro migraciones en orden, actualizar las Edge Functions afectadas y publicar el frontend al final. Verificar en staging dos devoluciones de pago, un checkout, el acceso de un operador anterior, una invitación capturada por SMTP de pruebas, un reenvío, la limpieza de una foto compartida y el vencimiento de una reserva con otro comercio en recuento.
4. Comparar con el nivel habitual del cliente los errores y tiempos de checkout, los vencimientos pospuestos, los errores de conciliación y las invitaciones pendientes. Usar el identificador de solicitud para investigar errores de Edge.
5. Si falla una comprobación, detener la promoción de esa versión. El frontend y las Edge Functions anteriores pueden volver a publicarse sobre el esquema ampliado. Restaurar una base por encima de ventas posteriores al backup puede perder pedidos. La reversión de datos requiere un plan específico y una restauración ensayada en otra base.

## Alcance pendiente de evidencia externa

La auditoría npm detectó seis entradas de severidad alta en dependencias de desarrollo derivadas de un aviso de picomatch. En el árbol npm de producción reportó cero. La auditoría completa de CI conserva su criterio de fallo. El aviso consultado no identifica una versión corregida. [Aviso del mantenedor de la base de vulnerabilidades](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

Los tokens de consulta de pagos vencidos se purgan por lotes. Se conserva la idempotencia histórica y el token de evento de WhatsApp que puede necesitar una repetición de pedido. La revisión del catálogo sigue cambiando tras cada escritura observable. Agrupar todos los incrementos por transacción daría la misma revisión a dos contenidos distintos consultados dentro de esa transacción. Para decidir un cambio de ese contrato se necesitan mediciones de contención y tiempos de respuesta con el tráfico real del cliente.
