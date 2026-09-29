# Operación

## Accesos y separación de funciones

| Rol | Operación habitual | No puede |
|---|---|---|
| Super Admin | Crear/suspender restaurantes, invitar administradores, revisar auditoría global | Actuar sin MFA en acciones críticas, autorizarse por nombre/correo |
| Restaurant Admin | Configuración, catálogo, imágenes, importación, pedidos y miembros permitidos | Acceder a otro restaurante |
| Order Manager | Ver, tomar, completar/cancelar e historiar pedidos propios | Cambiar precios, catálogo, pagos, horarios, configuración o usuarios |
| Cliente | Ver menú, crear pedido por la Edge Function y abrir WhatsApp | Consultar tablas, pedidos o datos administrativos |

Usá una cuenta individual por persona. Nunca compartas el acceso Super Admin.

## Bootstrap inicial del Super Admin

Este procedimiento se ejecuta una sola vez por entorno:

1. En Supabase Dashboard, enviá una invitación al correo real de Lautaro Galván. No crees una contraseña fija ni la envíes por otro canal.
2. Completá la invitación, definí una contraseña fuerte y confirmá el correo.
3. Ejecutá `npm run setup:project`; el asistente solicita la clave con entrada oculta, genera `.env.bootstrap` y verifica que Git lo ignore.
4. Confirmá el bootstrap cuando el asistente lo ofrezca. Si preferís ejecutarlo después, usá:

   ```powershell
   npm run bootstrap:superadmin
   ```

   También podés pasar `--email correo@dominio` para sobreescribir la variable. El script busca una coincidencia exacta, hace upsert del perfil, asigna `super_admin` y registra auditoría sin imprimir la clave.
5. Confirmá la eliminación de `.env.bootstrap` después de un bootstrap correcto, o eliminá el archivo cuando ya no sea necesario.
6. Iniciá sesión, enrolá TOTP y guardá los códigos de recuperación en un gestor seguro.
7. Cerrá sesión, volvé a ingresar y comprobá que crear/suspender un restaurante falla en `aal1` y funciona después del challenge `aal2`.

Si el script informa que el rol se asignó pero la auditoría falló, corregí la base y ejecutalo otra vez. El upsert es repetible; no intentes reparar el rol desde el frontend.

## Crear el primer restaurante

1. Ingresá como Super Admin con `aal2`.
2. Abrí **Super Admin > Restaurantes > Nuevo**.
3. Completá slug, marca, WhatsApp E.164, dirección, zona horaria, moneda, modalidades, mínimo y preparación.
4. Indicá nombre y correo del administrador.
5. Confirmá una sola vez. La Edge Function administra reintentos y evita duplicados.
6. Verificá el evento de auditoría y el estado de la membresía.
7. El administrador acepta el correo, define su contraseña y activa TOTP si la política del restaurante lo requiere.
8. Antes de publicar: cargá horarios, excepciones, medios de pago, zonas, categorías y productos; después activá el restaurante y el menú público.

Si el correo ya existe, la operación debe asociar la membresía sin crear otro usuario. No diagnostiques existencia de usuarios a una persona no autorizada.

## Invitar personal

Desde **Admin > Usuarios** o la vista Super Admin:

1. elegí el restaurante desde la sesión, no por un ID pegado;
2. asigná el rol mínimo: un Restaurant Admin solo puede invitar `order_manager` de su propio tenant; crear otro `restaurant_admin` queda reservado al Super Admin con `aal2`;
3. enviá invitación;
4. comprobá membresía `invited` y luego `active`;
5. revisá auditoría.

Para retirar acceso, suspendé la membresía. Si la persona deja la organización, revocá también sesiones desde Auth según el alcance. No borres pedidos ni eventos asociados.

## Suspender o reactivar un restaurante

Solo Super Admin:

1. capturá el motivo operativo en el ticket/incidente externo;
2. cambiá el estado a `suspended` mediante la operación controlada;
3. verificá que el menú público ya no se proyecte y no acepte pedidos;
4. confirmá que los datos históricos siguen disponibles solo para actores autorizados;
5. revisá auditoría;
6. para reactivar, comprobá horarios, pagos, WhatsApp y membresías antes de volver a `active`.

## Guardar horarios y productos

La pantalla de horarios envía turnos regulares, excepciones y bajas a `save_restaurant_hours`. La RPC reemplaza primero las filas incluidas dentro de la misma transacción, por lo que mover o intercambiar turnos no choca con los índices únicos. Un cierre completo debe ser la única excepción de esa fecha. La pantalla de producto envía producto, grupos, opciones y bajas lógicas a `save_product_catalog`. Cada RPC valida tenant y referencias y confirma todo el conjunto o nada; si falla, recargá antes de reintentar y no repares filas manualmente desde Studio.

Las imágenes son la excepción al límite transaccional: Storage no participa de la transacción PostgreSQL. Una imagen nueva se procesa y sube antes de asociarla; después de guardar se intenta limpiar la anterior. Si falla el guardado, la UI intenta retirar la subida no asociada. Todos esos borrados son best-effort y pueden requerir reconciliación manual.

## Importar catálogo

La plantilla versionada está en `public/templates/importacion-productos.xlsx` y contiene `Productos`, `GruposOpciones`, `Opciones` e `Instrucciones`, con validaciones.

1. Usá códigos estables, no nombres, para reconciliar actualizaciones.
2. Expresá precios como números en la moneda del restaurante, sin símbolo ni separador de miles.
3. Usá `true`/`false`, fechas ISO y límites `minimo`/`maximo` enteros entre 0 y 20, con máximo no menor que mínimo.
4. Si hay ZIP, `imagen_archivo` debe coincidir exactamente, no puede empezar con `/` o `\` ni contener un segmento `..`. Solo JPEG, PNG o WebP; cada original puede pesar hasta 15 MB y el resultado reprocesado no supera 1 MiB.
5. Revisá la vista previa y los errores de prevalidación por fila. El navegador valida columnas obligatorias, tipos, fechas, duplicados y referencias entre productos, grupos y opciones; no confirmes con errores críticos.
6. Elegí de forma explícita `create_only`, `create_or_update` o `skip_existing`; la reconciliación usa el código dentro del tenant. `create_only` enumera todos los códigos ya existentes detectados y no escribe el lote. `skip_existing` deja intactos producto, categoría, grupos, opciones e imagen de cada código existente, y todavía crea el grafo completo de los códigos nuevos.
7. Verificá resumen, auditoría y assets fallidos. La metadata se confirma antes de subir imágenes: si una falla, descargá el CSV de errores y usá **Reintentar imágenes**; no hace falta repetir la importación de productos. El reintento actual recorre todas las imágenes no omitidas referenciadas por ese lote, incluidas las que ya habían terminado bien, y reemplaza sus assets.

La planilla puede pesar hasta 10 MB y la solicitud JSON a la Edge Function hasta 2 MiB. El lote admite 500 productos, 2.500 grupos y 10.000 opciones. El ZIP opcional admite 100 MB comprimidos, 250 MB extraídos acumulados y, como máximo, una imagen referenciada por producto. Dividí archivos grandes antes de alcanzar cualquiera de esos límites. Un CSV importa solo productos; usá XLSX para grupos y opciones.

El CSV reúne errores de prevalidación, conflictos `create_only`, errores estructurados de Edge/RPC y fallos de imágenes. La pantalla muestra código, campo y fila cuando el servidor puede determinarlos; una respuesta no estructurada conserva un mensaje genérico sin exponer internals. Las celdas peligrosas para planillas se neutralizan al exportar.

## Operar pedidos

- `generated`: existe en base; todavía no es una venta.
- `whatsapp_opened`: el cliente intentó abrir WhatsApp; tampoco prueba envío.
- `accepted`: un operador autorizado lo reconoció.
- `completed`: terminó la operación.
- `cancelled`: terminal y con motivo.
- `expired`: no fue tomado dentro de la ventana.

Para tomar un pedido, abrir el link, iniciar sesión si corresponde, revisar y pulsar **Tomar pedido**. Nunca interpretes una vista previa o carga del link como aceptación. Si otra persona ganó, la UI muestra actor y hora y no los reemplaza.

Para cancelar, escribí un motivo operativo no sensible. Para completar, verificá primero entrega/retiro. No edites campos `*_by` o `*_at` manualmente.

## Exportar historial

1. Aplicá restaurante, fechas y filtros mínimos necesarios.
2. Generá CSV desde la acción autenticada.
3. Guardalo en un destino aprobado con acceso restringido.
4. No lo adjuntes a tickets o chats sin protección: contiene PII.
5. Eliminá copias locales según la política de retención.

La exportación no debe ser una URL pública ni quedar cacheada por un service worker.

## Logs, auditoría y alertas

Revisá de manera periódica:

- Edge Function logs por código de error, 429, latencia y fallos de CORS;
- Auth logs por invitaciones, recuperaciones y MFA;
- `audit_logs` por altas, roles, suspensiones, importaciones y transiciones críticas;
- `order_events` para reconstruir incidentes de un pedido;
- consumo de Postgres, egress, Storage, Realtime y Function invocations;
- rebotes y reputación del SMTP.

No copies payloads con PII ni Authorization headers a un sistema de observabilidad. Configurá alertas por tendencia, no registrando secretos.

## Mantenimiento

### Expirar pedidos

Ejecutá la operación server-side preparada para expirar pedidos viejos mediante un scheduler confiable. Protegela con `MAINTENANCE_SECRET`, usá lotes acotados y revisá eventos. Nunca actualices estados desde un job con SQL ad hoc no auditado.

El repositorio no activa un cron remoto por defecto: hacerlo obligaría a elegir un scheduler y un almacén de secretos del entorno. Configurá un job que haga `POST` a `expire-orders`, tome `x-maintenance-secret` de su secret store y envíe `olderThanMinutes`/`limit`. No pongas el secreto en una URL, SQL versionado ni historial de shell. Alertá por fallo y comprobá el conteo devuelto; la RPC escribe un evento por pedido expirado.

### Tokens y rate limits

`cleanup_rate_limits` permite retirar ventanas de rate limit antiguas desde un contexto `service_role`. Los tokens de evento vencidos y la idempotencia administrativa todavía no tienen un job de borrado versionado: `expire-orders` no los elimina. Antes de automatizar esa retención, agregá una migración/RPC server-side auditable y un scheduler con lotes acotados. Solo deben eliminarse datos auxiliares vencidos; los eventos de pedidos permanecen.

### Assets huérfanos

Quitar una imagen desde Marca o Producto primero elimina su referencia de negocio y después intenta borrar el objeto de Storage y marcar `image_assets.deleted_at`. Reemplazarla sigue el mismo cleanup sobre la ruta anterior. La interfaz informa fallos conocidos, pero las llamadas son best-effort: puede quedar un objeto sin referencia o metadata activa para un archivo ya borrado.

No existe un barrido automático de assets huérfanos. Ejecutá `list_orphan_image_assets(restaurant_id)` desde una sesión administradora autorizada para obtener un inventario read-only y tenant-scoped. La RPC distingue:

- `pending_storage_delete`: metadata con baja lógica cuyo objeto todavía existe;
- `missing_storage_object`: metadata activa sin objeto;
- `unreferenced_asset`: objeto y metadata activos sin referencia de negocio;
- `unregistered_storage_object`: objeto del tenant sin fila en `image_assets`.

Revisá cada resultado contra `restaurants`, `categories` y `products` antes de corregirlo. La RPC no borra ni marca nada; no ejecutes borrados recursivos por prefijos no validados.

## Retención

La primera versión no elimina automáticamente pedidos ni auditoría. La configuración operativa prevista es:

| Recurso | Política actual | Parámetro futuro a aprobar |
|---|---|---|
| Pedidos, ítems y timeline | Conservación indefinida; acceso mínimo | `orders_retention_days`, definido con asesoramiento legal y exportación previa |
| Auditoría | Conservación indefinida y append-only | `audit_retention_days`, nunca menor que obligaciones contractuales |
| Tokens de evento vencidos | Elegibles para limpieza server-side | margen posterior al vencimiento, por ejemplo 24 horas |
| Ventanas de rate limit | `cleanup_rate_limits` admite borrar ventanas antiguas | frecuencia del scheduler y umbral; default técnico de 2 días |
| Idempotencia administrativa | Se conserva para reintentos | ventana por operación y migración de limpieza antes de automatizar |
| Metadata de assets y posibles huérfanos | Cleanup interactivo best-effort; inventario read-only disponible; sin barrido automático | período de gracia, revisión y job server-side antes de automatizar |
| CSV exportados | Fuera del control de la app | plazo del repositorio seguro del operador |

Antes de activar borrado automático: aprobar plazos por jurisdicción/contrato, crear una migración y job auditables, probar backup/restauración y ejecutar primero en modo reporte. Cambiar un pedido a `expired` no cumple una solicitud de borrado.

## Backup y recuperación

- Confirmá diariamente el estado de backups del plan de Supabase.
- Si el negocio necesita un RPO menor, habilitá Point-in-Time Recovery.
- Probá trimestralmente una restauración en un proyecto aislado.
- Registrá RPO/RTO observado, integridad de pedidos, Auth, Storage y secretos que deban recargarse.
- Los objetos de Storage requieren una estrategia de copia acorde al plan; un backup de Postgres no garantiza recuperar archivos.

Ante corrupción, detené escrituras, preservá evidencia y restaurá a un entorno aislado. No promociones una restauración hasta ejecutar pruebas RLS y un smoke test completo.

## Rotación e incidentes

- Rotá `RATE_LIMIT_HASH_SECRET` y `MAINTENANCE_SECRET` por incidente o calendario. La rotación del primero corta continuidad con hashes anteriores.
- Rotá claves administrativas inmediatamente si pudieron aparecer en Git, logs, Vercel o una terminal compartida. Creá primero una secret key nombrada, mantené la anterior activa, ejecutá `npm run setup:project -- -SupabaseSecretKeyName nombre_nuevo`, cargá los secretos Edge y validá una operación real antes de revocar la anterior.
- Revocá sesiones y factores comprometidos desde Auth.
- Volvé a desplegar funciones solamente si también cambió el código; un cambio de secretos se aplica sin redeploy. Después de revocar, repetí el smoke test y verificá que la clave anterior ya no figure activa.
- Conservá auditoría y una línea temporal del incidente.

Ver [seguridad](./security.md) para el procedimiento completo de respuesta y [deployment](./deployment.md) para reconstrucción.
