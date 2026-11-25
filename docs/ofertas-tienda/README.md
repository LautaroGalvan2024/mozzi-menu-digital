# Ordenar las ofertas de la tienda

En **Catálogo → Productos → Ordenar ofertas**, arrastrá un producto desde el número de posición o usá sus flechas. **Se muestra primero** identifica la primera tarjeta que verán tus clientes. Elegí **Guardar orden** para publicar el cambio. **Cancelar** permite descartar la edición.

La portada muestra hasta ocho tarjetas en **Ofertas para aprovechar**. **Ver todos** continúa con el mismo orden. La búsqueda, las categorías, los destacados y el menú gastronómico conservan sus criterios habituales.

| Vista con datos ficticios | Escritorio | Celular |
| --- | --- | --- |
| Administrador | [Ver captura](administrador-escritorio.png) | [Ver captura](administrador-movil.png) |
| Tienda | [Ver captura](tienda-escritorio.png) | [Ver captura](tienda-movil.png) |

## Reglas

- La unidad que se ordena es la tarjeta que ve el cliente. Una familia con variantes ocupa un lugar. Las reglas vigentes de disponibilidad, promociones por fecha, packs y descuentos por cantidad determinan qué tarjetas participan.
- Cada comercio conserva el orden histórico hasta su primer guardado. Una oferta nueva aparece después de las ordenadas, con el orden histórico como desempate. Una oferta que deja de ser elegible desaparece.
- Si una oferta vuelve, recupera su posición anterior mientras el comercio conserve esa lista. Si guardó una lista distinta durante su ausencia, se incorpora al final. La eliminación física de un producto o familia elimina su posición.
- El administrador conserva el borrador si se interrumpe la conexión. Si otra persona guarda o cambia el conjunto de ofertas, el panel vuelve a cargar las ofertas, reaplica los movimientos que siguen siendo posibles y pide revisar el resultado antes de guardar.

## Implementación y verificación

La migración `20261125102133_store_offer_order.sql` crea una tabla privada de posiciones y dos RPC de administración. El servidor comprueba el permiso de catálogo, el canal de tienda y la pertenencia de la lista completa. El guardado toma el bloqueo de la revisión del comercio, compara el estado que se editó y escribe la nueva lista en una transacción. El paginador público aplica las posiciones antes del límite de página y usa la revisión existente para renovar la caché y los cursores.

El punto de entrada está en `ProductsPage.tsx`. `OfferOrderDialog.tsx` conserva la edición y resuelve conflictos, `OfferOrderList.tsx` implementa los controles y `offer-order-api.ts` valida las respuestas. Las pruebas del diálogo, la suite Playwright `offer-order.spec.ts`, las suites SQL 009, 026 y 034 y el ensayo de dos conexiones cubren el flujo y los permisos.

## Publicación y reversión

1. Ejecutar la CI del PR y la migración en PostgreSQL de prueba. Confirmar que la definición productiva del paginador corresponde a la versión de partida. Conservar su definición y un respaldo verificable de la base.
2. Aplicar la migración y registrar su versión en una sola transacción, con tiempo de espera limitado para los bloqueos. Recargar la caché de esquema de PostgREST. Comprobar el catálogo público y los permisos de las nuevas RPC.
3. Promover el build revisado al dominio de la tienda, comprobar el acceso público y el ingreso al administrador, y registrar despliegue, commit y hora en el PR.
4. Para revertir la interfaz, promover el despliegue anterior compatible con el checkout. Si también es necesario recuperar el paginador anterior, restaurar la definición guardada en una transacción y recargar PostgREST. Mantener la tabla privada y las posiciones guardadas. Verificar nuevamente las rutas públicas.
