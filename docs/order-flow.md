# Flujo de pedidos

## Principio

El pedido queda **generado** cuando Supabase lo persiste. Abrir WhatsApp no prueba que el mensaje se envió. El primer reconocimiento verificable del restaurante ocurre cuando una persona autorizada lo toma.

```mermaid
sequenceDiagram
  actor C as Cliente
  participant SPA as SPA
  participant CO as create-order
  participant DB as PostgreSQL
  participant WO as register-whatsapp-opened
  participant WA as WhatsApp
  actor O as Operador

  C->>SPA: Completa checkout
  SPA->>CO: POST IDs, cantidades, datos e idempotencyKey
  CO->>CO: CORS, tamaño, honeypot y rate limit
  CO->>DB: Persistencia transaccional y cálculo server-side
  DB-->>CO: Pedido, snapshots y token hasheado
  CO-->>SPA: Resumen canónico + wa.me + token si aplica
  C->>SPA: Pulsa Abrir WhatsApp o Abrir WhatsApp Web
  SPA->>WO: POST actionId + clientEventToken
  WO->>DB: generated -> whatsapp_opened, idempotente
  SPA->>WA: Navega aunque falle la telemetría
  WA-->>O: Mensaje con /admin/pedidos/tomar/:actionId
  O->>SPA: GET de la vista
  Note over SPA,DB: GET solo lee; nunca acepta el pedido
  SPA->>DB: Consulta autenticada y autorizada
  O->>SPA: Pulsa Tomar pedido
  SPA->>DB: RPC claim_order(actionId)
  DB-->>SPA: Ganador o estado ya tomado
```

## 1. Carrito y checkout

El carrito pertenece a un solo `restaurantSlug`. Cambiar de restaurante limpia o separa el carrito. La estimación del navegador mejora la UX, pero no es autoridad.

La solicitud envía:

- slug del restaurante;
- UUID de idempotencia generado por intento lógico;
- nombre y teléfono;
- modalidad y, para envío, zona y dirección;
- ID del medio de pago;
- IDs de producto y opción, cantidades y notas;
- honeypot, instante de inicio y token CAPTCHA opcional.

No envía como fuente de verdad precios, porcentajes ni totales.

## 2. Validaciones de servidor

`create-order` aplica, antes de confirmar:

1. método y origen permitidos;
2. límite de bytes y esquema Zod;
3. honeypot y tiempo mínimo del formulario;
4. si `TURNSTILE_ENABLED=true`, presencia del token y verificación server-side con Siteverify;
5. rate limit persistente por restaurante, teléfono normalizado e IP hasheada con HMAC; se consume antes de la transacción de creación para que los intentos rechazados también cuenten;
6. restaurante activo, menú publicado y modalidad habilitada;
7. horario del servidor en la zona del restaurante, incluidas excepciones y turnos nocturnos;
8. zona, pedido mínimo, productos disponibles y selecciones por grupo;
9. medio de pago vigente;
10. idempotencia y límites de ítems/cantidades.

La IP cruda no se persiste. Los errores devueltos son códigos sanitizados, sin mensajes internos de PostgreSQL.

## 3. Cálculo y persistencia

La base calcula con enteros, en este orden:

1. precio promocional si está vigente; de lo contrario, precio base;
2. adicionales válidos por unidad;
3. cantidad y subtotal;
4. ajuste porcentual/fijo según alcance del medio de pago;
5. costo de la zona y eventual envío gratis;
6. total no negativo.

Los porcentajes se expresan en basis points y se redondean de manera determinista a centavos. La misma transacción reserva el correlativo, inserta pedido, ítems, opciones, primer evento y token hasheado. Repetir la misma `idempotencyKey` para el mismo restaurante devuelve el pedido existente y no consume otro número.

## 4. Respuesta y mensaje

La respuesta contiene solo lo necesario para la UI:

- `actionId`, número visible, estado, fecha, moneda y total;
- teléfono, mensaje canónico y URL `wa.me`;
- token efímero para registrar la apertura mientras corresponda; en el replay de un pedido que ya avanzó puede ser `null`.

El mensaje incluye el detalle y `/admin/pedidos/tomar/:actionId`. La URL no lleva nombre, teléfono, dirección, JWT ni token administrativo.

## 5. Apertura de WhatsApp

La SPA registra el intento mediante `POST` y después abre WhatsApp. El token:

- se guarda solo como hash;
- expira;
- no permite leer el pedido;
- no permite tomar, cancelar ni completar;
- acepta reintentos sin producir transiciones adicionales.

Si el token no está disponible o el registro falla, la UI igual abre WhatsApp y conserva una opción para copiar el texto.

## 6. Enlace administrativo

Al abrir el enlace:

1. si falta sesión, se redirige a login con un `returnTo` relativo validado;
2. la base verifica membresía activa en el restaurante;
3. la pantalla muestra un resumen y el estado actual;
4. nada cambia hasta pulsar **Tomar pedido**.

`claim_order` usa `auth.uid()`, no acepta `restaurant_id` del navegador y hace un `UPDATE` condicionado a `generated` o `whatsapp_opened`. Si dos operadores compiten, uno recibe `accepted`; el otro recibe el ganador ya persistido. Nunca se sobrescriben `accepted_by` ni `accepted_at`.

## 7. Estados

| Estado | Significado | Transiciones normales |
|---|---|---|
| `generated` | Persistido y mensaje generado | `whatsapp_opened`, `accepted`, `cancelled`, `expired` |
| `whatsapp_opened` | Se intentó abrir WhatsApp; no prueba envío | `accepted`, `cancelled`, `expired` |
| `accepted` | Un usuario autorizado lo tomó | `completed`, `cancelled` |
| `completed` | Operación finalizada | Terminal |
| `cancelled` | Cancelado con motivo y actor | Terminal |
| `expired` | No fue tomado dentro de la ventana | Terminal |

Cada transición operativa agrega un `order_events` inmutable y, cuando corresponde, un `audit_logs`. Los campos de actor y fecha se escriben mediante RPC, no con edición libre.

## 8. Casos de fallo esperados

| Caso | Respuesta segura |
|---|---|
| Doble clic o reintento de red | Misma idempotency key; no duplica |
| Precio editado en DevTools | Se ignora y recalcula desde la base |
| Producto agotado o menú cerrado | Rechazo antes de persistir |
| Turnstile activo sin token o con token inválido | Rechazo antes de rate limit/creación; la validación ocurre en Edge |
| Opción de otro producto | Rechazo por relación/validación |
| Dos operadores toman a la vez | Un único ganador atómico |
| Bot de vista previa abre el enlace | Solo GET; no cambia el estado |
| Usuario de otro restaurante conoce `actionId` | RLS/RPC niega lectura y mutación |
| Telemetría de WhatsApp falla | WhatsApp abre; estado puede quedar `generated` |

Los estados deben interpretarse con estas semánticas al calcular métricas: `generated` y `whatsapp_opened` no son ventas confirmadas.
