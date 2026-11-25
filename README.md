# SplitX — Distribución y Denominación de Efectivo de Nómina

Aplicación web estática (sin servidor ni base de datos remota) para calcular el desglose óptimo de billetes y monedas por empleado, generar solicitudes de retiro bancario, imprimir sobres/hojas de firmas y redactar documentos personalizados de empleados desde el navegador.

Producción: [https://splitx.erlin.do](https://splitx.erlin.do) (publicado con GitHub Pages vía [`CNAME`](CNAME)).

---

## Objetivos y alcance

- **Qué resuelve:**
  - Reparto exacto de nómina en efectivo según inventario disponible y límites bancarios por denominación (`CashOptimizer.js` + `SplitXCore.js`).
  - Importación desde **Sistema de Asistencia (SA)** (la aplicación externa de asistencia y cálculo de nómina del mismo ecosistema) vía `window.postMessage`, pegado desde **Excel / TSV** (*Tab-Separated Values*: nómina simple de 3 columnas, nómina de 7 columnas o el orden completo de 8 columnas exportado por SplitX) o **JSON**.
  - Exportación de reportes a **CSV** (protegido contra *CSV Formula Injection*), **Excel (`.xlsx`)** y **PDF**.
  - **Estudio de Hojas** (sobres de pago y hojas de firmas con constructor visual de fórmulas por *chips* — fichas arrastrables de campos, números y operadores como `+`, `-`, `×`, `%`) y **Documentos personalizados** (cartas/constancias con sustitución de campos; véase [`docs/employee-documents.md`](docs/employee-documents.md)).
  - Respaldo completo versionado (`splitx-backup/v1`), restauración atómica validada y purga selectiva de datos personales (**PII**, *Personally Identifiable Information*).
- **Qué NO es:** No tiene backend, cuentas de usuario, sincronización en la nube ni cifrado del lado del servidor. Todos los datos viven localmente en el navegador del dispositivo.

---

## Requisitos e inicio rápido

- **Requisitos:**
  - **Navegador moderno** (Chrome, Edge, Firefox o Safari) para usar la aplicación.
  - **Node.js 20.x o superior** para desarrollo, compilación CSS y pruebas (o Python 3 si solo quieres levantar un servidor HTTP estático rápido).
- **Inicio rápido en local:**
  ```bash
  git clone https://github.com/ERCamilo/SplitX.git
  cd SplitX

  # Opción A (con Node.js):
  npx serve . -l 8080

  # Opción B (con Python 3):
  python -m http.server 8080
  ```
  Abre `http://localhost:8080/` en tu navegador.
- **No abras `index.html` directamente por `file://`:** los navegadores bloquean `fetch('document-studio.html')` sobre `file://` (rompiendo *Documentos personalizados*) y además restringen `localStorage` en carpetas sincronizadas como OneDrive.
- **Sin `npm install` obligatorio:** las pruebas unitarias usan `node --test` nativo; `typecheck` y `build:css` invocan versiones fijadas mediante `npx` (requieren acceso a Internet solo la primera vez que se descargan en la caché local de `npx`). `node_modules/` está en [`.gitignore`](.gitignore).

---

## Arquitectura

SplitX es una aplicación estática sin *bundler* JS. Cada módulo usa formato **UMD** (*Universal Module Definition*: expone `window.*` en el navegador y `module.exports` en Node.js para pruebas unitarias directas). Los scripts se cargan en orden explícito en `<head>` de [`index.html`](index.html); si agregas un módulo nuevo, debes declararlo en `<script src="js/...">` respetando sus dependencias y actualizar [`types/umd-globals.d.ts`](types/umd-globals.d.ts) y [`jsconfig.json`](jsconfig.json).

```text
SplitX/
├── index.html                    # Entrada única de la app, vistas, modales y orquestación de UI
├── document-studio.html          # Fragmento HTML (sin <html>/<body>) cargado vía fetch() en #documentStudio
├── css/
│   ├── tailwind.input.css        # Directivas fuente de Tailwind CSS
│   ├── tailwind.css              # Bundle CSS minificado compilado localmente (sin Play CDN)
│   └── document-studio.css       # Estilos propios del estudio de documentos (no usa Tailwind)
├── imagenes/                     # Favicon, logotipo y activos visuales de billetes/monedas DOP
├── js/
│   ├── CashOptimizer.js          # Algoritmo de optimización de denominaciones
│   ├── SplitXCore.js             # Cálculo de distribución, necesidades bancarias y redondeo
│   ├── SplitXState.js            # Lectura tolerante de Split_data y recuperación ante JSON dañado
│   ├── SplitXStorage.js          # Adaptador de localStorage + fallback en memoria multi-clave (no persiste al recargar)
│   ├── SplitXCurrencies.js       # Presets de moneda, estilos de billetes y sanitización XSS/CSS/imágenes
│   ├── SplitXBackup.js           # Respaldo íntegro splitx-backup/v1, validación atómica y purga de PII
│   ├── SplitXBridge.js           # Puente cross-origin postMessage con Sistema de Asistencia (SA)
│   ├── SplitXImport.js           # Normalización de empleados y validación del payload de nómina
│   ├── SplitXExcelImport.js      # Parseo regional estricto (parseMoney: auto/en/es), detección de encabezados y TSV
│   ├── SplitXImportHistory.js    # Historial de últimas 10 importaciones con límite de cuota
│   ├── SplitXExport.js           # Exportación CSV local + carga diferida (lazy) de SheetJS (XLSX) y jsPDF
│   ├── SplitXDialogs.js          # Diálogos modales reutilizables (alert/confirm/choice)
│   ├── SplitXEmployeeCard.js     # Renderizado de tarjetas de empleados y asesor de faltantes de billetes
│   ├── SplitXSheetFields.js      # Catálogo de campos dinámicos para hojas y documentos
│   ├── SplitXVariables.js        # Variables y fórmulas reutilizables para impresión
│   ├── SplitXFormulaBuilder.js   # Constructor visual de fórmulas por chips
│   ├── SheetBuilder.js           # Evaluación de chips/fórmulas y maquetación/paginación de sobres (cards)
│   ├── SheetStudio.js            # Interfaz del Estudio de Hojas, maquetación de hojas de firmas (table) e impresión
│   ├── SplitXDocuments.js        # Plantillas de documentos, sustitución de campos y sanitización HTML
│   └── DocumentStudio.js         # Interfaz de Documentos personalizados + fetch() del fragmento + Mammoth lazy
├── types/umd-globals.d.ts        # Declaraciones globales para TypeScript checkJs
├── tests/                        # Pruebas unitarias (Node) y E2E en navegador real (tests/e2e/, Playwright)
├── qa/chip-formulas/             # Suite aislada de QA para el constructor de fórmulas por chips
├── docs/employee-documents.md    # Guía funcional y límites de Documentos personalizados
├── package.json                  # Scripts de pruebas, verificación de tipos y compilación CSS
├── jsconfig.json                 # Configuración de verificación estática checkJs (10 de 20 módulos)
├── tailwind.config.js            # Configuración de Tailwind CLI v3 (escanea index.html y js/**/*.js)
├── CNAME                         # Dominio personalizado de GitHub Pages (splitx.erlin.do)
└── .github/workflows/            # CI: test.yml (Test Suite) y qa-chip-formulas.yml
```

---

## Dependencias externas, seguridad y modo sin conexión

### Inventario de dependencias externas y estrategia de integridad (SRI)

**SRI** (*Subresource Integrity*) obliga al navegador a verificar el hash criptográfico `sha384` de cada recurso externo antes de ejecutarlo o aplicarlo.

| Recurso | Versión fijada | Carga | Integridad y políticas | Estrategia / actualización |
| :--- | :--- | :--- | :--- | :--- |
| **Tailwind CSS** | `3.4.17` (CLI) | **Local** (`css/tailwind.css`) | Compilado en el repositorio (reemplaza al *Play CDN* en tiempo de ejecución) | Ejecutar `npm run build:css` tras modificar clases Tailwind en `index.html` o `js/*.js` |
| **Font Awesome** | `6.4.0` (`cdnjs`) | Inicial (`index.html`) | `integrity="sha384-..."`, `crossorigin="anonymous"`, `referrerpolicy="no-referrer"` | Versión inmutable fijada; al actualizar, recalcular `sha384` en `index.html` |
| **Google Fonts** (`Inter`, `JetBrains Mono`, `Roboto`) | CSS2 API | Inicial (`index.html`) | Política base `<meta name="referrer" content="strict-origin-when-cross-origin">` | Mejora progresiva; si falla, el navegador usa `sans-serif`/`monospace` del sistema |
| **SheetJS (`xlsx`)** | `0.18.5` (`cdnjs`) | **Bajo demanda (lazy)** en `js/SplitXExport.js` | `sha384-`, `crossOrigin="anonymous"`, `referrerPolicy="no-referrer"` | Solo se descarga al pulsar *Exportar Excel* |
| **jsPDF + AutoTable** | `2.5.1` / `3.5.28` (`cdnjs`) | **Bajo demanda (lazy)** en `js/SplitXExport.js` | `sha384-`, `crossOrigin="anonymous"`, `referrerPolicy="no-referrer"` | Solo se descargan al pulsar *Exportar PDF* |
| **Mammoth** | `1.13.0` (`cdnjs`) | **Bajo demanda (lazy)** en `js/DocumentStudio.js` | `sha384-`, `crossOrigin="anonymous"`, `referrerPolicy="no-referrer"` | Solo se descarga al importar un archivo `.docx` |

Para recalcular un hash `sha384` al actualizar una versión en `cdnjs` (y contrastarlo contra `https://api.cdnjs.com/libraries/<lib>/<ver>?fields=sri`):

```bash
node -e "const c=require('crypto'); fetch('<URL_INMUTABLE>').then(r=>r.arrayBuffer()).then(b=>console.log('sha384-'+c.createHash('sha384').update(Buffer.from(b)).digest('base64')))"
```

### Comportamiento cuando falla Internet o una CDN

- **Funciona 100% sin conexión:** arranque de la app con estilos locales (`css/tailwind.css`), gestión de empleados e inventario, cálculo de billetes y retiro bancario, importación Excel/TSV y JSON, historial local, **exportación CSV**, **respaldo/restauración JSON**, Estudio de Hojas y edición/impresión de documentos `.txt`.
- **Degradación controlada ante caída de CDN:**
  - *Exportar Excel (`.xlsx`)* y *Exportar PDF* capturan el fallo de carga sin lanzar excepciones no manejadas ni perder datos, mostrando una alerta clara (verificado en [`tests/storageCurrenciesExport.test.js`](tests/storageCurrenciesExport.test.js)).
  - *Importar `.docx`* en Documentos informa que el conversor DOCX no está disponible; la edición manual y `.txt` siguen operativas.
  - Si falla *Font Awesome*, los botones con texto siguen siendo legibles; algunos botones de solo ícono dependen todavía del tooltip `title` (pendiente completar sus `aria-label` junto con la limpieza de UI).

### Política CSP (*Content Security Policy*)

GitHub Pages no permite enviar cabeceras HTTP personalizadas desde el repositorio. Si sirves SplitX detrás de un proxy propio (Cloudflare, Nginx, Caddy):

- **CSP viable hoy** (mientras existan handlers `onclick` inline en `index.html`):
  ```http
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'
  ```
  *(Nota: `connect-src 'self'` es obligatorio para que `DocumentStudio.js` pueda hacer `fetch('document-studio.html')`.)*
- **CSP objetivo:** una vez completada la migración de los handlers inline restantes a delegación de eventos (seguimiento en [Issue #28](https://github.com/ERCamilo/SplitX/issues/28)), retirar `'unsafe-inline'` de `script-src`.

---

## Integración con Sistema de Asistencia (SA)

[`js/SplitXBridge.js`](js/SplitXBridge.js) recibe nóminas mediante `window.postMessage` únicamente desde orígenes autorizados (`https://asistencia.erlin.do` y `https://ercamilo.github.io`; `localhost`/`127.0.0.1` solo se aceptan cuando SplitX también corre en local):

1. **Cola temprana (`installEarlyQueue`):** instalada en `<head>` antes del resto de scripts, responde inmediatamente a `SPLITX_PING` con `SPLITX_READY` dirigido al `event.origin` validado y encola mensajes `SPLITX_IMPORT_PAYROLL` hasta que la app termine de cargar.
2. **Señal proactiva (`emitReady`):** al ejecutarse `attach()`, si SplitX fue abierto desde un `window.opener` cuyo `document.referrer` pertenece a un origen permitido, envía `SPLITX_READY` a ese origen exacto (nunca `'*'`).
3. **Idempotencia segura (`transferId`):** una transferencia confirmada no se aplica dos veces; si el usuario cancela o falla la validación, el `transferId` se libera para reintentar.
4. **Consentimiento y moneda:** si ya hay empleados cargados, pregunta antes de reemplazar o anexar, y la moneda del payload solo se aplica tras confirmar.
5. **Pruebas locales del protocolo:** los contratos del mensaje `SPLITX_IMPORT_PAYROLL` (`version: '1.0'`, `source: 'Sistema-de-Asistencia'`, `transferId`, `employees`, `exportContext`) pueden inspeccionarse y probarse directamente en [`tests/bridgeHardening.test.js`](tests/bridgeHardening.test.js) y [`tests/e2e/sa-bridge.e2e.js`](tests/e2e/sa-bridge.e2e.js).

---

## Comandos de desarrollo, compilación y pruebas

```bash
# 1. Suite unitaria (~1 s, usa node --test nativo, sin dependencias externas)
npm test

# 2. Verificación estática de tipos JS (TypeScript checkJs estricto en jsconfig.json;
#    actualmente cubre 10 de los 20 módulos en js/ — el resto sigue en Issue #28)
npm run typecheck

# 3. Recompilar Tailwind CSS minificado tras cambiar clases en index.html o js/*.js
npm run build:css

# 4. Pruebas E2E en Chromium real (tests/e2e/server.js levanta su propio servidor local;
#    no hace falta abrir otro servidor aparte).
#    Nota: mammoth@1.13.0 se instala solo para tests/e2e/docx-real.e2e.js (conversión DOCX offline).
npm install --no-save playwright@1.56.1 mammoth@1.13.0
npx playwright install chromium          # Windows / macOS
# npx playwright install --with-deps chromium   # Linux (instala librerías del SO)
npm run test:e2e
```

### Pipelines en GitHub Actions

- **Test Suite** ([`.github/workflows/test.yml`](.github/workflows/test.yml), `permissions: contents: read`): corre en cada `push` y `pull_request` a `main` sobre Node.js `20.x`:
  - Job `test`: ejecuta `npm run typecheck` y `npm test`.
  - Job `ui`: instala Playwright + Chromium y corre `npm run test:e2e` bloqueando peticiones externas para verificar operación local real.
- **QA aislada - constructor de fórmulas por chips** ([`.github/workflows/qa-chip-formulas.yml`](.github/workflows/qa-chip-formulas.yml)): corre sobre Node.js `22` en `push` a `main` / ramas `qa/chip-formula-builder-*` / `feat/chip-formula-visual-builder-*`, `pull_request` a `main` y `workflow_dispatch`, con 3 jobs (`compatibility`, `future-unit-contract`, `future-browser-contract`) usando `qa/chip-formulas/`.

### Cobertura móvil (actual y pendiente)

- **Cubierto hoy en CI (`Test Suite` → job `ui`):** [`tests/e2e/employee-documents.e2e.js`](tests/e2e/employee-documents.e2e.js) valida el viewport móvil `390×844` (apertura desde la barra principal, ausencia de scroll horizontal, visibilidad del editor y vista previa).
- **Cobertura pendiente (seguimiento en [Issue #28](https://github.com/ERCamilo/SplitX/issues/28)):** añadir pruebas E2E a `390×844` para la pantalla principal de nómina (barra inferior móvil, formulario deslizante de agregar empleado, tarjetas expandibles y modal de operaciones/respaldo).

---

## Privacidad, almacenamiento local y respaldos

- **Sin transmisión de nómina:** SplitX no envía empleados, salarios, préstamos ni documentos a servidores externos. Los logs (`console.warn` / `console.error`) y las alertas de error están auditados para no exponer nombres, montos ni datos personales de nómina.
- **Claves en `localStorage` (`SplitXStorage.KEYS`):**
  - `Split_data`: estado principal (empleados, inventario, límites bancarios, moneda, tema).
  - `Split_data_corrupt_backup`: copia automática preservada si se detecta JSON dañado al arrancar.
  - `Split_import_history`: historial de últimas importaciones (máximo 10 entradas).
  - `Split_sheets_v2`: plantillas actuales de sobres y hojas de firmas.
  - `Split_sheets_v1`: clave heredada leída durante migración de plantillas y limpiada en `resetAll()`.
  - `Split_documents_v1`: plantillas de documentos y datos complementarios del empleado (cédula, fecha de ingreso, dirección y salario mensual contractual).
- **Respaldo completo y purga de PII:** desde el menú de **Operaciones** puedes:
  1. **Descargar respaldo completo (`.json`)** en formato `splitx-backup/v1` (incluye nómina, historial, hojas y documentos).
  2. **Restaurar respaldo** con validación atómica previa (si es inválido no modifica los datos actuales; sanitiza símbolos, colores, denominaciones, IDs de historial y bloquea logotipos/imágenes SVG por seguridad XSS).
  3. **Purgar datos personales (PII)** de `Split_documents_v1` sin borrar tus plantillas de documentos.
  4. **Limpiar todo (`resetAll`)**, que elimina todas las claves de SplitX en `localStorage`.

---

## Despliegue

El repositorio principal se publica automáticamente en **GitHub Pages** desde `main` hacia el dominio definido en [`CNAME`](CNAME) (`splitx.erlin.do`):

1. Si trabajas en un **fork propio**, edita o elimina [`CNAME`](CNAME) antes de activar GitHub Pages (de lo contrario GitHub rechazará el dominio ya asignado al repositorio original).
2. Si añadiste o cambiaste clases Tailwind en `index.html` o `js/*.js`, ejecuta `npm run build:css` e incluye `css/tailwind.css` en el commit.
3. Verifica localmente `npm test`, `npm run typecheck` y, si tienes Playwright instalado, `npm run test:e2e`.
4. Haz `push` a `main` (o abre un PR) y confirma que `Test Suite` (unitarios + `typecheck` + E2E) y `pages build and deployment` terminen en verde.
