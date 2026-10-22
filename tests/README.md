# Clientes: enlace a WhatsApp

Pruebas unitarias (Node, sin dependencias):

```powershell
node tests/customer-whatsapp.test.cjs
```

Prueba de navegador con Playwright disponible en el entorno de desarrollo:

```powershell
$env:PLAYWRIGHT_MODULE = 'ruta/al/modulo/playwright'
node tests/customer-whatsapp.browser.cjs
```

El navegador de prueba es Edge headless, en perfiles nuevos y con clientes
ficticios. Todos los destinos estan interceptados; no abre chats reales ni
consulta Supabase. Valida paginacion, acciones existentes, escape HTML, ausencia
de escrituras, icono local, foco, tamaño tactil y limites de la celda en 390 y
1280 px. Las capturas van al directorio temporal o a TEST_OUTPUT_DIR.

La normalizacion es solo de formato. No verifica titularidad, asignacion real
del numero ni si tiene WhatsApp. Los datos de referencia son locales; fuentes
y licencias en assets/phone-data-license.txt. El logo de WhatsApp proviene de
Bootstrap Icons, con licencia MIT en assets/bootstrap-icons-license.txt.
