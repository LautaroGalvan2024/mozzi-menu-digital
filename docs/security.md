# Seguridad

## Objetivos

1. Aislar restaurantes incluso ante solicitudes manipuladas.
2. Mantener secretos y capacidades administrativas fuera del navegador.
3. Evitar que un enlace, crawler o `GET` cambie el estado de un pedido.
4. Calcular importes y validar disponibilidad en servidor.
5. Reducir PII en URLs, logs, auditoría y telemetría.
6. Conservar trazabilidad sin permitir reescritura del historial.

## Amenazas principales

| Amenaza | Control principal | Control complementario |
|---|---|---|
| Acceso cruzado entre restaurantes | RLS basada en membresía y claves foráneas compuestas | Pruebas pgTAP de tenant A contra tenant B |
| Clave administrativa expuesta | Solo Edge Functions y script local | Secret scan, variables `VITE_*` restringidas y revisión de logs |
| Manipulación de precio/total | Relectura y cálculo transaccional en PostgreSQL | Snapshots y aritmética entera |
| Abuso de creación pública | HMAC de IP, límites por IP/teléfono/restaurante, honeypot e idempotencia | Turnstile opcional y límites de payload |
| Toma automática por preview de WhatsApp | El `GET` solo muestra; la mutación exige clic + sesión | UUID aleatorio y RPC atómica |
| Escalada de Super Admin | Rol en tabla protegida y `aal2` | TOTP obligatorio en el flujo y auditoría |
| Archivo malicioso o fuga EXIF | Tipos permitidos, canvas/WebP, tamaño y ruta validados | Storage RLS; SVG prohibido |
| XSS/carga de contenido activo | React escapa texto y no se usa HTML suministrado | CSP, `nosniff` y límites de entrada |
| Duplicados por reintento | `unique (restaurant_id, idempotency_key)` | Respuesta idempotente y correlativo atómico |

## Secretos y variables

### Visibles en navegador

Solo se admiten:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_APP_BASE_URL
VITE_TURNSTILE_SITE_KEY
```

Todas las variables `VITE_*` se incorporan al bundle. La publishable key y la site key de Turnstile no son secretos; la primera solo es segura junto con RLS, grants y RPC acotadas. `VITE_TURNSTILE_SITE_KEY` se omite cuando el control anti-spam está desactivado.

### Edge Functions

Se cargan con `supabase secrets set` y nunca se versionan:

```text
APP_BASE_URL
APP_ALLOWED_ORIGINS
APP_SECRET_KEY_NAME
RATE_LIMIT_HASH_SECRET
MAINTENANCE_SECRET
TURNSTILE_ENABLED
TURNSTILE_SECRET_KEY
```

`RATE_LIMIT_HASH_SECRET` y `MAINTENANCE_SECRET` requieren al menos 32 bytes aleatorios. Turnstile es opcional: `TURNSTILE_ENABLED=true` exige `TURNSTILE_SECRET_KEY` en Edge y `VITE_TURNSTILE_SITE_KEY` en el frontend. En ese modo el token del widget se verifica obligatoriamente en `create-order`; una comprobación solo en navegador no tiene valor de seguridad. Con el flag falso o ausente, Edge no verifica Turnstile aunque exista una secret residual, por lo que las tres variables deben administrarse como una configuración coherente. Supabase inyecta sus variables administrativas en el runtime; no se copian a Vercel.

El contrato moderno inyectado usa `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` y `SUPABASE_SECRET_KEYS`. La publishable key se lee desde `default`; la secret key se lee exclusivamente desde la entrada nombrada por `APP_SECRET_KEY_NAME`, cuyo formato permitido es `^[a-z_][a-z0-9_]{3,63}$`. La selección falla si el nombre o la entrada no existen. No hay fallback a `SUPABASE_ANON_KEY` ni `SUPABASE_SERVICE_ROLE_KEY`, y ninguna variable reservada `SUPABASE_*` se escribe en archivos de entorno.

### Bootstrap local

`.env.bootstrap` contiene temporalmente `SUPABASE_URL`, `SUPABASE_SECRET_KEY` y `SUPER_ADMIN_EMAIL`. Git lo ignora. El script se niega a ejecutar en CI o Vercel, no imprime claves y recorre Auth hasta encontrar exactamente una coincidencia. Conviene eliminar el archivo después del bootstrap y rotar la clave si se sospecha exposición.

## Auth y MFA

La configuración local versionada establece:

- registro público global y acceso anónimo desactivados, con el proveedor email habilitado para que los usuarios existentes puedan iniciar sesión;
- invitaciones administrativas como alta normal;
- contraseña mínima de 12 caracteres con mayúsculas, minúsculas, números y símbolos;
- confirmación de correo, rotación de refresh token y cambio seguro de contraseña;
- enrolamiento y verificación TOTP.

Estos valores de `supabase/config.toml` aplican al stack local. En un proyecto remoto deben repetirse y comprobarse en el Dashboard. El proveedor de correo incluido es para pruebas y bajo volumen; producción necesita SMTP propio con SPF, DKIM y DMARC.

El frontend puede usar la sesión para UX, pero no decide autorización. Un Super Admin sin `aal2` no puede ejecutar acciones críticas aunque fuerce la ruta o el request.

## RLS y funciones SQL

- Todas las tablas del esquema expuesto tienen RLS habilitada.
- `anon` no recibe lectura ni inserción sobre `orders`.
- Los helpers de membresía viven en `private`, usan `search_path` fijo y no se exponen para ejecución arbitraria.
- Las funciones `SECURITY DEFINER` califican tablas, fijan `search_path`, validan `auth.uid()` y reciben solo IDs imprescindibles.
- `restaurant_id` del navegador nunca prueba membresía.
- En `restaurants`, RLS decide la fila y los grants por columna más un trigger deciden el campo: el administrador del tenant no puede cambiar estado, slug, prefijo ni procedencia.
- La lectura de perfiles compartidos exige que el actor tenga perfil activo además de membresía administrativa activa; un perfil desactivado solo conserva lectura de sí mismo.
- Las RPC revocan primero `EXECUTE` de `PUBLIC`, `anon`, `authenticated` y `service_role`, y después aplican una allowlist exacta por actor. El privilegio global por defecto del owner también está revocado, de modo que una función futura nace cerrada hasta recibir un grant explícito.
- Eventos, auditoría y campos de actor de pedidos no tienen CRUD libre desde la UI.

La [matriz RLS](./rls-matrix.md) detalla cada recurso. RLS no sustituye validaciones de negocio; ambas capas son necesarias.

## Storage

El bucket `restaurant-assets` contiene solo imágenes destinadas a ser públicas. La ruta empieza por `restaurants/{restaurant_id}/...`.

- lectura pública solo del bucket de assets;
- escritura y eliminación para `restaurant_admin` del tenant o Super Admin;
- `order_manager` sin escritura;
- validación de carpeta, MIME y tamaño;
- JPEG, PNG y WebP; SVG no admitido;
- imagen reprocesada en canvas, sin original ni EXIF, máximo 1200 px y 1 MiB;
- metadata en `image_assets` y baja lógica para detectar huérfanos.

Un bucket público nunca debe almacenar comprobantes, documentos ni información de clientes. Quitar o reemplazar logo, portada o imagen de producto elimina primero la referencia canónica y luego intenta borrar el objeto y marcar su metadata. Es un cleanup best-effort fuera de la transacción PostgreSQL: la UI informa fallos conocidos, pero un corte puede dejar un objeto o registro huérfano. `list_orphan_image_assets` solo genera un inventario de inconsistencias del tenant autorizado; no hay borrado ni barrido automático.

## Edge Functions

Las funciones privadas verifican el bearer token con Supabase Auth antes de crear un cliente administrativo. La mera decodificación local del JWT no alcanza. Las públicas también validan origen y contenido; CORS no se trata como autenticación.

Controles comunes:

- `POST` y `OPTIONS` solamente para operaciones mutables;
- allowlist exacta de orígenes HTTPS, más loopback en desarrollo;
- sin `Access-Control-Allow-Origin: *`;
- esquemas Zod, tamaños y timeouts;
- verificación server-side de Turnstile cuando `TURNSTILE_ENABLED=true`;
- respuestas con código estable y mensaje sanitizado;
- sin JWT, headers de autorización, payload completo, IP cruda ni token de evento en logs;
- cliente administrativo creado después de autorizar cuando la función es privada.

La IP usada para rate limit se normaliza con HMAC-SHA-256 y un secreto server-side. Los contadores de IP, teléfono y restaurante se actualizan mediante una RPC `service_role` antes de crear el pedido, por lo que sobreviven a un rechazo posterior y no pueden evadirse forzando un rollback. Cambiar el secreto invalida la continuidad de buckets anteriores, pero no revela IPs.

### Importación masiva

La validación del navegador es solo UX: la Edge Function vuelve a comprobar JWT, tenant, rol, esquema, cardinalidad y tamaño; la RPC valida relaciones y aplica la metadata en una transacción. `create_only` enumera conflictos conocidos antes de escribir y los errores seguros de esquema/servidor conservan código, campo y fila cuando están disponibles. La UI los muestra y los incorpora al CSV junto con errores locales y de imágenes; cada celda que comienza con `=`, `+`, `-` o `@` se neutraliza para evitar fórmulas al abrirlo.

El frontend limita la planilla a 10 MB, el ZIP a 100 MB comprimidos, la extracción acumulada a 250 MB y cada original a 15 MB. Rechaza nombres de imagen con separador inicial o segmentos `..`, admite solo extensiones JPEG/PNG/WebP y reprocesa la imagen antes de Storage. El ZIP se consulta en memoria por nombre exacto, no se extrae al filesystem. En `skip_existing`, servidor y frontend omiten metadata, opciones e imagen del producto preexistente.

La importación de metadata y la subida de imágenes son fases distintas. Una imagen fallida se informa y se puede reintentar, pero no revierte el catálogo ya confirmado; operación y soporte deben tratarlo como éxito parcial explícito.

## Frontend y headers

`vercel.json` aplica:

- CSP con `default-src 'self'`, `object-src 'none'` y `frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`;
- HSTS para HTTPS;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- Permissions Policy restrictiva;
- `X-Frame-Options: DENY`;
- aislamiento de opener compatible con el salto a WhatsApp.

La CSP incluida permite `https://*.supabase.co` y `wss://*.supabase.co` para que el mismo artefacto funcione en preview. Para producción estable, reemplazar esos comodines por el host exacto del proyecto y verificar login, Realtime, Storage y Edge Functions antes de publicar.

No se usa `dangerouslySetInnerHTML`. Los `returnTo` aceptan únicamente rutas relativas conocidas. El carrito no otorga autoridad sobre precios ni disponibilidad.

## Privacidad, logs y retención

- La PII del pedido no aparece en el link de toma, analytics ni mensajes de error.
- Los logs operativos deben usar IDs, código de error y duración; no el request completo.
- Las exportaciones requieren una sesión autorizada y deben manejarse como datos personales.
- Esta versión no borra pedidos automáticamente. Antes de fijar una retención se deben definir obligaciones legales, backup, exportación y borrado auditado.
- `expired` es un estado operativo, no una eliminación.

## Controles automatizados

`npm run security:check` realiza chequeos estáticos de alto valor:

- `.env` reales rastreados por Git;
- formatos conocidos de secret keys y JWT administrativo;
- referencias administrativas o variables `VITE_*` sensibles en `src`;
- signup público y HTML peligroso en frontend;
- CORS wildcard en Edge Functions;
- migraciones que deshabilitan RLS o usan `USING (true)`.

El CI además ejecuta Gitleaks sobre el historial y `npm audit --audit-level=high`. Si el repositorio pertenece a una organización de GitHub, cargá `GITLEAKS_LICENSE` como secreto de Actions; la acción no lo exige para repositorios personales. Estos controles no sustituyen pgTAP, pruebas de concurrencia, revisión de permisos remotos ni un pentest.

## Respuesta ante una filtración

1. Revocar o rotar inmediatamente la clave afectada en Supabase/Turnstile/SMTP.
2. Retirar el deployment o commit que la expone sin reescribir historia a ciegas; coordinar la limpieza del historial después de rotar.
3. Revisar Auth, Edge Function logs, auditoría y consumo para acotar el período.
4. Invalidar sesiones si pudo filtrarse un token de usuario.
5. Verificar RLS y Storage con un proyecto aislado antes de reabrir tráfico.
6. Documentar alcance, datos afectados, decisiones y acciones correctivas.
7. Notificar según contratos y normativa aplicable.

Nunca se debe "corregir" una fuga limitándose a borrar el valor del último commit: una credencial publicada se considera comprometida.

## Verificación previa a producción

- Ejecutar lint, typecheck, unitarias, pgTAP, Edge tests, E2E, build, auditoría y Gitleaks.
- Confirmar registro público remoto desactivado, proveedor email habilitado y Redirect URLs exactas.
- Probar Super Admin con y sin `aal2`.
- Probar tenant A contra tenant B para lectura, escritura, RPC y Storage.
- Verificar que un `GET` al link de toma no cambia el pedido.
- Manipular precios y opciones desde DevTools y comprobar rechazo/recalculo.
- Ejecutar dos claims concurrentes y comprobar un solo ganador.
- Inspeccionar bundle y variables de Vercel: no debe existir ninguna secret key.
- Revisar logs con pedidos de prueba y confirmar que no contienen PII completa ni tokens.
