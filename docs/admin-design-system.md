# Mozzi Comercio: identidad y experiencia administrativa

Dirección elegida por el usuario: sobria y limpia, fondos claros, tipografía cuidada y naranja como acento. La identidad de Mozzi acompaña la gestión; cada comercio conserva su propia marca pública.

## Auditoría y decisiones

Revisión heurística de las vistas y sus componentes, seguida de comprobación en navegador con datos sintéticos. No es un estudio con usuarios reales.

| Área | Hallazgo | Decisión |
| --- | --- | --- |
| Navegación | Muchas opciones permanentes y una columna oscura de gran peso | Cinco tareas principales. Catálogo y configuración secundaria agrupados. Comercio y cuenta siempre identificables. |
| Inicio | Estados, importes, correcciones e informes compiten con la tarea diaria | Resumen breve, accesos útiles y detalle del día a pedido. Los importes no se presentan como pagos acreditados. |
| Productos | Fotografías grandes y tres botones coloreados por producto dificultan comparar | Listado con miniaturas, precio, estado y acciones secundarias agrupadas. |
| Editor | Código, promociones, extras y orden mezclados con los campos esenciales | Nombre, categoría, precio, stock y foto primero. Promociones, adicionales y organización se despliegan cuando hacen falta. |
| Pedidos | Estado duplicado y acciones ocasionales con mucho peso | Estado operativo y pago diferenciados. Contacto y preparación accesibles; trazabilidad y operaciones excepcionales agrupadas. |
| Stock | Explicaciones extensas, movimientos y conteos visibles a la vez | Consulta y edición directa como tarea principal. Herramientas y registros secundarios desplegables. |
| Alta de comercios | Datos opcionales y montos en centavos vuelven técnica una tarea comercial | Identidad y administrador primero. Opciones plegadas; importes en la moneda elegida, convertidos al enviar. |
| Pagos | Instrucciones y datos de conexión dominan la vista | Estado y acción contextual visibles. Información de conexión y ayuda bajo demanda. |
| Publicación | QR grandes y controles duplicados | Links compactos, QR al solicitarlos y una pantalla específica para publicar la tienda. Guardar datos generales no sobrescribe la publicación. |
| Lenguaje | Detalles de implementación en textos dirigidos al comercio | Instrucciones orientadas a tareas. Detalles de permisos, almacenamiento y servidor fuera de la navegación habitual. |

## Identidad visual

Marca: isotipo M entrelazado y firma «mozzi comercio», a partir de los originales entregados por el usuario. Los PNG de `public/brand/` conservan el dibujo, los colores y la transparencia; sólo se recortaron sus márgenes vacíos. La firma horizontal oscura se usa sobre las superficies claras del panel; la firma blanca, en la portada oscura. El isotipo se reserva para espacios compactos y el favicon cuadrado. No se sustituyen los logos ni los colores propios de cada comercio.

Implementación accesible en `src/components/MozziBrand.tsx`, con estilos importados por el componente para funcionar también al abrir directamente la portada o el acceso. El nombre accesible es «Mozzi Comercio». La portada presenta catálogo, tienda, stock y pedidos para comercios en general; el selector abre Tienda por defecto (`/t/`) y permite elegir Menú (`/r/`).

| Token | Valor | Uso |
| --- | --- | --- |
| Tinta | `#24272E` | Títulos y contenido principal |
| Secundario | `#656B76` | Ayuda, descripciones y metadatos |
| Fondo | `#F7F8FA` | Área de trabajo |
| Superficie | `#FFFFFF` | Formularios, listas y navegación |
| Borde | `#E6E8EC` | Separación discreta |
| Acento | `#FF6D00` | Color exacto de la nueva marca y acciones principales |
| Acento fuerte | `#B94700` | Enlaces, texto pequeño y foco accesible sobre superficies claras |
| Acento suave | `#FFF2E8` | Selección en navegación |
| Tinta del logo | `#121212` | Firma sobre fondos claros y texto de botones naranjas |

Los botones con fondo naranja de marca usan texto oscuro: blanco sobre `#FF6D00` no alcanza el contraste de texto normal. El panel mantiene fondos claros; la portada utiliza `#121212` con la firma blanca y acentos naranjas.

Tipografía: Inter cuando está disponible, Segoe UI y fuentes de sistema como alternativas, sin descargas externas. Un mismo estilo sans para títulos y contenido. Títulos de página entre 24–29 px, secciones 15 px y controles de escritorio 12–14 px. Inputs móviles de 16 px para evitar zoom de iOS.

Espaciado: escala de 4 px; área de trabajo de hasta 1440 px; navegación de 244 px; tarjetas de 10 px de radio y controles de 7 px. Bordes suaves y sombras mínimas. Los colores semánticos se reservan para estados que requieren distinguirse; no decoran todas las métricas.

## Reglas de interacción

- Una acción principal por contexto. Funciones secundarias accesibles por nombre, sin iconos ambiguos como único indicio.
- El stock expresa el total; sus reservas y reintentos conservan las reglas existentes.
- En celular, cada fila de stock reúne nombre, código, total, reservado, disponible y edición sin desplazamiento horizontal.
- Un pedido pagado sigue teniendo un estado operativo independiente. Cancelar no equivale a reintegrar dinero.
- Los mensajes de error, los intentos pendientes y los campos esenciales permanecen visibles. Los detalles avanzados pueden abrirse con teclado.
- El panel móvil bloquea el fondo al abrir la navegación, contiene el foco, permite Escape y restaura el foco al cerrar.
- El menú oculto no participa de la navegación por teclado. Se respeta la preferencia de movimiento reducido.
- Los estilos administrativos viven bajo `.admin-app`; no cambian colores ni presentación de las tiendas de los comercios.

## Verificación

Pruebas de regresión de formularios, permisos de navegación, carga directa de stock, publicación independiente y recuperación. Recorridos Chromium en escritorio y móvil con comprobación de desbordes, navegación por teclado, despliegue de opciones y lectura de estados. Se revisaron capturas de Inicio, Productos, editor, variantes, Stock, Pedidos, pagos, tienda, configuración, acceso, Control central y sus vistas secundarias. Los recorridos usan datos sintéticos; las pruebas que crean pedidos reales requieren activación explícita y no forman parte de este pase visual.
