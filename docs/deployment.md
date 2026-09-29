# Instalación y despliegue

Este documento describe el procedimiento; no implica que el proyecto haya sido desplegado. Usá proyectos separados de Supabase y Vercel para desarrollo, staging y producción.

## Requisitos

- Node.js 22.12 o posterior y npm.
- Supabase CLI actual.
- Docker Desktop o motor compatible para Supabase local.
- Un proyecto Supabase para cada entorno remoto.
- Un proyecto Vercel conectado al repositorio.
- Acceso para configurar DNS, SMTP y Redirect URLs de Auth.

## Configuración guiada en Windows

```powershell
npm ci
npm run setup:project
npm run dev
```

No crees, copies ni edites archivos `.env` manualmente. El asistente usa estos valores base:

- Project Ref: `coqkgyaekenxccbxlozo`;
- URL de Supabase: `https://coqkgyaekenxccbxlozo.supabase.co`;
- aplicación local: `http://localhost:5173`.

Solicita el correo del Super Admin, `sb_publishable_*`, `sb_secret_*`, una URL productiva opcional y el par de Turnstile únicamente si se activa. Los secretos se ingresan de forma oculta. La URL productiva puede omitirse; en ese caso Edge usa localhost y basta volver a ejecutar el asistente cuando exista el dominio.

Genera con UTF-8 sin BOM y verifica con Git:

- `.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_BASE_URL` y, condicionalmente, `VITE_TURNSTILE_SITE_KEY`;
- `.env.bootstrap`: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPER_ADMIN_EMAIL`;
- `.env.edge.production`: `APP_BASE_URL`, `APP_ALLOWED_ORIGINS`, `RATE_LIMIT_HASH_SECRET`, `MAINTENANCE_SECRET`, `TURNSTILE_ENABLED` y, condicionalmente, `TURNSTILE_SECRET_KEY`.

No existen consumidores de `ACTION_TOKEN_HASH_SECRET` ni `CRON_SECRET`, por lo que no se generan. Las variables `E2E_*`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_URL`, `SUPABASE_TYPES_OUTPUT` y `SUPABASE_CLI` son opciones de tooling fuera de este setup.

Las Edge Functions consumen el contrato moderno inyectado por Supabase: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` y `SUPABASE_SECRET_KEYS`. Los mapas de claves seleccionan `default`, no tienen fallback legacy y no deben escribirse en `.env.edge.production`. Para servir funciones localmente después de iniciar Supabase:

```powershell
supabase functions serve --env-file .env.edge.production
```

## Reconstrucción de base

`supabase db reset` crea una base limpia y aplica todas las migraciones, incluidas funciones, grants, RLS, Storage y Realtime. No reemplaces este paso con cambios manuales de Studio.

```powershell
supabase db reset
supabase test db
```

Para generar tipos desde la base local:

```powershell
npm run supabase:types
```

Para generar contra un proyecto vinculado, definí `SUPABASE_PROJECT_ID` solo durante el comando. La CLI debe tener una sesión válida. El script no imprime ni guarda el access token.

## Proyecto Supabase remoto

### 1. Vincular y aplicar migraciones

```powershell
npm run setup:project
```

El asistente detecta `supabase/.temp/project-ref`; si no coincide, ejecuta `npx supabase link --project-ref coqkgyaekenxccbxlozo` y deja que la CLI solicite directamente la contraseña de base. Luego ofrece `npx supabase db push`, pero nunca lo ejecuta sin confirmación, no usa `--force` y no marca migraciones artificialmente. Las migraciones son incrementales; no edites una migración que ya se aplicó en otro entorno.

### 2. Cargar secretos de funciones

`.env.edge.production` se genera automáticamente. Los dos secretos internos son distintos, criptográficamente aleatorios y de 32 bytes; una reejecución conserva valores existentes válidos para no rotarlos accidentalmente. El asistente ofrece cargarlos sin poner valores en argumentos ni historial:

```powershell
npx supabase secrets set --env-file .env.edge.production
```

Después ejecuta `npx supabase secrets list --output-format json`, verifica los nombres esperados y muestra únicamente nombres, nunca valores ni digests.

Turnstile es opcional y se configura como una unidad:

1. en Edge, `TURNSTILE_ENABLED=true` y una `TURNSTILE_SECRET_KEY` real;
2. en Vercel/frontend, `VITE_TURNSTILE_SITE_KEY` del mismo widget;
3. CSP y conectividad hacia `https://challenges.cloudflare.com`, ya contempladas por `vercel.json`.

Con el flag activo, `create-order` exige token y lo verifica server-side; la validación del navegador no lo sustituye. Activar Edge sin site key bloquea todos los pedidos, y publicar solo la site key muestra un desafío que Edge no valida. Para desactivar, usá flag falso/ausente y dejá vacía la site key; no dependas de una secret residual para activar el control.

### 3. Desplegar Edge Functions

El asistente ofrece, con confirmación, `npx supabase functions deploy`, que despliega todas las funciones versionadas. También se pueden desplegar individualmente con la CLI si una operación de recuperación lo requiere.

`expire-orders` es interna: exige `x-maintenance-secret`, no habilita CORS y no debe invocarse desde el navegador. `supabase/config.toml` deja la verificación de gateway desactivada para que cada función controle preflight, origen, JWT o secreto de mantenimiento con el flujo versionado; no significa que las funciones privadas sean anónimas.

### 4. Configuración manual de Auth

En **Authentication > Providers / Sign In**:

- desactivá registro público y usuarios anónimos;
- mantené email/invitación como mecanismo administrativo;
- exigí 12 caracteres, mayúsculas, minúsculas, números y símbolos;
- habilitá TOTP;
- habilitá protección de contraseñas filtradas si el plan la ofrece;
- revisá duración de sesión y rotación de refresh tokens.

En **URL Configuration** agregá entradas exactas:

```text
http://localhost:5173/auth/callback
https://staging.example.com/auth/callback
https://menu.example.com/auth/callback
https://menu.example.com/auth/set-password
https://menu.example.com/auth/reset-password
```

Agregá solo previews Vercel controladas. Evitá comodines que permitan a cualquier dominio recibir un token.

En **SMTP Settings**, configurá un proveedor propio antes de invitar usuarios reales o habilitar recuperaciones a volumen. Verificá remitente, SPF, DKIM, DMARC, rate limits y enlaces de staging/producción.

### 5. Comprobaciones de base

- `private` no aparece en **Exposed schemas**.
- Todas las tablas de `public` y `storage.objects` esperadas tienen RLS habilitada.
- El bucket `restaurant-assets` es el único bucket público del sistema y no contiene PII.
- Realtime publica solamente las tablas necesarias.
- Las RPC administrativas no tienen grants para `anon`.
- `get_public_menu` no devuelve perfiles, miembros, pedidos ni auditoría.

## Vercel

### Configuración del proyecto

| Opción | Valor |
|---|---|
| Framework preset | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js | 22 |

Variables admitidas:

```env
VITE_SUPABASE_URL=https://coqkgyaekenxccbxlozo.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=CLAVE_PUBLICA_DEL_PROYECTO
VITE_APP_BASE_URL=https://menu.example.com
VITE_TURNSTILE_SITE_KEY=
```

No agregues claves administrativas, `TURNSTILE_SECRET_KEY`, secretos de rate limit, SMTP, tokens de CLI ni connection strings. Una variable `VITE_*` siempre es pública; la site key de Turnstile no es secreta.

`vercel.json` incluye rewrite de SPA, caché inmutable para `/assets/*`, revalidación de `index.html` y headers. Antes del primer deploy productivo, reemplazá `*.supabase.co` en la CSP por `coqkgyaekenxccbxlozo.supabase.co` si el entorno ya es estable. Un cambio de CSP requiere probar login, callbacks, Realtime, Storage, imágenes y funciones.

### Dominio y orígenes

El origen exacto de producción debe coincidir en cuatro lugares:

1. `VITE_APP_BASE_URL` de Vercel;
2. `APP_BASE_URL` de Edge Functions;
3. `APP_ALLOWED_ORIGINS` de Edge Functions;
4. Site URL y Redirect URLs de Supabase Auth.

Si hay staging, agregalo expresamente. No incluyas una preview abierta con patrón global.

## Validación previa

En un checkout limpio:

```powershell
npm ci
npm run setup:project
npm run security:check
npm run lint
npm run typecheck
npm run test
npm run build
npm audit --audit-level=high
supabase db reset
supabase test db
```

Estos comandos son el criterio de release, no una afirmación de que se haya desplegado. El detalle de lo que efectivamente se ejecutó en este checkout —incluido el harness PostgreSQL alternativo y la falta de Docker/Podman para repetir el stack oficial— está en [Verificación disponible en este checkout](../README.md#verificación-disponible-en-este-checkout).

`npm run test:e2e` ejecuta los smoke tests de navegación con Chromium y una SPA local. Para los flujos conectados usá exclusivamente un proyecto Supabase aislado y sembrado; definí temporalmente `E2E_LIVE=1`, `E2E_BASE_URL`, `E2E_RESTAURANT_SLUG`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` y, para la prueba del link, `E2E_ACTION_ID`. El origen exacto de `E2E_BASE_URL` debe estar permitido por `APP_ALLOWED_ORIGINS`. La aceptación que realmente inserta un pedido está deshabilitada por defecto y requiere `E2E_CREATE_ORDER=1`; verifica la confirmación, pero no abre ni envía WhatsApp. No guardes esas variables ni credenciales en Git. Gitleaks se ejecuta en GitHub Actions; también puede ejecutarse localmente antes de un release.

## Smoke test de staging

1. Abrir un slug inexistente y comprobar respuesta segura.
2. Iniciar sesión como Super Admin; confirmar que una acción crítica exige TOTP/AAL2.
3. Crear un restaurante e invitar a un administrador de prueba.
4. Publicar un producto y comprobar la RPC pública sin sesión.
5. Crear un pedido con precio manipulado y comprobar que el servidor usa el real.
6. Repetir la idempotency key y verificar un solo pedido.
7. Abrir WhatsApp; comprobar que el estado no afirma envío.
8. Cargar el link de toma sin pulsar el botón; comprobar que no mutó.
9. Competir con dos operadores; comprobar un solo `accepted_by`.
10. Intentar leer el pedido desde otro restaurante y escribir un asset en otra carpeta.
11. Si Turnstile está activo, comprobar token válido, ausente, vencido y rechazo de Siteverify; si está desactivado, confirmar que el widget no aparece.
12. Revisar headers con DevTools y logs sin PII/tokens.

## Rollback y recuperación

- **Frontend:** promover el deployment anterior de Vercel. Verificá que siga siendo compatible con el esquema actual.
- **Edge Functions:** redesplegar el commit anterior compatible. Rotar secretos si el incidente los afecta.
- **Base:** no ejecutar SQL inverso improvisado. Crear una migración correctiva o restaurar a un proyecto aislado y seguir el procedimiento de recuperación.
- **Datos:** validar backup y Point-in-Time Recovery del plan antes de necesitarlo. Una copia no probada no es un plan de recuperación.

No borres pedidos ni auditoría para forzar un rollback.
