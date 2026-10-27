# Menú y tienda con catálogo compartido

El menú conserva `/r/:slug`; la tienda usa `/t/:slug`. Configuración permite publicar cada canal y elegir recepción permanente o por horario para la tienda. Productos, precios, inventario, marca y entrega local se comparten. Carritos, intentos y recuperación se separan por canal; las claves anteriores del menú conservan compatibilidad.

## Fichas y variantes

En Productos, las fichas agrupan SKU existentes o nuevos por atributos como modelo y color. Cada SKU conserva su UUID, código, precio, imagen y saldo. Las fichas no tienen stock propio. Los extras gastronómicos siguen separados de las variantes.

La importación acepta columnas opcionales `familia_codigo`, `familia_nombre` y hasta tres pares `atributo_1`/`valor_1`, `atributo_2`/`valor_2`, `atributo_3`/`valor_3`. Ejemplo: `Modelo`/`iPhone 15` y `Color`/`Negro`. Los archivos anteriores no desagrupan SKU; `skip_existing` conserva sus relaciones. El lote confirma productos y agrupaciones en una transacción. El snapshot del pedido conserva los atributos vendidos aunque luego se edite la ficha.

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

En modo `test`, el canje inicial OAuth solicita `test_token: true`; la renovación conserva el ambiente del token original. Mercado Pago puede omitir `live_mode` en la respuesta OAuth: únicamente en ese caso, el servidor completa el modo solicitado en el canje inicial y lo guarda junto con las credenciales cifradas. Las renovaciones usan ese modo persistido; un valor explícito contradictorio o de tipo inválido se rechaza. Una conexión anterior sin modo registrado requiere reconectarse, y cambiar `MERCADOPAGO_MODE` no reclasifica credenciales existentes. Los pagos consultados al proveedor siguen requiriendo `live_mode` explícito y coincidente para conciliarse. Usar vendedor y comprador de prueba distintos, ambos de Argentina, y sesiones separadas. El prefijo de un Access Token no permite determinar su ambiente. El modo pertenece al entorno completo: no cambiarlo mientras haya cobros de otro ambiente pendientes de conciliación. Ver [cuentas de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/test-accounts), [OAuth](https://www.mercadopago.com.ar/developers/es/docs/split-payments/additional-content/security/oauth/creation) y el [contrato de respuesta OAuth](https://github.com/mercadopago/openapi/blob/4bf7b8751434d29f5a1d9a2dfe498c69ce50d3cb/by-product/oauth/spec3.yaml#L201).

En la aplicación de Mercado Pago, habilitar OAuth con PKCE y registrar exactamente:

- Retorno OAuth: `https://<proyecto>.supabase.co/functions/v1/mercadopago-callback`.
- Webhook, evento **Payments**: `https://<proyecto>.supabase.co/functions/v1/mercadopago-webhook`.

Desplegar las tres migraciones `202610270001` a `202610270003`, actualizar `create-order` e `import-products` y desplegar `mercadopago-connect`, `mercadopago-callback`, `create-payment`, `payment-status`, `mercadopago-webhook` y `reconcile-payments`. Publicar después el frontend. Conectar una cuenta desde Medios de pago; habilitar primero un comercio de prueba con SKU y stock comprobados.

La [documentación de OAuth](https://www.mercadopago.com.ar/developers/es/docs/security/oauth/creation) y la [integración de Checkout Pro por vendedor](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/how-tos/integrate-marketplace) describen la configuración del proveedor. Las pruebas locales no reemplazan la vinculación y prueba final con la aplicación de Mercado Pago del entorno.

## Reserva, conciliación y devoluciones

El servidor calcula el total y reserva stock durante 30 minutos antes del checkout. La preferencia vence en el mismo momento. La UI muestra el total confirmado y pide una acción explícita antes de ir a Mercado Pago. Los retornos del navegador no acreditan dinero: se consulta el estado persistido con un token opaco de lectura, válido 30 días y sin datos personales en su respuesta.

Webhooks verificados consultan el pago al proveedor y comparan cuenta, referencia, moneda e importe. El pago aprobado conserva la reserva y queda pendiente de preparación; la aceptación humana no vuelve a reservar. Los movimientos automáticos tienen actor sistema. La entrega descuenta la existencia física.

Una aprobación tardía vuelve a intentar reservar; si no hay stock, queda para devolución y no puede prepararse. Pagos duplicados, disputas y reintegros parciales requieren revisión. Cancelar un pedido pagado libera su reserva y señala que falta reintegrar: **no devuelve dinero**. Los reintegros se realizan en Mercado Pago y llegan por conciliación. Reintegrar mercadería ya entregada no la repone automáticamente: la devolución física se registra en inventario.

Desactivar nuevos cobros conserva las credenciales privadas necesarias para conciliar compras anteriores. Cambiar de cuenta cobradora después de generar compras requiere revisión; reconectar la misma cuenta está permitido.

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

Se comprobaron los menús existentes, el catálogo de tienda, los metadatos Open Graph y el recorrido móvil de variantes, carrito y checkout contra producción. No se enviaron mensajes ni se generaron compras durante esa comprobación. La clave interna de cifrado está instalada y respaldada; faltan las credenciales de la aplicación de Mercado Pago y la autorización OAuth del vendedor para habilitar cobros.

El instalador de Cron detectó que los grants de `pg_net` no podían restringirse con el administrador del proyecto y revirtió la transacción sin guardar secretos ni jobs. Se retiraron las extensiones nuevas que no se usaron; el mantenimiento productivo debe ejecutarse con el workflow de GitHub indicado arriba.
