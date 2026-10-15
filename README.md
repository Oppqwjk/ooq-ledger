# OOQ Ledger

Caja real, pedidos, stock, reponer, calendario P&L, gastos y metas del negocio de relojes.
Web app instalable (PWA), sin build: HTML + JS. Datos en el dispositivo (IndexedDB) y sincronizados con Supabase.

## Cómo cuenta el dinero
- **Caja real** = lo que pusiste en Ajustes + ventas + ingresos − pedidos − DHL − gastos apuntados después de ese momento.
- **Flujo de caja del mes** = todo lo que entra − todo lo que sale ese mes (un pedido de 500 € y una venta de 30 € = −470 €).
- **Beneficio** = precio de venta − coste puesto − gastos del negocio. Los pedidos no restan beneficio: su coste va en cada venta.
- **Pedidos**: lo pagado hoy sale de la caja al guardarlo; el cobro de DHL al marcarlo como recibido. Cada venta posterior de ese reloj cuenta para "recuperado" (primero en entrar, primero en salir).
- **Reponer**: ritmo de ventas de los últimos 14 días → si el stock cubre menos de 10 días, sugiere pedir para 30 días.

## Configuración
1. Supabase: ejecuta `schema.sql` en el SQL Editor y pon el código `{{ .Token }}` en la plantilla Magic Link.
2. Pega la Project URL y la anon key en `config.js`.
3. Supabase → Authentication → URL Configuration: pon la URL de la web como Site URL y Redirect URL.
4. Tras entrar la primera vez, desactiva "Allow new users to sign up".

## Actualizar
Cambia `VERSION` en `sw.js` en cada cambio para que el móvil coja los archivos nuevos.
