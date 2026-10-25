# Contrato de pruebas: fórmulas por chips en SplitX

Fecha: 2026-10-25. Estado: TDD (pruebas primero). **No fusionar el PR de pruebas hasta implementar todos los casos obligatorios.**

## Objetivo
Reutilizar la estructura de chips de SheetBuilder y la paleta de SheetStudio **dentro del administrador de variables**. Se arrastran chips con el ratón, se insertan tocándolos en móvil y se reutilizan cálculos como variables. El modo textual avanzado es alternativo y opcional; ambos modos describen la misma fórmula.

## Contrato del modelo y seguridad
- Estructura canónica: SheetBuilder.Chip[] con field, op, number (percent=true) y paren. Conservar clave interna aunque la UI muestre el nombre en español.
- Ampliar SplitXVariables con formulaToChips(expression, {fields,resolveField,variables}) y chipsToFormula(chips), con conversión de ida y vuelta sin cambiar el resultado. Una variable propia inserta un chip field con clave custom:ID.
- No cambiar formato existente del almacenamiento Split_sheets_v2.variables. Un valor anterior (kind:formula y formula como texto) debe volver a abrirse en modo visual sin migración destructiva.
- El texto avanzado no ejecuta código. Prohibidos eval, Function, expresiones JS, URLs, scripts y cambios en Split_data.
- Invalidar fórmulas con ciclos, referencias desconocidas, división por cero y errores de sintaxis; conservar el borrador corregible sin sobrescribir la fórmula válida guardada.
- Mismo resultado numérico en tarjeta de sobre y hoja de firmas. Usar datos de empleado solo para la vista previa, sin reescribirlos.

## Contrato propuesto de selectores accesibles

| Acción | Selector futuro |
|---|---|
| Administrador existente | #ssVarsDialog |
| Modo visual (predeterminado) | #ssVarModeVisual |
| Modo avanzado | #ssVarModeText |
| Zona de construcción con chips | #ssVarFormulaCanvas |
| Paleta de chips reutilizada | #ssVarBuilderPalette |
| Chip campo importado | [data-chip-key="gross"] |
| Chip de variable propia | [data-chip-key="custom:transporte"] |
| Operadores | [data-chip-op="*"], [data-chip-op="+"] |
| Valor numérico | #ssVarNumberValue |
| Indicador de porcentaje | #ssVarNumberPercent |
| Insertar número | #ssVarInsertNumber |
| Campo textual existente | #ssVarFormula |
| Autocompletado | #ssVarFormulaSuggestions |
| Selector de empleado de muestra | #ssVarPreviewEmployee |
| Resultado de muestra | #ssVarPreviewValue |
| Guardar fórmula de celda | #ssSaveCellAsVariable |

Los selectores son el contrato inicial y pueden modificarse junto con las pruebas, si se conserva la interacción por ratón, tacto y teclado.

## Matriz de aceptación

| ID | Prioridad | Requisito |
|---|---|---|
| C01 | P0 | Fórmulas textuales preexistentes funcionan |
| C02 | P0 | Conversión chips ↔ texto conserva semántica |
| C03 | P0 | Campos importados, conceptos dinámicos y variables propias |
| C04 | P0 | Operaciones, negativos, porcentajes y paréntesis |
| C05 | P0 | Ciclos, divisor cero, campos desconocidos bloqueados |
| C06 | P0 | Arrastrar, soltar, ordenar y quitar chips |
| C07 | P0 | Añadir chips mediante toque móvil sin drag HTML |
| C08 | P0 | Guardar cálculo ya existente de celda como variable |
| C09 | P0 | Previsualizar empleado y sus excepciones |
| C10 | P0 | Cambiar entre modo visual y textual sin pérdida |
| C11 | P1 | Búsqueda/autocompletado por nombre legible |
| C12 | P1 | Controles accesibles con teclado y foco |
| C13 | P1 | Persistencia y recarga compatibles |
| C14 | P1 | Entradas hostiles y nombres especiales son seguros |
| C15 | P1 | Límite de variables, chips y rendimiento |
| C16 | P1 | Resultado idéntico en sobres y firmas |
| C17 | P1 | Cancelar deja inalterada una fórmula anterior |

## Ejecución
- Compatibilidad que debe **pasar ya**: node --test qa/chip-formulas/baseline.cases.cjs
- Motor futuro: node --test qa/chip-formulas/future-unit.cases.cjs
- Navegador futuro: node --test qa/chip-formulas/future-browser.cases.cjs

Las pruebas residen fuera de tests/ y no entran en npm test ni npm run test:e2e de main. La workflow QA de esta rama muestra por separado pruebas basales (verdes) y criterios futuros (rojos hasta implementar). **Un rojo de características futuras no equivale a regresión del producto.**
