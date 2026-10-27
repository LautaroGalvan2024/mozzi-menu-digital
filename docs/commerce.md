# Menú y tienda con catálogo compartido

El menú conserva `/r/:slug`; la tienda usa `/t/:slug`. **Tienda online** en el panel permite marcar **Publicar mi tienda online**, elegir WhatsApp, Mercado Pago o ambos y guardar. Debajo aparecen el link y el QR. Se puede publicar con WhatsApp sin conectar Mercado Pago y recibir pedidos las 24 horas o respetar los horarios. Configuración conserva los controles anteriores de publicación. Productos, precios, inventario, marca y entrega local se comparten. Carritos, intentos y recuperación se separan por canal; las claves anteriores del menú conservan compatibilidad.

## Fichas y variantes

En Productos, las fichas agrupan SKU existentes o nuevos por atributos como modelo y color. Cada SKU conserva su UUID, código, precio, imagen y saldo. Las fichas no tienen stock propio. Los extras gastronómicos siguen separados de las variantes.

La importación acepta columnas opcionales `familia_codigo`, `familia_nombre` y hasta tres pares `atributo_1`/`valor_1`, `atributo_2`/`valor_2`, `atributo_3`/`valor_3`. Ejemplo: `Modelo`/`iPhone 15` y `Color`/`Negro`. Los archivos anteriores no desagrupan SKU; `skip_existing` conserva sus relaciones. El lote confirma productos y agrupaciones en una transacción. El snapshot del pedido conserva los atributos vendidos aunque luego se edite la ficha.

## Stock desde los productos

Al crear o editar un producto, **Stock (unidades)** guarda la cantidad total: escribir 10 deja 10 unidades, no suma 10. Cada variante tiene su propio campo. Cero indica agotado; dejar vacío conserva el saldo anterior, o deja sin inicializar un producto nuevo. Cambiar sólo el nombre, precio o foto no modifica cantidades. El total incluye las unidades reservadas: 10 totales y 2 reservadas dejan 8 disponibles. El servidor rechaza totales inferiores a las reservas.

Para un comercio nuevo, cargar las cantidades de sus productos y luego entrar a **Stock → Activar control de stock**. No requiere conteo general. Los pedidos ya aceptados reservan sus unidades al activar; si no alcanza el stock, toda la activación se revierte. Las ventas fuera de Mozzi deben registrarse también. Un comercio ya activo conserva su configuración. Las herramientas de conteo físico permanecen en **Herramientas avanzadas de inventario**; una pausa o un conteo en curso bloquean la edición de cantidades hasta resolverlos.

La migración `202610270005` agrega RPC de guardado atómico de catálogo y saldo, lectura de cantidades y activación. No cambia saldos ni activa comercios al instalarse. El navegador conserva el UUID y el contenido del intento antes de enviarlo; repetirlo recupera el resultado sin reponer unidades vendidas después. Ante cambios concurrentes, se exige revisar el saldo e ingresar nuevamente la cantidad. No borrar intentos pendientes ni retirar estas RPC durante una reversión del frontend.

Validación local reproducible: suites SQL (incluida `021_catalog_absolute_stock.sql`), pruebas de formularios y `e2e/catalog-stock-store.spec.ts`. `node scripts/database/local-test-catalog-stock-concurrency.mjs --database=mozzi_<base_sintetica>` prueba sesiones PostgreSQL simultáneas contra checkout, reserva y guardados repetidos; requiere el PostgreSQL local configurado y nunca una base restaurada o producción.

## Configuración de Mercado Pago

Checkout Pro usa la cuenta de cada comercio, moneda ARS y comisión de plataforma cero. El pago online requiere inventario activo, una cuenta conectada y la opción de cobro habilitada. La migración deja tienda y pagos desactivados para comercios existentes.

Configurar estas variables **solo en Edge**, mediante el almacén de secretos del entorno o el archivo privado `.env.edge.production`:

| Variable | Valor |
| --- | --- |
| `MERCADOPAGO_CLIENT_ID` | Client ID / APP_ID numérico de la aplicación; no es la Public Key |
| `MERCADOPAGO_CLIENT_SECRET` | Client Secret de esa aplicación; no es el Access Token |
| `MERCADOPAGO_ENCRYPTION_KEY` | 32 bytes aleatorios en base64url sin padding; guardar también en el respaldo privado |
| `MERCADOPAGO_WEBHOOK_SECRET` | Firma secreta de Webhooks de la aplicación |
| `MERCADOPAGO_MODE` | `test` para pruebas o `production` para cobros reales; producción es el default |

Las credenciales de cada vendedor se cifran con AES-GCM y se vinculan criptográficamente a su comercio. Cambiar la clave de cifrado sin recifrar los registros hace ilegibles las conexiones anteriores. El asistente preserva las variables de Mercado Pago existentes y mantiene separados los valores locales y productivos.

La aplicación de integración pertenece a Mozzi y se configura una sola vez por entorno. Cada comercio usa **Medios de pago → Conectar Mercado Pago** para autorizar su propia cuenta mediante OAuth; no carga claves técnicas ni requiere modificaciones manuales en la base de datos. El dinero se acredita en la cuenta del vendedor que autorizó esa conexión.

Medios de pago distingue **Modo prueba** de **Cobros reales** y muestra por separado el ambiente de la autorización actual. La cuenta sólo se presenta como lista si está activa, tiene credenciales válidas para el ambiente configurado y el servidor informa `readyForPayments=true`. Una autorización de prueba bajo un servidor de producción exige reconexión. Los clientes anteriores que todavía no informan el ambiente siguen siendo compatibles, pero la pantalla no anuncia que estén listos para cobrar. Estar autorizado no activa por sí solo el inventario ni la opción de pago de la tienda.

En modo `test`, el canje inicial OAuth solicita `test_token: true`; la renovación conserva el ambiente del token original. Mercado Pago puede omitir `live_mode` en la respuesta OAuth: únicamente en ese caso, el servidor completa el modo solicitado en el canje inicial y lo guarda junto con las credenciales cifradas. Las renovaciones usan ese modo persistido; un valor explícito contradictorio o de tipo inválido se rechaza. Una conexión anterior sin modo registrado requiere reconectarse, y cambiar `MERCADOPAGO_MODE` no reclasifica credenciales existentes. Los pagos consultados al proveedor siguen requiriendo `live_mode` explícito y coincidente para conciliarse. Usar vendedor y comprador de prueba distintos, ambos de Argentina, y sesiones separadas. El prefijo de un Access Token no permite determinar su ambiente. El modo global determina las nuevas autorizaciones y compras; la conciliación usa el ambiente de la conexión original de cada intento. Ver [cuentas de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/test-accounts), [OAuth](https://www.mercadopago.com.ar/developers/es/docs/split-payments/additional-content/security/oauth/creation) y el [contrato de respuesta OAuth](https://github.com/mercadopago/openapi/blob/4bf7b8751434d29f5a1d9a2dfe498c69ce50d3cb/by-product/oauth/spec3.yaml#L201).

En la aplicación de Mercado Pago, habilitar OAuth con PKCE y registrar exactamente:

- Retorno OAuth: `https://<proyecto>.supabase.co/functions/v1/mercadopago-callback`.
- Webhook, evento **Payments**: `https://<proyecto>.supabase.co/functions/v1/mercadopago-webhook`.

Desplegar las migraciones `202610270001` a `202610270004`, actualizar `create-order` e `import-products` y desplegar `mercadopago-connect`, `mercadopago-callback`, `create-payment`, `payment-status`, `mercadopago-webhook` y `reconcile-payments`. Publicar después el frontend. Conectar una cuenta desde Medios de pago; habilitar primero un comercio con SKU y stock comprobados.

La [documentación de OAuth](https://www.mercadopago.com.ar/developers/es/docs/security/oauth/creation) y la [integración de Checkout Pro por vendedor](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/how-tos/integrate-marketplace) describen la configuración del proveedor. Las pruebas locales no reemplazan la vinculación y prueba final con la aplicación de Mercado Pago del entorno.

### Transición de pruebas a cobros reales en el mismo comercio

El comercio, su catálogo, sus SKU y sus enlaces se conservan. No hay que crear otro comercio, copiar claves al panel ni eliminar la conexión anterior. `MERCADOPAGO_MODE` pertenece al servidor completo y sólo lo cambia el administrador de Mozzi; no es una preferencia editable por cada comercio.

1. Antes del cambio, detener nuevos pagos de prueba y revisar la conciliación, los pagos pendientes y las reservas. Conservar las credenciales y los pedidos existentes; no cancelar compras ni alterar existencias para forzar el cambio de ambiente.
2. Aplicar `202610270004`: cada intento queda vinculado a una conexión inmutable. Para conexiones previas, verificar el campo `liveMode` del contenido cifrado en el servidor y ejecutar `backfill_payment_account_environment` con ese ambiente; nunca inferirlo del modo actual ni del prefijo del token. Completar todas las conexiones desconocidas antes de desplegar las nuevas funciones. Invalidar los inicios OAuth anteriores, desplegar Edge y configurar `MERCADOPAGO_MODE=production`. Conservar la clave de cifrado y los demás secretos de la aplicación; verificar Webhooks y mantenimiento. Este paso no autoriza una cuenta ni convierte una autorización de prueba en productiva.
3. El administrador del comercio abre **Medios de pago**. La pantalla debe indicar **Cobros reales**; si la cuenta todavía figura como prueba, usa **Reconectar cuenta para cobros reales**, inicia sesión en Mercado Pago con la cuenta del comercio y otorga la autorización. No se completa el consentimiento en nombre del vendedor.
4. Al volver, verificar **Cuenta lista para cobros reales** y que la autorización actual figure como cobros reales. La nueva conexión pasa a ser la actual; la anterior conserva sus credenciales para conciliar sus pedidos. Cambiar de conexión desactiva los nuevos cobros hasta habilitarlos explícitamente. Una misma cuenta y ambiente no pueden pertenecer a dos comercios distintos.
5. En **Productos**, cargar existencias reales de cada SKU y activar el control desde **Stock** si todavía está sin activar. En **Tienda online**, publicar la tienda si corresponde, habilitar **Pagos online con Mercado Pago** y guardar. Las existencias ficticias del piloto deben regularizarse antes de ofrecer productos reales.
6. Comprobar el recorrido de compra autorizado, el total, la cuenta cobradora, la notificación verificada y la conciliación. Documentar fecha, versión y resultado sin registrar tokens ni credenciales. El regreso del navegador nunca confirma por sí solo el pago.

Los pagos anteriores siguen conciliándose con su conexión y ambiente originales, incluso después de cambiar el modo global. Sus enlaces de pago quedan ocultos en el ambiente nuevo, y un reintento de otra modalidad de ambiente se rechaza antes de reservar stock. Las renovaciones de credenciales históricas no reactivan cobros ni sustituyen la conexión actual. Una vuelta a modo prueba exige detener nuevos cobros y autorizar una conexión compatible; no basta con cambiar el texto de la pantalla.

## Reserva, conciliación y devoluciones

El servidor calcula el total y reserva stock durante 30 minutos antes del checkout. La preferencia vence en el mismo momento. La UI muestra el total confirmado y pide una acción explícita antes de ir a Mercado Pago. Los retornos del navegador no acreditan dinero: se consulta el estado persistido con un token opaco de lectura, válido 30 días y sin datos personales en su respuesta.

Webhooks verificados consultan el pago al proveedor y comparan cuenta, referencia, moneda e importe. El pago aprobado conserva la reserva y queda pendiente de preparación; la aceptación humana no vuelve a reservar. Los movimientos automáticos tienen actor sistema. La entrega descuenta la existencia física.

Una aprobación tardía vuelve a intentar reservar; si no hay stock, queda para devolución y no puede prepararse. Pagos duplicados, disputas y reintegros parciales requieren revisión. Cancelar un pedido pagado libera su reserva y señala que falta reintegrar: **no devuelve dinero**. Los reintegros se realizan en Mercado Pago y llegan por conciliación. Reintegrar mercadería ya entregada no la repone automáticamente: la devolución física se registra en inventario.

Desactivar nuevos cobros conserva las credenciales privadas necesarias para conciliar compras anteriores. Cambiar de cuenta cobradora o de ambiente crea o selecciona otra conexión; cada compra permanece vinculada a su conexión original. Reconectar la misma cuenta y ambiente renueva esa conexión sin reasignar pedidos.

## Contacto después del pago

La confirmación de un pago aprobado indica que el comercio se comunicará por WhatsApp al teléfono ingresado en el checkout. Si la compra se realizó fuera del horario de atención, el mensaje aclara que el contacto será al retomar la atención. Los pedidos cancelados, entregados, pendientes de pago o con devoluciones muestran indicaciones propias.

Pedidos incluye una acción de WhatsApp en la tabla, las tarjetas móviles y el detalle. Abre el chat del cliente con el nombre del comercio, el número de pedido y un borrador para revisar y enviar. En pedidos activos con pago online aprobado, el texto informa recepción y preparación; los demás estados usan un contacto neutral. Abrir el enlace no envía el mensaje, no acepta el pedido y no modifica el stock. La acción se oculta si el teléfono no tiene un formato internacional válido.

## Mantenimiento y activación

Se incluye `.github/workflows/payment-maintenance.yml`, desactivado hasta configurar la variable del repositorio `PAYMENT_MAINTENANCE_ENABLED=true`. Requiere los secretos `MOZZI_SUPABASE_URL` y `MOZZI_MAINTENANCE_SECRET` (el mismo `MAINTENANCE_SECRET` de Edge). Ejecuta conciliación y vencimiento en lotes de 10 cada cinco minutos. Configurar notificaciones de fallos de Actions y verificar una ejecución manual antes de habilitar cobros. La cadencia de GitHub puede demorarse: el backend siempre valida el vencimiento al comprar; el stock se libera al procesar mantenimiento.

Para otro scheduler, invocar `POST /functions/v1/reconcile-payments` con JSON `{"limit":10}` y header `x-maintenance-secret` leído desde su almacén seguro. No incluir secretos en URLs ni código. Revisar eventos `payment.webhook_failed`, `payment.reconciliation_failed` y respuestas de mantenimiento con error. Ajustar capacidad si el volumen supera los lotes del piloto. El mantenimiento de pedidos WhatsApp existente continúa separado.

### Scheduler dentro de Supabase

`scripts/database/configure-commerce-maintenance.mjs` instala el job `mozzi-commerce-reconcile` cada cinco minutos usando pg_cron, pg_net y Vault. Elegir **un solo scheduler**: antes de instalarlo, dejar `PAYMENT_MAINTENANCE_ENABLED` ausente o en `false` en GitHub y detener cualquier scheduler externo de ese endpoint. `--github-workflow-disabled` confirma esa revisión; el script no consulta la configuración remota de GitHub. Los jobs visibles de Cron que ya invoquen este endpoint con otro nombre bloquean la instalación.

Habilitar previamente las extensiones desde Integrations/Extensions del proyecto confirmado. El SQL equivalente, ejecutado una vez por un administrador, es:

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
-- Vault viene habilitado en Supabase; comprobar supabase_vault en pg_extension.
```

El instalador exige `--project-ref` y comprueba que coincida con `supabase/.temp/project-ref`, `VITE_SUPABASE_URL` de `.env.local` y el host/usuario devueltos por `linkedDatabaseEnvironment`. Lee `MAINTENANCE_SECRET` únicamente desde `.env.edge.production`; debe coincidir con el secreto ya desplegado en Edge. `PG_BIN` proviene del entorno o de `.env.database.local`. Se ejecuta desde la raíz del repositorio:

```text
node scripts/database/configure-commerce-maintenance.mjs --project-ref=<ref>
node scripts/database/configure-commerce-maintenance.mjs --project-ref=<ref> --apply --github-workflow-disabled
```

El primer comando valida archivos locales sin conectar. El segundo realiza una transacción: restringe permisos sobre `net.http_request_queue`, `vault.secrets`, `vault.decrypted_secrets` y escritores de Vault; verifica acceso efectivo de `anon` y `authenticated`; crea o actualiza el secreto dedicado `mozzi-commerce-maintenance-<ref>`; y crea o actualiza el mismo job. No cambia propietarios, permisos de esquemas completos ni otros jobs. Una colisión de nombre con objetos no administrados por este script aborta la operación. El secreto entra como datos de `COPY` por stdin, sin literal SQL, argumentos de proceso, archivos temporales o salida de diagnóstico.

El comando de Cron contiene solamente `select private.invoke_commerce_maintenance();`. Esa función pertenece a `postgres`, usa `SECURITY DEFINER` con `search_path` vacío y deniega ejecución a `PUBLIC`, `anon`, `authenticated` y `service_role`. Lee Vault al ejecutar y encola un POST HTTPS al proyecto verificado, con lote 10 y timeout de 60 segundos. El instalador no invoca la función: la primera solicitud se genera en el próximo intervalo de Cron.

La [guía oficial de scheduling](https://supabase.com/docs/guides/functions/schedule-functions) advierte que pg_net mantiene el header descifrado mientras espera en `net.http_request_queue`. Por eso se verifica también la cola y se rechazan lectores directos adicionales a los roles administrados conocidos de Supabase. Esos roles administrativos siguen siendo de confianza. Los [grants de extensiones pueden pertenecer a `supabase_admin`](https://supabase.com/kb/troubleshooting/revoking-privileges-on-storage-pg_cron-vault-and-extension-objects-has-no-effect), de modo que un REVOKE puede no eliminar el acceso. Si la verificación devuelve `UNSAFE_PRIVILEGES`, la transacción revierte sin guardar el secreto ni activar el job; revisar con Supabase o usar el workflow externo. No ignorar ese control ni ampliar la lista de roles confiables para evitar el error.

Otros diagnósticos seguros: `MISSING_EXTENSIONS` exige habilitar las extensiones; `PROJECT_MISMATCH`/`DATABASE_MISMATCH` exige corregir el enlace y la URL; `OBJECT_COLLISION`/`DUPLICATE_SCHEDULER` exige revisar objetos existentes. No se muestran errores SQL completos. Tras un corte de conexión al confirmar, repetir el mismo comando verifica o actualiza el job sin duplicarlo. Para rotar el secreto, desplegar el nuevo valor en Edge y volver a ejecutar el instalador con el mismo ref.

Verificar una ejecución en `cron.job_run_details` y su respuesta en `net._http_response`: un job exitoso confirma que **encoló** la solicitud, no que Edge la procesó correctamente. No exportar headers de la cola ni consultas a `vault.decrypted_secrets` para diagnosticar. Vigilar los eventos `payment.maintenance`/`payment.maintenance_failed` de Edge y las respuestas HTTP fallidas. [pg_net documenta las respuestas y su retención](https://supabase.com/docs/guides/database/extensions/pg_net). Si se vuelve al scheduler externo, desactivar primero este job con `select cron.alter_job((select jobid from cron.job where jobname='mozzi-commerce-reconcile' and username=current_user), active := false);`.

## Verificación

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run security:check`.
- Dentro de `supabase/functions`: `deno task check`, `deno lint`, `deno fmt --check`, `deno task test`.
- Supabase local: `supabase db reset --local` y `supabase test db`. SQL017, SQL018 y SQL019 cubren publicación, variantes, cobros, reservas, devoluciones y permisos.
- El sustrato PostgreSQL nativo admite `node scripts/database/local-test-commerce-concurrency.mjs --database=mozzi_<base_aislada>`. Verifica conflictos reales con dos sesiones y datos sintéticos: reintentos, última unidad y aprobación simultánea con vencimiento.
- `node --test scripts/database/configure-commerce-maintenance.test.mjs` verifica los guardas del instalador sin conectarse a servicios.
- Con el cluster PostgreSQL local activo, `node scripts/database/local-test-maintenance-installer.mjs` crea y elimina una base descartable con extensiones simuladas sin HTTP; prueba instalación, rotación, permisos y rollback. No valida la configuración de extensiones del proyecto remoto.

Antes de habilitar cobros reales, verificar la aplicación del proveedor, el scheduler y el comercio piloto. El código no publica tiendas ni conecta cuentas automáticamente durante la migración.

## Piloto de producción, 27 de octubre de 2026

Se aplicaron las tres migraciones al proyecto `coqkgyaekenxccbxlozo`, se publicaron las 13 funciones y se desplegó el frontend en `https://mozzi-menu-digital.vercel.app`. El despliegue CLI verificado es `dpl_A1FWhYM7YeZZmwZhj8At4qwZFdK5`. `.vercelignore` excluye archivos de entorno, herramientas y respaldos; conserva `src/lib/supabase/client.ts`.

`scripts/catalog-seed/seed-commerce-pilot.sql` creó `mozzi-tienda-demo`, con los dos administradores vigentes de Mozzi Demo, retiro, tienda 24 horas y WhatsApp. La familia “Funda de silicona” tiene cuatro variantes y diez unidades ficticias por variante. La activación utilizó el recuento inicial de inventario. El script identifica su propio piloto y no repone stock en reejecuciones. Los dos comercios anteriores mantienen su configuración; los 22 pedidos previos y los cuatro usuarios Auth permanecieron sin cambios.

En la primera comprobación se revisaron los menús existentes, el catálogo de tienda, los metadatos Open Graph y el recorrido móvil de variantes, carrito y checkout contra producción, sin generar compras ni enviar mensajes. Posteriormente se configuraron las credenciales de la aplicación, se autorizó la cuenta del vendedor por OAuth en modo prueba y el usuario completó un pago de prueba. Esa aprobación confirma el recorrido de prueba; no equivale a habilitar cobros reales. La clave interna de cifrado permanece instalada y respaldada.

El instalador de Cron detectó que los grants de `pg_net` no podían restringirse con el administrador del proyecto y revirtió la transacción sin guardar secretos ni jobs. Se retiraron las extensiones nuevas que no se usaron. El mantenimiento quedó configurado con el workflow de GitHub indicado arriba, con su variable de habilitación activa y una ejecución exitosa verificada.

La versión que distingue el ambiente de plataforma y el de la autorización prepara la transición del mismo comercio a producción. El cambio de modo y el nuevo consentimiento del vendedor son pasos separados que deben registrarse después de ejecutarse; esta documentación no acredita su finalización.
