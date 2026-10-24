# Eliminacion automatica por stock cero

Regla: eliminar del sistema los productos que llevan 30 dias continuos sin stock.
Las imagenes y videos propios se borran permanentemente mediante Storage API,
incluidas versiones anteriores dentro de la carpeta UUID de ese producto.
Una reposicion reinicia el reloj; las fechas desconocidas empiezan al instalar.
No depende de la paginacion ni de tener abierta la aplicacion.

## Conservacion del historial

El codigo queda libre al retirar el producto. Cuando termina la eliminacion de
archivos, se borran las filas de imagenes y se vacian los campos de video.
Si no existen referencias historicas, tambien se eliminan producto y variantes.
Si ventas o movimientos los necesitan, las claves foraneas conservan unicamente
los registros tecnicos necesarios, fuera del listado y del catalogo, sin archivos.
No se eliminan ventas, pagos, costos historicos ni movimientos.
Archivos externos o referenciados por otros productos no se borran.

## Activacion (no esta activa por agregar estos archivos a GitHub)

1. En el Supabase de Nexo habilitar Integrations > Cron (pg_cron) y la extension
   pg_net. Vault debe estar disponible.
2. Ejecutar el SQL de preparacion de Vault. Genera un secreto privado aleatorio
   llamado nexo_cleanup_secret sin duplicarlo. No compartirlo ni guardarlo en Git.
3. Copiar ese valor a Edge Functions > Secrets como CLEANUP_FUNCTION_SECRET.
   No usar la clave publica. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son variables
   del servidor y no deben incluirse en el frontend.
4. Publicar cleanup-stale-products con sus dos archivos index.ts y worker.mjs.
   Desactivar Verify JWT para esa funcion: el handler valida el secreto privado.
   Con CLI: supabase functions deploy cleanup-stale-products --no-verify-jwt.
   El config.toml contiene solamente la configuracion de esta funcion.
5. Ejecutar el SQL combinado corregido de la entrega. Incluye ambas migraciones
   en una sola transaccion. No utilizar el SQL anterior de solo archivado.
   En instalaciones por migraciones, aplicar 202610240001 y 202610240002 en orden
   despues de configurar el servidor.

La instalacion no borra productos inmediatamente. A las 03:00 de Argentina
(06:00 UTC), el worker retira los productos vencidos y procesa los archivos.
Cada 15 minutos reintenta solo eliminaciones pendientes, en lotes de 10.
El handler solo permite vencer productos en la ventana diaria 06:00-06:14 UTC.
Si se interrumpe o falla Storage, la cola no se confirma y se reintenta.
El secreto ausente o incorrecto impide toda operacion. Las rutas se limitan
a las carpetas UUID del producto: reutilizar un codigo no comparte sus archivos.
Una pantalla abierta puede necesitar recargar para descartar su cache.

## Verificacion

En Cron deben estar activos nexo-cleanup-zero-stock-30d y
nexo-retry-product-media-cleanup. Los logs de pg_cron verifican el envio HTTP,
no la eliminacion de archivos: revisar tambien el estado HTTP de pg_net,
los logs de Edge Functions y la cola.

```sql
select jobname, schedule, active from cron.job
where jobname in ('nexo-cleanup-zero-stock-30d','nexo-retry-product-media-cleanup');

select product_id, created_at, leased_until, completed_at
from public.product_cleanup_queue order by created_at desc limit 50;

select created_at, entity_id, action, payload
from public.audit_log
where action in ('auto-archive-zero-stock','auto-delete-product-media')
order by created_at desc limit 50;
```

completed_at solo se escribe despues de que Storage confirma las eliminaciones.
Los archivos borrados son irrecuperables. Para pausar, desactivar ambos jobs.
Nunca hacer DELETE directamente sobre storage.objects en produccion: no elimina
los archivos reales. Referencia: https://supabase.com/docs/guides/storage/management/delete-objects

## Pruebas

- tests/zero-stock-cleanup.test.cjs: SQL real en PGlite, con PGLITE_MODULE apuntando
  a pglite/dist/index.cjs. Stock, reposicion, 30 dias, cola, leases, permisos,
  eliminacion fisica y conservacion de ventas.
- tests/zero-stock-worker.test.cjs: node sin dependencias. Storage simulado,
  imagenes/videos, errores parciales, reintentos, rutas propias y autenticacion.

No acceden a Supabase ni borran archivos reales. Vault/pg_net/Cron y Storage se
simulan; los bloqueos entre sesiones requieren PostgreSQL hospedado.

## Estado de la instalacion de Nexo

El 24/10/2026 el usuario confirmo la configuracion y mostro cuatro invocaciones
automaticas POST con respuesta 200, separadas por 15 minutos. Esto verifica la
programacion y la respuesta del worker, no un borrado real. Sigue pendiente
comprobar la primera eliminacion de un producto que cumpla los 30 dias.
