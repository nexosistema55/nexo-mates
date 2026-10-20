# Nexo - GitHub, Vercel y Supabase

## Cuenta GitHub

Usar un repositorio, proyecto Vercel y Supabase nuevos para Nexo.

Herramientas opcionales para publicar:

- `gh`
- `vercel`
- `supabase`

Se puede usar la interfaz web o las CLI disponibles. Comprobar cuenta y destino
antes de publicar. Git todavia no se inicializo.

## Nombre tecnico sugerido

Repositorio:

`sistema-base-comercios-control`

Proyecto Vercel:

`sistema-base-comercios-control`

Supabase:

`sistema-base-comercios-control-prod`

## Pasos seguros

1. Crear un repositorio nuevo vacio en la cuenta correcta de GitHub.
2. Inicializar Git localmente en esta carpeta.
3. Hacer el primer commit.
4. Asociar el remote del repo correcto.
5. Subir la rama principal.
6. Crear proyecto nuevo en Supabase.
7. Aplicar todas las migraciones de `supabase/migrations/` en orden, no solo core.
8. Crear el proyecto en Vercel importando ese repo.
9. Completar `config.js` con URL y clave publica del proyecto nuevo y activar
   `enabled`. El frontend estatico no lee automaticamente variables .env.
10. Configurar Auth con el dominio nuevo y probar permisos y operaciones.

## Importante antes de activar Supabase en produccion

El flujo activo cloud usa RPC para ventas, pagos, stock, gastos y cierres
mensuales. localStorage conserva preferencias, borradores y datos descargados;
no es prueba de confirmacion en el servidor.

Revisar `ARQUITECTURA-CARGA-CACHE.md`: detalla la implementacion, pruebas
simuladas y limites que siguen pendientes antes del despliegue.

No colocar claves privadas ni service-role en archivos del frontend.
La ejecucion SQL, RLS y concurrencia reales siguen sin verificar hasta disponer
del Supabase destino. No publicar como produccion basandose solo en mocks.

