# Auditoría visual de Mozzi Comercio

Revisión del 18 de noviembre de 2026 sobre las 45 rutas de la aplicación. La tienda pública de El Nieto fue la referencia principal. La galería contiene una captura de escritorio y otra de celular de cada ruta. Se puede abrir directamente desde disco y consultar sin conexión. [Abrir la galería de 90 capturas](galeria.html)

## El Nieto

La primera pantalla publicada repetía el nombre del local y dedicaba gran parte de la altura a la portada, los bloques de servicio y una fila de categorías con la misma caja dibujada. En celular se alcanzaba el final de la pantalla antes de ver un producto. Medimos la distancia desde el inicio del documento hasta el borde superior de la primera tarjeta en Chromium, con el mismo catálogo público y las fotos cargadas.

| Pantalla | Sitio publicado | Rediseño local | Producto más cerca del inicio |
| --- | ---: | ---: | ---: |
| Celular, 390 × 844 | 959 px | 697 px | 262 px |
| Escritorio, 1440 × 900 | 1048 px | 657 px | 391 px |

La portada mantiene el cartel y el logo de la rotisería. En escritorio comparte fila con la información del comercio. Las categorías sin foto priorizan su nombre. El buscador y los filtros ocupan menos altura, los precios tienen más peso y la acción de agregar o elegir opciones se distingue de los beneficios por cantidad. La ficha conserva el encuadre completo de las fotos verticales. [Comparar las dos primeras pantallas en celular](el-nieto-antes-y-despues.webp)

## Hallazgos y cambios

| Superficie | Hallazgo | Cambio aplicado |
| --- | --- | --- |
| Tienda, carrito y checkout | Las llamadas a la acción competían con los bloques informativos. El resumen del checkout perdía visibilidad en escritorio. | Acción junto al precio, total visible al cerrar el resumen y desglose accesible con teclado. El formulario muestra en español las indicaciones de longitud de nombre y teléfono. |
| Confirmación y pago | El comprador podía perder la referencia visual al comercio después del checkout. | La confirmación reutiliza los datos públicos de marca ya cargados para ese comercio y canal. El acceso directo conserva una presentación neutra cuando faltan esos datos. Los estados de pago mantienen sus textos y se distinguen visualmente. |
| Menú gastronómico | La superposición sobre la foto y el peso de los controles competían con la carta. | Portada más legible, fichas con foto y precio, identidad del comercio durante la compra. Se revisaron locales sin fotos, nombres largos, local cerrado, horarios y errores. |
| Administración y superadministración | Algunas superficies usaban radios, densidades y estilos de indicadores diferentes. | Métricas, navegación activa, cabeceras y tarjetas comparten una jerarquía. Los importes y estados operativos se conservan separados. |
| Acceso y recuperación | Al abrir el login directamente, los estilos administrativos dependían de haber entrado previamente al panel. Los errores podían sumarse al nombre accesible del campo. | El formulario carga sus propios estilos y cada error queda asociado a su campo. Se revisaron ingreso, recuperación, MFA, enlace vencido y redirección. |
| Portada y página desconocida | La portada dedicaba espacio a precios y artículos ficticios. La página 404 tenía poca continuidad visual con la plataforma. | Fotografía editorial generada para la portada, acceso al comercio en un bloque propio y 404 con el logo y una acción de regreso. |

## Identidad y cobertura

Se conservan la firma naranja de Mozzi Comercio, el acento `#FF6D00`, la base oscura de la portada y los paneles claros. Inter se sirve desde la aplicación. Los comercios mantienen logo, colores, portada e imágenes configuradas. Se usaron los criterios de jerarquía, fotografía y convivencia de marcas del manual de Mozzi, junto con los activos y tokens propios de Comercio. [Guía de identidad del producto](../admin-design-system.md)

| Área | Rutas | Cobertura |
| --- | ---: | --- |
| Tienda online | 6 | Catálogo, ficha, carrito, checkout, pedido generado y pago |
| Menú | 4 | Carta, carrito, checkout y pedido generado |
| Plataforma | 2 | Portada y página no encontrada |
| Acceso | 7 | Login, continuación, callback, definir contraseña, recuperar, restablecer y MFA |
| Administración | 19 | Selección de comercio, resumen, pedidos y toma de pedido, inventario, seguridad, configuración, tienda, marca, horarios, pagos, envío, catálogo y equipo |
| Superadministración | 7 | Control central, listado, alta y detalle de comercios, usuarios, auditoría y seguridad |

El inventario se cotejó con el router. La galería identifica la URL de cada captura. Para `/auth/continue` muestra el destino visible de un visitante sin sesión. El callback está ilustrado con un enlace vencido. La revisión adicional cubrió estados de pago pendientes, aprobados, rechazados y reintegrados, además de búsquedas vacías, errores de consulta y navegación por teclado.

## Cómo interpretar la verificación

La comparación de El Nieto usa datos públicos del comercio. La primera columna se capturó en la URL publicada y la segunda en el frontend local. La compra, la gestión y las cuentas se ejercitaron con datos sintéticos. La galería incluye ambas procedencias.

El control automático de accesibilidad sobre el catálogo de El Nieto, la portada y las ocho vistas complementarias de acceso, toma de pedido y 404 registró cero infracciones en los escenarios analizados, usando las reglas WCAG A/AA seleccionadas de axe-core. Se verificó que las 90 imágenes de la galería se decodificaran y que su página cupiera tanto a 390 como a 1440 px. La revisión midió presentación, navegación y legibilidad. Un efecto sobre la conversión requiere tráfico y mediciones posteriores a la publicación.

## Regresión y rendimiento

Pasaron las 585 pruebas de Vitest, la compilación de producción, la comprobación de tipos, el linter y los presupuestos de tamaño. La tienda entrega 175,1 KiB de JavaScript y 17,6 KiB de CSS comprimidos en su grafo inicial. Las fotos se cargan aparte.

En Chromium pasaron los 85 recorridos aislados de la suite. Cuatro pruebas que requieren un entorno conectado quedaron fuera de esta ejecución. Para el catálogo público se hicieron lecturas de El Nieto. Para invitaciones, pedidos y cobros se utilizaron servicios simulados.

En una primera pasada la tienda registró una tarea inicial de 208 ms, frente a un límite de 200 ms, mientras seguían activos dos servidores de captura. Una vez cerrados, se ejecutaron tres repeticiones de tienda y tres de menú con los límites originales, red lenta y CPU cuatro veces más lenta. Pasaron las seis. En la tienda, el LCP estuvo entre 2,152 y 2,376 segundos, el CLS máximo fue 0,046 y la tarea inicial más larga llegó a 199 ms. Son mediciones de laboratorio.
