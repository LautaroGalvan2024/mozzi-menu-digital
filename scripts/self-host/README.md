# Aislamiento de Supabase en la VPS

El archivo `compose.isolation.yml` se aplica junto con la [composición oficial de Supabase](https://github.com/supabase/supabase/blob/76883d49435524645397b9f7a0048d92f69b8330/docker/docker-compose.yml). Se verificó con esa revisión y Docker Compose 5.1.0 y 5.8.0. La opción `!override` requiere [Compose 2.24.4 o posterior](https://docs.docker.com/reference/compose-file/merge/#replace-value). Docker Engine 28.0.0 o posterior corrige el [acceso al loopback desde otros equipos de la misma red](https://docs.docker.com/engine/network/port-publishing/).

`mozzi-supabase` usa su propia red de Docker y guarda los datos en un directorio dedicado, por ejemplo `/srv/mozzi-supabase/volumes/db/data`. El gateway escucha en `127.0.0.1:18000`. Postgres y Supavisor sólo tienen puertos internos a Docker. El alias de Realtime coincide con el que usa Envoy en la red del proyecto.

## Validación previa

Prepará los archivos oficiales y el `.env` con las credenciales del entorno de prueba en el directorio dedicado. Para la base interna, configurá `POSTGRES_HOST=db` y `POSTGRES_PORT=5432`. Verificá que la VPS tenga recursos disponibles, que el puerto 18000 esté libre y que los recursos con el nombre del proyecto no pertenezcan a otra instalación.

Con Node.js y Docker Compose en la máquina que contiene los volúmenes, ejecutá desde el repositorio:

```sh
node scripts/self-host/validate-isolation.mjs /srv/mozzi-supabase
```

El validador comprueba la configuración resuelta, incluyendo rutas de datos, puertos y destinos de Postgres. El mensaje de salida omite la configuración y las credenciales. Al levantar el entorno aislado, usá el mismo directorio, archivo de entorno, proyecto y orden de archivos:

```sh
docker compose --project-name mozzi-supabase \
  --project-directory /srv/mozzi-supabase --env-file /srv/mozzi-supabase/.env \
  -f /srv/mozzi-supabase/docker-compose.yml -f scripts/self-host/compose.isolation.yml \
  up -d --wait --wait-timeout 240
```

Guardá las variables adicionales de las funciones en `/srv/mozzi-supabase/.env.mozzi-edge` con modo `0600`. Aplicá los cambios con `up -d --wait functions` usando los mismos argumentos de Compose.

Prepará el código que va al volumen con `node scripts/self-host/package-edge-functions.mjs <directorio-nuevo>`. El paquete incluye los tipos generados que Deno resuelve dentro del contenedor. Conservá el directorio `main` y la configuración `deno.jsonc` que instala Supabase al reemplazar las funciones de Mozzi.

Para conectar Vercel más adelante, definí el acceso HTTPS por separado. El proxy debe limitar la publicación a las rutas de API que usa Mozzi Menu. Studio puede quedar disponible mediante un túnel SSH.

Para Mercado Pago, el `HttpConnectionManager` de `volumes/api/envoy/lds.template.yaml` debe tener `preserve_external_request_id: true` junto a `use_remote_address`. Mercado Pago incluye el valor original de `x-request-id` en la firma. Después de recrear sólo el gateway del proyecto, comprobá que la URL HTTPS acepte una notificación de ensayo firmada y devuelva 401 sin firma. [Documentación de Envoy](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/network/http_connection_manager/v3/http_connection_manager.proto#extensions-filters-network-http-connection-manager-v3-httpconnectionmanager)

## Correos de acceso

Copiá `supabase/templates/invite-es.html` y `supabase/templates/recovery-es.html` a `/srv/mozzi-supabase/volumes/auth-templates/`. El servicio de plantillas sólo escucha dentro de la red de Supabase. Los archivos y el directorio deben ser legibles por el proceso de ese contenedor.

Validá la configuración con `node scripts/self-host/validate-isolation.mjs /srv/mozzi-supabase --auth-templates`. Al aplicar Compose, agregá `-f scripts/self-host/compose.auth-templates.yml` después del overlay de aislamiento. Conservá ambos overlays en las operaciones de mantenimiento del stack para que Auth siga usando los asuntos y las plantillas en español.

## Preparación de la restauración

Usá un respaldo completo de un único corte. Desde el repositorio, ejecutá `node scripts/self-host/prepare-db-restore.mjs <directorio-del-respaldo>` con `pg_restore` disponible en el PATH o `PG_BIN`. El script verifica el manifiesto y genera SQL protegido fuera del repositorio. El original completo conserva el historial de sesiones. El SQL de restauración deja que el destino emita sesiones nuevas.

Para pedir una nueva inscripción de MFA, agregá `--renew-mfa-on-login`. El SQL conserva los usuarios, sus identidades y contraseñas, omite los factores anteriores y exige que la tabla de factores quede vacía. El respaldo completo sigue incluyendo los factores originales. La opción sólo se aplica a un destino nuevo.

Ejecutá el SQL únicamente con `psql -X -h /var/run/postgresql -U supabase_admin -d postgres` dentro del contenedor `db` del proyecto aislado. El archivo incluye su propia transacción y verifica los conteos, los permisos y el propietario antes de confirmar.

## Copia de Storage durante el ensayo

Después de restaurar los buckets y las políticas, copiá el respaldo completo al directorio privado `/srv/mozzi-supabase/imports/` y colocá `restore-storage.mjs` en la raíz del stack. Desde `/srv/mozzi-supabase` ejecutá `node restore-storage.mjs <nombre-del-respaldo>`. El script compara cada archivo con su checksum antes de subirlo al gateway local, verifica los bytes recuperados y permite reintentar el mismo respaldo. Storage asigna su propia versión a cada objeto.

## Bloqueo de origen durante el corte

Con el tráfico de escritura detenido, abrí `psql -X` contra el origen Cloud con TLS y una conexión directa o un pooler en modo sesión. Si el usuario de conexión es el rol transitorio de Supabase, ejecutá `SET ROLE postgres;`. Dentro del prompt interactivo, cargá el archivo con `\i scripts/self-host/hold-cloud-cutover-fence.sql`. Debe mostrar 78 tablas bloqueadas. Mantené abierta esa sesión. El bloqueo tiene un límite de 20 minutos sin actividad y termina al cerrar la transacción.

En una conexión separada, verificá la continuidad antes y después de la copia.

```sql
WITH fence AS (
  SELECT pid FROM pg_stat_activity
  WHERE datname = current_database() AND application_name = 'mozzi-final-cutover-fence'
), held AS (
  SELECT DISTINCT l.database, l.relation
  FROM pg_locks l JOIN fence f ON f.pid = l.pid
  WHERE l.locktype = 'relation' AND l.mode = 'ShareLock' AND l.granted
)
SELECT (SELECT count(*) FROM fence) AS sesiones,
       (SELECT count(*) FROM held) AS tablas_bloqueadas,
       (SELECT count(DISTINCT l.pid)
        FROM pg_locks l JOIN held h USING (database, relation)
        WHERE l.locktype = 'relation' AND NOT l.granted
          AND l.mode IN ('RowExclusiveLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       ) AS procesos_con_escrituras_o_ddl_en_espera;
```

El respaldo se ejecuta en otra conexión. Si se pierde la sesión de bloqueo antes de confirmar el cierre del origen, repetí el corte desde un respaldo nuevo. Antes de habilitar escrituras en la VPS, confirmá que el proyecto Cloud está pausado o que sus vías directas de escritura quedaron cerradas. Si se cancela el corte, `ROLLBACK;` libera el bloqueo y el origen puede seguir atendiendo a los clientes.

## Pruebas

Las pruebas del validador funcionan sin Docker:

```sh
node --test scripts/self-host/validate-isolation.test.mjs
```
