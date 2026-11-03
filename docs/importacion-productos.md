# Importación de productos de otros sistemas

El panel de importación permite cargar XLS, XLSX, ODS, CSV y TSV sin transformar el archivo a la plantilla Mozzi. Los archivos se leen en el navegador; sólo se envían los productos normalizados al confirmar la importación.

## Recorrido

1. Seleccionar el archivo de productos. Mozzi propone una hoja, fila de encabezados y relación de columnas.
2. Revisar las columnas y sus ejemplos. Corregir las que no se reconocieron o las que tengan varias interpretaciones posibles (por ejemplo, varias listas de precios).
3. Elegir cómo se obtiene la categoría: una columna por producto, títulos entre bloques o una categoría fija para todo el archivo.
4. Revisar las filas originales y los errores. Una fila incompleta no se descarta automáticamente: se corrige el mapeo, se corrige el archivo o se excluye expresamente para esa carga.
5. Opcionalmente recordar el formato en este navegador. El perfil pertenece al comercio seleccionado y no contiene productos, precios ni exclusiones de filas.
6. Pulsar **Revisar importación**, elegir el modo y confirmar con **Importar catálogo**. El primer paso no escribe en la base de datos.

Se conserva la plantilla existente, incluidas las hojas `GruposOpciones` y `Opciones`, las familias/variantes y el ZIP opcional de imágenes.

## ZIP de imágenes

En **Productos e imágenes**, la columna `imagen_archivo` indica la ruta dentro del ZIP. Una carpeta envolvente también funciona si el nombre del archivo es único; si hay dos imágenes con el mismo nombre, debe indicarse la ruta completa. Antes de importar se muestran las imágenes encontradas y las referencias que coinciden. Un ZIP inválido o una referencia faltante bloquea el envío de los productos hasta corregirlo.

En **Sólo imágenes** se actualizan fotos de productos ya existentes, sin enviar precios, nombres, stock ni categorías. Los archivos se vinculan primero por SKU exacto sin extensión (`000123.png`) y luego por prefijo único seguido de guion bajo (`000123_yerba.png`). Se conservan los ceros iniciales; mayúsculas y espacios exteriores siguen la normalización del SKU del catálogo. No se comparan nombres de productos ni se elige entre varios prefijos posibles.

La vista previa permite cambiar el SKU o excluir cada imagen. Las coincidencias faltantes y los productos con varias fotos asignadas requieren corrección antes de guardar. El ZIP descargado desde Productos incluye un manifiesto que conserva la relación producto/SKU/archivo; sólo se aceptan automáticamente sus identificadores dentro del comercio de origen, con el mismo SKU.

Ambos flujos admiten JPEG, PNG y WebP, hasta 100 MB comprimidos, 250 MB descomprimidos y 15 MB por imagen. Se validan rutas originales, CRC y formato antes de guardar. Archivos auxiliares de macOS y otros documentos se ignoran; no se ejecutan instrucciones ni archivos incluidos en el ZIP. Las imágenes se reprocesan a las variantes WebP del catálogo.

Las cargas de imágenes guardan sus intentos antes de asociar cada archivo al producto. **Continuar imágenes pendientes** recupera respuestas perdidas y no vuelve a subir imágenes confirmadas. Al volver a abrir el navegador debe seleccionarse el mismo ZIP. Si otra persona cambia una foto desde la vista previa, esa foto no se sobrescribe: el error se informa para revisar una nueva carga. **Detener** conserva lo ya guardado y permite continuar. Las sesiones de imágenes se separan por comercio, contenido del ZIP y asignaciones, sin modificar las identidades de importación de productos.

## Actualizaciones frecuentes

Conservar siempre la misma columna como Código / SKU. Los códigos identifican productos dentro del comercio; los nombres no se usan para buscar coincidencias. Los códigos de barras pueden funcionar como SKU. Si el archivo sólo tiene una referencia interna estable, se puede relacionar esa columna con Código / SKU.

Los archivos siguientes con el mismo formato recuperan la configuración guardada. Cambiar encabezados, posiciones o la estructura de los separadores obliga a revisar la configuración. Si coinciden varios perfiles, se elige manualmente. Los perfiles son locales al navegador/dispositivo; no se comparten entre administradores.

Los campos opcionales sin relacionar conservan su valor actual. Relacionar una descripción o promoción y enviar una celda vacía puede borrar ese valor. Un producto ausente del archivo no se elimina ni se desactiva. Esto permite trabajar con reportes filtrados, como una lista de productos activos.

Sin código ni identificador, una fila crea un producto nuevo y requiere una confirmación visible antes de enviar el lote. Para actualizarlo después, usar el código del resultado descargado. **Sólo actualizar existentes** exige identidad en todas las filas.

Los reintentos mantienen el mismo lote. Volver a seleccionar datos idénticos recupera el intento anterior, incluso si ya terminó; para volver a aplicar deliberadamente esos datos existe **Iniciar otra importación con estos datos**. Cambiar los precios genera contenido diferente y un nuevo lote.

## Reconocimiento y límites

- Alias de encabezados en español e inglés, sin distinguir mayúsculas ni acentos. Las coincidencias ambiguas requieren elegir una columna.
- Filas de títulos y encabezados repetidos en reportes agrupados. La vista previa conserva los números de fila del archivo original.
- Precios con símbolo `$`/`ARS`, separadores decimales de coma o punto y miles. Un texto ambiguo como `1.234` requiere seleccionar el formato; no se adivina su importe.
- Códigos de texto y ceros iniciales conservados. Celdas numéricas con formato de ceros se conservan como texto. Los códigos numéricos enteros de hasta 15 dígitos se convierten con advertencia; códigos numéricos inseguros bloquean la carga.
- CSV/TSV con delimitadores comunes y codificaciones UTF-8, Windows-1252 o UTF-16 con BOM. Las fórmulas no se ejecutan; en planillas se usan valores calculados guardados y se señalan errores o resultados ausentes.
- Hasta 500 productos, 2.500 grupos y 10.000 opciones por importación; 10 MB de archivo. Títulos y separadores no cuentan como productos.
- La lectura se limita a 20.000 filas y 200 columnas por hoja, 30 hojas, un millón de celdas y 64 MB descomprimidos. Estas cotas no aumentan el límite de productos.
- Se guardan hasta 10 formatos por comercio en cada navegador. Las exclusiones de filas no se recuerdan: cambian entre exportaciones.

Stock, costos y precios por cantidad todavía no se cargan por este flujo. Las columnas no relacionadas se muestran explícitamente como fuera de la importación. PDF, imágenes y archivos sin estructura tabular no forman parte de los formatos compatibles.

## Implementación y comprobaciones

`import-file.ts` lee archivos como matrices; `import-mapping.ts` reconoce y normaliza; `import-profiles.ts` conserva la configuración. El resultado pasa por `parseImportSheets`, sesiones idempotentes y la API existente. La carga de imágenes comparte un ejecutor que sube y registra los archivos, y asocia `image_path` con una escritura condicionada a la imagen esperada, bajo los permisos existentes del comercio.

El historial local conserva completa la última sesión, los intentos sin resultado confirmado y las importaciones con imágenes. Los lotes anteriores completados sin errores ni imágenes se compactan a recibos de identidad, sin eliminar sus identificadores. Si se vuelve a cargar el mismo contenido, el resultado se recupera del servidor usando el lote original. Esto reduce el crecimiento del almacenamiento en las actualizaciones diarias sin permitir que una pestaña vieja transforme un lote terminado en uno nuevo.

La lectura Excel usa SheetJS CE 0.20.3 fijado a su distribución oficial, con carga diferida. La distribución npm antigua de `xlsx` no se usa. Referencia: [instalación oficial de SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/).

Las pruebas cubren el reporte agrupado, formatos alternativos, identidad, columnas omitidas, errores, perfiles aislados por comercio y cambios de archivo/comercio durante operaciones asíncronas. Las pruebas de navegador interceptan el backend y no escriben en comercios reales.
