# Documentos personalizados de empleados (MVP)

Se accede desde **Hojas → Documentos** o desde el botón **Documentos** en la barra superior.

## Uso

1. Importa la nómina desde Sistema de Asistencia o añade empleados en SplitX.
2. En **Documentos**, elige «Carta de ingreso» como ejemplo o crea otra plantilla con «+ Nueva».
3. Escribe un documento en el editor. Para dar formato, selecciona el texto y usa negrita, cursiva, títulos, alineación o listas.
4. En «Insertar dato del empleado» selecciona el campo que quieras. Se inserta un marcador como `{{name}}`. Su texto permanece fijo y el marcador se sustituye al generar el documento.
5. Puedes **importar un DOCX o TXT** para convertirlo en plantilla. Revisa el resultado porque la conversión no copia necesariamente los márgenes, fuentes, gráficos, imágenes, páginas y demás características complejas de Word.
6. En «Vista previa por empleado», elige una persona y completa los datos que no vienen de SA (cédula, fecha de ingreso, domicilio y sueldo mensual contractual).
7. Guarda la plantilla. «Imprimir este» genera una copia; «Imprimir todos» genera una por empleado. Puedes usar «Guardar como PDF» desde el navegador.

## Campos frecuentes

| Marcador | Valor |
| --- | --- |
| `{{name}}` | Nombre del empleado |
| `{{no}}` | Número de empleado |
| `{{company}}` | Empresa, cuando SA la suministra |
| `{{position}}` | Puesto, cuando SA lo suministra |
| `{{project}}` | Proyecto/obra |
| `{{gross}}` | **Bruto del período de nómina** (no confundir con salario mensual contratado) |
| `{{net}}` | Neto del período |
| `{{monthlySalary}}` | **Salario mensual contractual** ingresado manualmente |
| `{{idNumber}}` | Cédula / identificación ingresada manualmente |
| `{{startDate}}` | Fecha de ingreso ingresada manualmente |
| `{{address}}` | Dirección ingresada manualmente |
| `{{today}}` | Fecha actual al generar el documento |

Los marcadores pueden repetirse en tantos párrafos como desees.

## Protección de datos y limitaciones

- La nómina de SA y los pagos originales **no se modifican** desde Documentos.
- Las plantillas y los valores complementarios se guardan exclusivamente en el navegador de este dispositivo (`Split_documents_v1`). **No hay sincronización, recuperación remota ni copia de seguridad automática**.
- El importador DOCX carga un conversor JavaScript desde una CDN al utilizarlo. El archivo se convierte localmente; la aplicación no implementa un servicio de subida de documentos.
- Para mayor seguridad, la importación elimina imágenes, scripts, enlaces activos y atributos potencialmente peligrosos del documento antes de usar su contenido.
- Los campos ausentes se identifican como «FALTA» y bloquean la impresión de esa plantilla. **Nunca deducir automáticamente el salario contractual a partir del bruto quincenal o de los días trabajados.**
- Esta primera versión imprime o guarda PDF desde la función de impresión. **No exporta un nuevo DOCX editable**.
- Los documentos contractuales requieren revisión legal/laboral y comprobación de datos por una persona responsable. La carta incluida es un borrador genérico, no un contrato específico para una jurisdicción.
- Máximo de 20 plantillas guardadas y DOCX/TXT de hasta 5 MB en esta versión.

## QA mínima

- Crear una plantilla con nombre, puesto, obra y sueldo mensual.
- Vista previa de dos empleados distintos; las variables no se cruzan entre empleados y obras.
- Generar PDF de uno y de todos, rechazando campos incompletos.
- Importar DOCX con título, párrafos y negrita. Verificar conversión sin scripts ni elementos ocultos ejecutables.
- Comprobar que siguen funcionando sobres, firmas y las fórmulas visuales.
