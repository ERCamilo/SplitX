# Validación final — constructor visual de fórmulas

**Fecha:** 2026-10-25 · **PR:** https://github.com/ERCamilo/SplitX/pull/18

## Resultado comprobado

- 6/6 pruebas de compatibilidad del motor: PASS.
- 2/2 recorridos de compatibilidad del editor: PASS.
- 9/9 pruebas del motor chips ↔ texto: PASS.
- 13/13 recorridos de navegador desktop y móvil táctil: PASS.
- **Total: 30/30 PASS.**
- CI habitual del repositorio (Node, tipo, Playwright): PASS.
- Evidencia específica: https://github.com/ERCamilo/SplitX/actions/runs/40199240052
- Versión de código validada: `5b6757d785674c9a4bef71eccb4fd7de2ada79e8` (incluye corrección del toque móvil).

## Cobertura funcional

1. Campos importados de SA y variables propias como chips con etiquetas legibles.
2. Conversión de texto a chips y de chips a texto sin alterar operaciones, paréntesis ni porcentajes.
3. Fórmulas guardadas anteriormente siguen siendo compatibles.
4. Arrastrar/soltar, reordenar, quitar con teclado y añadir tocando en móvil.
5. Evitar activaciones accidentales del modo avanzado al abrir el administrador en pantallas táctiles.
6. Cálculos de ejemplo por empleado, incluidas excepciones particulares.
7. Guardar cálculos existentes de celdas como variables reutilizables.
8. Usar las nuevas variables en sobres y hojas de firmas con idéntico resultado.
9. Autocompletado de campos en el editor de texto.
10. Rechazo de expresiones desconocidas, circulares, operaciones inseguras y fórmulas excesivamente extensas.
11. Cancelación sin sobrescribir fórmulas previas.
12. Datos originales `Split_data` inalterados por editar e imprimir.

## Flujo y límites

- La interfaz visual es la opción predeterminada; la edición textual avanzada es voluntaria.
- Las definiciones se almacenan junto a las configuraciones de hojas y continúan siendo locales al navegador.
- Las fórmulas no pueden ejecutar JS ni modificar datos fuente de nóminas SA.
- No se garantiza equivalencia con una sesión física de SA: los tests importan empleados de ejemplo en un navegador aislado.
- QA continua: `.github/workflows/qa-chip-formulas.yml` se ejecutará sobre `main` y nuevas PR al fusionar esta implementación.

La antigua rama del PR #17 contenía casos rojos deliberadamente; el PR #18 incorpora el código nuevo y los casos aprobados. No fusionar el PR #17 por separado.
