# Nexo: carga, operaciones y cache

Estado: Supabase de Nexo conectado; pruebas operativas realizadas por el usuario.
No se inicializo Git ni se publico en servicios externos.

## Referencia replicada

- Fuente: proyecto BlackShoes, consultado sin modificarlo ni copiar credenciales.
- RPC de ventas, pagos, stock y gastos; confirmacion luego del resultado del servidor.
- Inicio: configuracion, categorias, opciones de filtros, resumen mensual y
  cierres. Sin snapshot de ventas, gastos ni movimientos de stock. Las paginas
  de productos y clientes se solicitan al entrar a su vista; Ventas solicita una
  primera pagina acotada de ambos como apoyo para sus selectores.
- Paginas: productos 30, clientes/gastos 40, ventas/stock 20 y detalle de cliente 10.
- Maps independientes de resultados, cargas pendientes y fallos por modulo.
  Claves con pagina, tamano y filtros. Reutilizacion de cargas y limpieza finally.
- En productos: metadatos por filtros, precarga vecina y control de respuesta actual.
- Espera de 30 segundos tras un error. NO es un TTL de resultados.
- Dashboard y reportes por RPC agregada sobre todo el periodo, no sobre el snapshot.
- Cierres mensuales: resumen calculado en PostgreSQL, unico por mes, recuperado
  durante inicio y sincronizacion. Eliminar un cierre no elimina operaciones.
- Catalogo: listado paginado, detalle/relacionados, debounce 250 ms y descarte
  de respuestas obsoletas. Visibilidad por stock en SQL antes de contar.
- PWA: archivos network-first para HTML/JS/CSS; Maps de consultas independientes.
  Borradores y preferencias locales no confirman operaciones remotas.

No se agregaron TTL general, SWR, Realtime ni polling. Los eventos heredados
de foco siguen sin activar el refresh del modo de sincronizacion anterior.

## Adaptaciones y mejoras propias

- Stock unico visible por producto. PostgreSQL conserva una unica fila UNICO
  interna para reutilizar validaciones y bloqueos transaccionales del esquema.
- Venta devuelve productos afectados; reposicion devuelve producto, movimiento
  y gasto. El frontend incorpora estas respuestas sin descargar todo.
- Productos con operation_id estable durante reintentos; wrapper idempotente
  y movimiento de ajuste de stock registrado en servidor.
- Costo manual: el servidor calcula desde el precio y porcentaje configurado.
- Revision de cache: una peticion iniciada antes de una invalidacion no puede
  volver a insertar resultados anteriores. No es TTL ni SWR.
- Si falta el resumen remoto, dashboard/reportes no presentan sumas parciales
  del snapshot como totales completos.
- El catalogo ya no descarga toda la vista como fallback de una RPC fallida.
- Cache PWA limitado al mismo origen y limpieza limitada a caches de Nexo.
- Rutas de catalogo compatibles con archivos locales y rutas limpias de Vercel.
- Solo se renderiza la vista activa; las tablas ocultas no consultan por render.
- Total mensual de Ventas desde RPC agregada. Filtros y periodos historicos desde
  get_navigation_metadata, sin depender de las filas visitadas.
- Gastos fijos: save_fixed_expenses_batch, lote atomico e idempotente. Una fila
  activa por plantilla y mes; una nueva carga del mismo mes actualiza el importe.
  Una anulacion conserva el historico y permite cargar nuevamente esa plantilla.
  La clasificacion fija se aplica tambien en la tabla y los reportes.

## Configuracion y migraciones

1. Crear un Supabase exclusivo para Nexo.
2. Aplicar TODAS las migraciones en orden de nombre. Se resolvio la version
   repetida: report_real_income ahora usa 202610030004.
3. Revisar RLS y aprobar un administrador en el proyecto nuevo.
4. Completar config.js con URL y clave publica del nuevo proyecto y enabled:true.
   Este frontend estatico no lee automaticamente variables .env de Vercel.
   Jamas usar una service-role key en config.js ni en el navegador.
5. Configurar URL del sitio y redirecciones de Auth para el dominio de Vercel.
6. Probar en staging antes de habilitar operaciones reales.

Las funciones *_base e internal_product_snapshot son privadas: su ejecucion
directa se revoca a anon y authenticated; solo las usan wrappers autorizados.
Clientes y ajustes conservan escrituras directas protegidas por RLS, como
en la referencia. No todas las escrituras usan RPC.

## Verificacion realizada

Actualizacion por demanda: prueba de contratos sin snapshot, metadatos
deduplicados, render de vista activa y rechazo/reintento/confirmacion de gastos
fijos. Ejecutar 202610200003_on_demand_fixed_expenses.sql antes de probar esta
version con Supabase. No se ejecuto ese SQL desde Codex. Los gastos fijos locales
anteriores no se importan automaticamente: revisar antes de volver a cargarlos.

Pruebas de navegador con RPC simuladas: consulta unica por clave, regreso
inmediato a paginas cacheadas, separacion por pagina, descarte tras invalidacion,
fallo/cooldown/reintento forzado, resumen mensual independiente del snapshot,
parametros de snapshot inicial/full, cierre rechazado sin confirmacion local,
cierre unico por mes y respuestas del catalogo fuera de orden. Sintaxis JS verificada.

El usuario ejecuto la instalacion inicial y confirmo ingreso, productos, ventas,
stock, compras, cobros, gastos y cierres mensuales con persistencia real.
Los tests simulados no reemplazan una auditoria de RLS ni concurrencia SQL.

## Limites que deben revisarse antes de publicar

- Videos: ejecutar 202610200002_product_videos.sql y probar carga, recarga,
  reemplazo, eliminacion y catalogo. MP4/WebM, hasta 30 segundos, 5 MB y sin audio.
  El catalogo reproduce al solicitarlo, sin descargar videos en el listado.
  El bucket es publico como el de fotos: los enlaces conocidos son accesibles.
  Reemplazar o quitar desvincula el archivo; no borra archivos antiguos del bucket,
  para no romper guardados de resultado incierto. Su limpieza es una tarea aparte.
- Cierre de caja diario retirado; se conservan los cierres mensuales y registros
  historicos existentes. No se borraron datos financieros.
- Precios masivos: ejecutar 202610200005_bulk_product_prices.sql. Operacion
  atomica con auditoria por producto e idempotencia por operation_id. Alcanza
  todos los productos activos de la categoria elegida o de toda la base, no
  solo filas visitadas. Actualiza precio de lista, no costos ni promociones.
  Confirmacion local y refresco de paginas solo tras respuesta del servidor.
  Contratos frontend probados; SQL pendiente de instalacion y prueba real.
- GitHub y Vercel pendientes de desplegar y verificar.
