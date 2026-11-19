# Auditoría visual del administrador de Mozzi

19 de noviembre de 2026 · Rama `codex/auditoria-integral-admin` · Referencia `85de075`

El alcance es el panel con un comercio seleccionado. El recorrido conectado usa una copia aislada de **Mozzi Tienda Demo** con una cuenta de auditoría ficticia. Las capturas comparables usan otro comercio de prueba con las mismas funciones habilitadas y datos sintéticos. Los formularios que escriben se comprueban con datos de prueba o respuestas simuladas. El panel central y las pantallas de acceso tienen comprobaciones de compatibilidad por los estilos compartidos.

## Hallazgos y decisiones

| Observación anterior | Refactor aplicado |
| --- | --- |
| Configuración juntaba datos públicos, formas de entrega, publicación, colores y parámetros internos en una sola columna. El guardado quedaba al final y los errores en bloques cerrados costaban encontrar. | Cinco secciones dentro de un único formulario. Botones visibles en escritorio y selector nativo en pantallas angostas. La selección indica dónde estás y qué sección tiene campos para revisar. |
| El horario semanal y las fechas especiales se encadenaban en la misma vista. | Dos subsecciones con los mismos borradores y un guardado compartido. |
| El editor de productos repetía bloques largos de nombre, imagen, stock, promociones, extras y código. | Secciones de edición con foto y disponibilidad junto al contexto del producto. Los campos y sus mensajes siguen asociados al mismo guardado. |
| Inicio apilaba indicadores de gran altura. Pedidos y el catálogo limitaban el alto de los resultados aun cuando había pocas filas. | Indicadores agrupados, filtros más cerca de los resultados y desplazamiento principal de la página. La lista virtual de Stock usa su propio desplazamiento cuando la cantidad de filas lo requiere. |
| Las acciones de contacto quedaban después de los productos al ver un pedido desde el celular. En los enlaces para tomar pedidos el espacio se desaprovechaba en escritorio. | El contacto acompaña el resumen y las acciones existentes. En pantallas anchas se organizan los bloques de pedido y atención; en celular siguen una secuencia única. |
| Algunos textos de ayuda parecían errores. Éxito, advertencia y carga tenían tratamientos distintos entre pantallas. | Ayudas neutras, mensajes de error cerca de los controles y avisos diferenciados con icono y texto. El indicador de carga acompaña al área que espera datos y respeta la preferencia de movimiento reducido. |
| Los nombres largos y las acciones competían por espacio en filas de usuarios y en modales. | Las filas muestran identidad, rol y estado como un conjunto. Los diálogos usan altura disponible, permiten volver con Escape cuando corresponde y devuelven el foco al control que los abrió. |

## Matriz de cobertura

**R** indica revisión de componentes y estados. **M** indica modificación visual. **V** indica comprobación en navegador o pruebas dirigidas. Las secciones pueden conservar sus componentes si ya resuelven bien la tarea.

| Vista del comercio | Cobertura | Estados y recorridos |
| --- | --- | --- |
| Inicio | R · M · V | Rango y métricas, carga, error y acceso a pedidos. |
| Pedidos | R · M · V | Período, filtros, vendedor, estado, tabla, tarjetas, lista vacía y exportación. |
| Detalle de pedido | R · M · V | Productos, contacto, entrega, cobro, acciones e historial operativo. |
| Enlace para tomar pedido | R · M · V | Resumen, carga, estado disponible y confirmación existente. |
| Stock | R · M · V | Vista del piloto y vista estándar; existencias, búsqueda, movimientos, configuración y conteo. |
| Tienda online | R · M · V | Publicación, formas de pedir, enlaces y QR. |
| Productos y fichas | R · M · V | Búsqueda, filtros, acciones, paginación, fichas y gestión de variantes en diálogo. |
| Nuevo producto y edición | R · M · V | Datos y foto, promociones, extras, códigos, guardado e indicación de errores en otra sección. |
| Categorías | R · M · V | Lista, alta y edición, iconos y mensajes. |
| Importación | R · M · V | Selección de planilla y ZIP, mapeo, revisión, listado de resultados y avisos. |
| Promociones y difusión | R · M · V | Revista, anuncio, selección de productos, vigencia, borrador, vista previa y compartir. |
| Configuración general | R · M · V | Datos del comercio, Atención y entrega, Canales de venta, Apariencia, Configuración regional e interna. |
| Horarios | R · M · V | Horario semanal, fechas especiales y guardado de ambos conjuntos. |
| Medios de pago | R · M · V | Métodos manuales, edición, disponibilidad, estados de la integración y avisos. |
| Zonas de envío | R · M · V | Crear o editar zona, calendario si está habilitado, copia y vista previa. |
| Logo y portada | R · M · V | Previsualización, carga y eliminación con sus acciones existentes. |
| Equipo y permisos | R · M · V | Lista de accesos, invitación, reenvío, confirmación de suspensión y reactivación. |
| Vendedores | R · M · V | Perfiles, canales, estado, alta, edición y enlaces. |
| Mi seguridad | R · M · V | Accesos a segundo factor y recuperación de contraseña. |
| Acceso y selector de comercio | R · M · V | El selector adopta el lenguaje visual del panel. Pruebas de entrada y permisos para las rutas protegidas. |

## Referencias públicas

- **Tiendanube.** Las guías ilustran cómo identificar un elemento del diseño y encontrar una sección entre las opciones del menú. Se tomó el criterio de nombrar las secciones por la tarea que resuelven. [Editor visual](https://ayuda.tiendanube.com/es_AR/122976-personalizar-tu-diseno/como-identificar-un-elemento-del-diseno-de-mi-tienda-para-modificarlo) · [Buscador del administrador](https://ayuda.tiendanube.com/es_AR/mi-cuenta/como-usar-el-buscador-en-mi-tiendanube)
- **Tienda Propio.** El sitio y el texto indexado de la guía de Revista de Ofertas describen un recorrido concentrado en seleccionar productos, publicar y generar el PDF. Esto orientó el orden de las acciones en el editor de Mozzi. El enlace de la guía redirige y la vista del administrador requiere acceso propio. [Sitio oficial](https://tiendapropio.com/) · [Guía de la Revista de Ofertas](https://clientes.tiendapropio.com/knowledge/c%C3%B3mo-usar-la-revista-de-ofertas-inteligente-en-tienda-propio)
- **Shopify.** La ayuda describe la barra lateral y los accesos a Configuración en escritorio y celular. El refactor usa una navegación local que mantiene visible la sección elegida y permite volver a un campo con error. [Navegar por el panel](https://help.shopify.com/es/manual/shopify-admin/shopify-admin-overview) · [Buscar en Configuración](https://help.shopify.com/es/manual/shopify-admin/admin-search)

## Observaciones funcionales aparte

- El tiempo de preparación se guarda y se expone en el catálogo, pero el flujo revisado no lo usa para calcular ni mostrar una hora prometida al comprador. La ayuda del campo explica el rango admitido.
- El resumen semanal puede indicar «Abierto» si hay un turno guardado como inactivo, porque la etiqueta cuenta turnos mientras que la regla de disponibilidad requiere uno activo. Se registró para tratarlo por separado.
- Mercado Pago se revisa con estados simulados. En la copia de trabajo se mantiene apagado y se comprueba la presentación del estado disponible, sin transacciones reales.

## Evidencia y verificación

La base visual usa el naranja de Mozzi para selección y acciones principales, con superficies neutras, textos de mayor contraste y espaciados más cortos. Los formularios mantienen etiquetas visibles y las acciones principales tienen al menos 44 px de alto en móvil. El panel usa el tema claro existente.

| Vista inicial con los mismos datos sintéticos | Antes | Después |
| --- | ---: | ---: |
| Configuración general, notebook 1366 × 768 | 1.239 px de documento | 768 px, con Guardar visible |
| Configuración general, celular 390 × 760 | 1.567 px | 998 px |
| Inicio, notebook 1366 × 768 | 936 px | 768 px |
| Inicio, celular 390 × 760 | 1.582 px | 1.171 px |
| Stock del piloto, celular 390 × 760 | 1.795 px | 1.569 px |

| Evidencia sintética | Antes | Después |
| --- | --- | --- |
| Configuración en notebook | [Captura](auditoria-visual-admin/antes-configuracion-1366.png) | [Captura](auditoria-visual-admin/despues-configuracion-1366.png) |
| Configuración en celular | [Captura](auditoria-visual-admin/antes-configuracion-390.png) | [Captura](auditoria-visual-admin/despues-configuracion-390.png) |
| Inicio en celular | [Captura](auditoria-visual-admin/antes-inicio-390.png) | [Captura](auditoria-visual-admin/despues-inicio-390.png) |
| Edición de producto en notebook | [Captura](auditoria-visual-admin/antes-producto-notebook.png) | [Captura](auditoria-visual-admin/despues-producto-notebook.png) |
| Modal de categoría en celular | [Captura](auditoria-visual-admin/antes-categoria-mobile.png) | [Captura](auditoria-visual-admin/despues-categoria-mobile.png) |
| Detalle de pedido en escritorio | [Captura](auditoria-visual-admin/pedido-detalle-desktop-antes.png) | [Captura](auditoria-visual-admin/pedido-detalle-desktop-despues.png) |
| Modal de pago con 526 px de altura | — | [Captura](auditoria-visual-admin/modal-pago-mobile.png) |

### Verificación ejecutada

- El mismo comercio sintético antes y después. 18 vistas por 4 tamaños (1366 × 768, 768 × 860, 390 × 760 y 360 × 640). Las 72 comprobaciones posteriores abrieron la ruta prevista y pasaron el control de desbordamiento horizontal global.
- Copia aislada de Mozzi Tienda Demo con autenticación real de una cuenta ficticia. 17 vistas en notebook y celular, 34 comprobaciones. El recorrido se limitó a lecturas del comercio y a la sesión.
- 36 comprobaciones con texto al 125%, en celular de altura reducida y en un viewport de notebook equivalente al espacio disponible con zoom del 125%. Pruebas dirigidas de navegación con teclado, foco y Escape en modales.
- Las pruebas de acciones usaron datos sintéticos o respuestas simuladas. Incluyeron persistencia del borrador y foco en el primer campo inválido de otra sección, los mismos campos y alcance de guardado en Configuración y Tienda, reenvío de invitación, confirmación de suspensión, guardado de stock y variantes, importación y reintento.
- Build, TypeScript, lint, controles estáticos de seguridad y presupuesto de transferencia verificados. El feedback del administrador se carga con sus módulos para respetar el presupuesto de la tienda pública.
- El diff final de esta auditoría está limitado a frontend, pruebas y evidencia. El panel central se comprueba con escenarios simulados de acceso, resumen, alta y detalle de comercio y seguridad. Las pruebas visuales se hicieron en Chromium emulado. Quedan fuera de la evidencia los dispositivos físicos y el acceso autenticado a paneles de terceros.

Resultado final. Pasaron 634 pruebas unitarias, 103 casos de Chromium con mocks entre la suite integrada y el reensayo de exportación ZIP, cuatro recorridos conectados de catálogo, pedido y recuperación por WhatsApp, y dos pruebas móviles de rendimiento. Las regresiones conectadas usaron un comercio sintético de la copia. También se repitió una muestra visual sobre el build final en ocho combinaciones de vista y tamaño.
