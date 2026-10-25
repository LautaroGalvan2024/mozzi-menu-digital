# Implementación mayorista y stock

Fecha: 24/10/2026 (Argentina). Rama: `feature/mayorista-stock`. Base auditada: `bf183767b8ba6012e2d33d177e473d5534669b9c`; referencias remotas actualizadas antes de comenzar. Se conservan React, PostgreSQL, Supabase y Vercel.

## Alcance y decisiones

Se implementan las correcciones indispensables, SKU automático y el inventario mínimo para un mayorista. Las pruebas de escalas mayores y optimizaciones sin impacto demostrado no condicionan esta entrega.

El usuario confirmó que **entregado significa recepción del cliente o retiro realizado**, y que **aceptar reserva mercadería; entregar descuenta existencia física**. No se confirmó unidad/caja/fracciones, fuente principal, captura de otros canales, parciales ni alcance físico de mercadería en tránsito. La implementación compatible admite cantidades enteras, un SKU físico por producto, entregas y devoluciones completas; admite que sólo parte de una devolución completa vuelva a ser vendible. Esto no equivale a devoluciones comerciales parciales.

La política queda sin confirmar y el stock sin activar en comercios existentes. Una activación exige una confirmación explícita de reglas compatibles y una ventana de conteo sin movimientos en todos los canales. Las reservas aceptadas no vencen automáticamente: requieren entrega o cancelación. Si el negocio necesita otro contrato, se amplía y prueba antes de activar.

## Cambios por etapa

| Etapa | Resultado implementado | Comprobación |
|---|---|---|
| S01 | Invitaciones respetan el rol previo, conservan el último administrador y revalidan permisos después de esperar locks | SQL011 y 9 carreras reales |
| S03/S04 | JSON leído por streaming con límite real de bytes; límites de colecciones antes de recorrer entradas | Pruebas Deno de límites, UTF-8, cancelación, fallos y cardinalidad |
| Productos e importaciones | `code` opcional, generado en servidor; ceros preservados; identidad UUID estable; códigos históricos protegidos; lote/fila persistidos y replay sin sobrescribir; descarga XLSX textual | SQL012, 8 escenarios concurrentes/fallos, parser, XLSX e interfaz |
| B03 | Precios exactos sin redondear decimales extra; grupos válidos; cambios de código/grupos por RPC, evitando inversión de locks; imágenes y archivo siguen compatibles | SQL015, validaciones del editor/importador y carreras SKU |
| Stock | Reserva, entrega, cancelación, conteo, pausa, ingresos, ajustes y venta externa; ledger inmutable, cortes y versiones; los SKU archivados con saldo o pedidos pendientes también se cuentan | SQL013 y 15 escenarios concurrentes |
| Corrección y devolución | Corrección sin salida física, devolución completa recibida con destino vendible explícito, reemplazos y reportes de vigencia | SQL013 y pruebas de interfaz/reportes |
| O03 | Intento de pedido vinculado a contenido comercial; conflicto si se cambia; reintentos concurrentes conservan tokens válidos sin repetir eventos | SQL014 y 5 escenarios concurrentes/fallos |
| O04/C03 | Carrito muestra qué línea debe corregirse sin borrar opciones/notas; refresco al volver a la pestaña; resumen y confirmación de diferencias de total antes de compartir | Tests de carrito, checkout y confirmación; el servidor sigue recalculando precios |
| O08 | Recuperación temporal de confirmación con token opaco distinto del de telemetría, hash privado, máximo 30 minutos y consulta sin mutar pedidos | SQL016, Edge e interfaz; no se guardan datos personales ni el mensaje en almacenamiento del navegador |
| G01 | Node 22 reproducible, lock completo, Zod 4 compatible y actualizaciones de dependencias vulnerables | npm ci, auditoría con 0 vulnerabilidades, tipos/lint/tests y Deno |

Los cambios están separados por objetivo. Ninguna migración histórica aplicada se modifica. La corrección de tipos en SQL010 arregla una prueba preexistente: `sum(bigint)` devuelve `numeric` y necesitaba un cast para comparar con pgTAP. SQL002 deja de usar un replay inseguro con sólo UUID; envía la solicitud completa.

## Base, respaldo y recuperación

Antes de modificar producción se verificó PostgreSQL **17.6**, historial de **23 migraciones**, **2 comercios, 34 productos, 22 pedidos, 4 usuarios Auth y 37 objetos Storage**. Aunque el sistema no tenga usuarios operando, esos datos se preservan.

El respaldo lógico y los objetos están fuera del repositorio, bajo el directorio privado de backups de Codex. La carpeta de esta ejecución termina en `Mozzi-Menu/2026-10-25T00-51-03-596Z`; su ACL admite al usuario local y SYSTEM. No se versionan credenciales, dumps ni información de clientes.

- `database.dump`: 771.543 bytes, SHA256 `3c3b780940d821be59f7bf282ab887a89b8d7194896a2ccd85f24eece2a06f61`.
- `application.dump`: 372.101 bytes, SHA256 `ca468c8bf5f9f482f0be26dcb1951857dcd83677299cc58296118200c9c5d894`.
- `managed-schema.sql`: definiciones Auth/Storage sin datos, para preparar el entorno SQL de pruebas.
- `storage/`: 37 archivos y manifest de tamaños y hashes. Un dump SQL por sí solo no respalda los bytes de Storage.
- `manifest.json` y reporte de recuperación: evidencia restringida junto al respaldo.

La restauración de ensayo en un **nuevo** `mozzi_restore_*` de PostgreSQL **17.11**, ligado sólo a loopback, reprodujo esos conteos y validó FKs y los hashes de todos los archivos, incluidos los 37 objetos. Se restauraron esquema y datos de `auth`, `storage`, `public`, `private` y `supabase_migrations`. Después se aplicaron las seis migraciones nuevas sobre otra copia restaurada: se compararon las **55 tablas originales, todas sus columnas previas y filas**, sin cambios en esos datos. El ensayo excluye deliberadamente ownership/ACL administrados y no certifica la recuperación de servicios HTTP/Auth/Storage hospedados. No se reinició ni limpió ninguna base existente.

Procedimiento reproducible (PowerShell, con `PG_BIN` apuntando a PostgreSQL 17):

```powershell
# Lectura del proyecto vinculado. Guarda fuera del repositorio, nunca imprime claves.
node scripts/database/backup-linked.mjs
# Ensayo en una base local NUEVA; ruta al respaldo privado.
node scripts/database/local-test-restore.mjs <directorio-del-respaldo>
```

La CLI genera credenciales temporales: no ejecutar otras operaciones `--linked` mientras corre el respaldo, porque pueden rotarlas. No copiar a la consola su salida `db dump --dry-run`, que contiene la contraseña temporal. El helper la procesa en memoria y entrega variables de entorno al proceso nativo.

Ante un incidente: pausar operaciones afectadas mediante la RPC de política, conservar movimientos y protecciones, verificar el respaldo y restaurar primero en un destino aislado. Preferir una migración correctiva. Para recuperación hospedada, preparar el esquema de aplicación y datos con los roles/servicios Supabase del destino; revisar ownership, ACL, Auth y Storage antes de habilitar tráfico. No usar un `pg_restore --clean` completo sobre el proyecto vinculado. El frontend anterior puede restaurarse conservando funciones y triggers que protegen pedidos con inventario. Nunca volver de stock activo a `never_enabled`.

## Evidencia de base aislada

Se usa PostgreSQL real, sin Docker, en un cluster privado con contraseña, `127.0.0.1:55432`, separado del PostgreSQL 18 ya instalado en Windows. `.env.database.local` está ignorada y restringida por ACL. pgTAP 1.3.4 proviene de la distribución oficial. Las definiciones Auth/Storage proceden del respaldo sin datos; los tests usan fixtures sintéticos y roles `anon`, `authenticated` y `service_role` con claims explícitos.

La base previa de 23 migraciones pasa 276 aserciones tras corregir el cast de la prueba SQL010. La reconstrucción final desde cero con **29 migraciones** pasa **16 suites / 575 aserciones** en `mozzi_fresh_20261025_012641`. Los cuatro harnesses pasan **37 escenarios** (9 membresías, 8 SKU/importación, 15 inventario, 5 pedidos), con conexiones independientes y esperas reales observadas en `pg_stat_activity`; no toman `Promise.all` como prueba suficiente de simultaneidad.

```powershell
node scripts/database/local-test-run.mjs --database=mozzi_fresh_20261025_012641
node scripts/database/local-test-concurrency.mjs --database=mozzi_fresh_20261025_012641
# Sólo para una copia restaurada; compara datos previos y nunca inserta fixtures.
node scripts/database/local-test-upgrade-restored.mjs --database=mozzi_restore_<marca-de-tiempo>
```

Los runners sólo admiten loopback y bases `mozzi_*`; el wrapper de concurrencia además prohíbe `mozzi_restore_*`. El bootstrap rechaza sustratos existentes y el restore siempre crea otro destino. No usar fixtures en producción. Las pruebas SQL acreditan transacciones, locks, restricciones, RLS y ACL comprobadas en ese entorno. Las pruebas de React con backend simulado acreditan interacción y contratos de UI. Ninguna sustituye la integración completa HTTP/Auth/Edge/Storage ni una medición de capacidad del piloto.

Frontend final: **155 pruebas / 34 archivos**, tipos y lint correctos. Deno: **51 pruebas**, formato, lint y tipos correctos. Playwright: **5 aprobadas y 4 live omitidas**, tanto en desarrollo como contra build compilado aislado con endpoint ficticio; no se presentaron esas cinco como integración real. Node 22.23.4/npm 10.9.9, Deno 2.9.6; el proyecto local/CI queda configurado con PostgreSQL 17, alineado con producción.

## Despliegue y pendientes de lanzamiento

Estado productivo: **seis migraciones aplicadas**, `202610240001` a `202610240006`, después de respaldo, restore, pruebas aisladas y dry-run. El historial remoto quedó en **29 migraciones**, sin pendientes locales, seeds ni ejecución de fixtures. La inspección de las 22:29 (Argentina) conserva **2 comercios, 34 productos, 22 pedidos, 4 usuarios y 37 objetos Storage**; **25/25 tablas públicas con RLS**, esquema privado sin acceso de anon/authenticated y 31 funciones públicas con permisos revisados. Los dos comercios permanecen en `never_enabled`; saldos, conteos, operaciones y movimientos siguen vacíos. No se activó inventario ni se interpretaron reglas pendientes como confirmadas.

Orden restante de publicación: Edge compatible, frontend, comprobación conectada, reglas comerciales y corte físico. El frontend anterior sigue usando las firmas existentes; los campos nuevos de resultados se mantienen compatibles donde hay parsers estrictos. La aplicación de SQL no significa que el frontend o las funciones Edge nuevos estén publicados.

CI versionada se dispara con PR y push a `main`; no contiene despliegue productivo. Vercel confirma integración con este repositorio, rama productiva `main`, Node 22 y build `npm run build`; el último despliegue productivo corresponde a la base auditada. No se hizo merge a `main`. La consulta de protección clásica de la rama devuelve 403 y los rulesets visibles están vacíos: no se afirma que exista protección remota configurada; esta tarea preserva main sin escribir sobre ella. La autorización recibida cubre implementación y migraciones productivas con respaldo y pruebas; los cambios se entregan para revisión por etapas.

La configuración de preview disponible apunta a la misma base productiva: **ese preview no es un entorno aislado de pruebas**. Build/CI no ejecutan migraciones ni DML remoto; la CI de SQL crea su propia base. Los orígenes permitidos de Edge productivo son exactos y no incluyen el preview revisado. No se agregaron orígenes amplios ni se hicieron pruebas mutantes de navegador contra producción. Las comprobaciones de interfaz usan destinos ficticios y fixtures locales.

Pendientes reales de habilitación: respuestas comerciales restantes, catálogo/pico y dispositivos del piloto, integración conectada HTTP/Auth/Edge/Storage, corte físico del negocio y verificación de planes/consumo. El entorno local no dispone de Docker/Podman/WSL ni de los servicios HTTP completos; PostgreSQL nativo resuelve las pruebas de integridad, no ese ensayo integral. Supabase figura saludable en us-east-1, pero plan/cuotas/consumo no están expuestos por los accesos consultados.

Vercel confirma **Hobby** activo; las consultas de consumo devuelven HTTP404, lo que no significa consumo cero. [La documentación oficial de Hobby](https://vercel.com/docs/plans/hobby), consultada el 24/10/2026, limita el plan a uso personal no comercial. Antes del piloto comercial hay que resolver un plan compatible; no se autoriza ni ejecuta una compra por inferencia. No se asegura el mismo costo mensual y no se contrataron nuevos servicios ni upgrades.
