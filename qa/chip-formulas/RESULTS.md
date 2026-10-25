# Resultado inicial de QA de fórmulas visuales — 25 octubre 2026

## Evidencia reproducible

- Rama exclusiva: qa/chip-formula-builder-20261025
- PR de QA en borrador: https://github.com/ERCamilo/SplitX/pull/17
- Último pipeline QA evaluado: https://github.com/ERCamilo/SplitX/actions/runs/40194548038
- Pipeline ordinario del PR: https://github.com/ERCamilo/SplitX/actions/runs/40194552011 (PASS)
- Base de producto: a834ce08f8e3bcad246a80084b922e7adbdc8b57
- No hay modificaciones del código de producto ni de main.

## Resultado por grupo

| Conjunto | Pasan | Fallan | Interpretación |
|---|---:|---:|---|
| baseline.cases.cjs (Node) | 6 | 0 | Motor actual protegido |
| baseline-browser.cases.cjs (Chromium) | 2 | 0 | Editor actual protegido |
| future-unit.cases.cjs (Node) | 0 | 9 | Falta chipsToFormula / formulaToChips |
| future-browser.cases.cjs (Chromium desktop y móvil táctil) | 0 | 12 | Falta el constructor visual y su interacción |
| Total | **8** | **21** | **Rojo esperado de funcionalidades futuras** |

## Interpretación

- PASS en baseline significa que el producto sigue aceptando y calculando fórmulas antiguas, conserva las definiciones y permite insertar campos con chips en el editor actual.
- FAIL en future-unit significa que faltan las funciones de conversión de chips a fórmula y de fórmula a chips. No implica que una fórmula existente se calcule mal.
- FAIL en future-browser significa que no existe todavía el lienzo de chips dentro del administrador de variables, el cambio de modo texto/visual, ni acciones visuales relacionadas. No implica error de comunicación con SA.
- Las etiquetas/identificadores del UI de prueba se detallan en CASES.md. Durante la implementación pueden refinarse junto con las pruebas preservando el contrato funcional.

## Secuencia de corrección sugerida

1. C02-C05: implementar la conversión bidireccional sobre los tipos de chip de SheetBuilder (sin eval y sin modificar datos guardados).
2. C01/C13: comprobar compatibilidad de todas las fórmulas antiguas, incluso después de recargar.
3. C06: incorporar la paleta y el lienzo visual al diálogo de variables. Soportar arrastrar, soltar, tocar y reordenar.
4. C07/C12: adaptar a móvil táctil y teclado; mantener controles grandes y accesibles.
5. C09-C11: previsualización por empleado, alternativas de valores y modo texto con autocompletado.
6. C08/C16/C17: guardar expresiones de una celda como variables, reutilizar en sobres y firmas, cancelar sin guardar.
7. Ejecutar QA rojo hasta cero y volver a correr npm test, npm run typecheck y npm run test:e2e. Solo entonces solicitar revisión y posible fusión.

## Protección

No integrar esta rama QA aislada por sí sola: contiene contratos que fallan deliberadamente hasta desarrollar el comportamiento nuevo. Cuando un PR de implementación introduzca el constructor, debe incorporar las pruebas que le correspondan y demostrar todos los casos obligatorios verdes.
