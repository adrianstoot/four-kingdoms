# Pipeline de unidades con Meshy

`meshy_units_pipeline.py` prepara las hojas de `meshy_output/reference_sheets`, crea los cinco humanoides con `meshy-5`, los riggea y conserva IDs, saldo, historial y descargas GLB en un estado reanudable.

El comando es **dry-run por defecto** y nunca crea tareas de pago sin `--confirm-spend`. No ejecutes ese flag hasta que el usuario haya confirmado expresamente el gasto de hasta 100 créditos.

```powershell
# Revisión local sin red ni gasto
python scripts/meshy_units_pipeline.py --offline

# Consulta de saldo (lee MESHY_API_KEY del entorno o de .env)
python scripts/meshy_units_pipeline.py --balance-only

# Solo tras confirmación explícita del usuario
python scripts/meshy_units_pipeline.py --confirm-spend
```

Dependencias: Python 3.10+, `requests` y `Pillow`. El estado predeterminado es `meshy_output/pipeline_state.json`; una interrupción no cancela ni recrea tareas. Si un POST quedó ambiguo, el runner se detiene y pide adoptar el ID visible en el panel mediante `--adopt-model-task slug=ID` o `--adopt-rig-task slug=ID`.

## Garantias de seguridad

- Sin argumentos o con `--dry-run`, el runner es completamente local: detecta la clave sin mostrarla, valida las cinco referencias y no hace ninguna llamada HTTP.
- `--offline` fuerza igualmente cero red.
- `--balance-only` es la unica excepcion de red sin gasto: ejecuta solo el `GET /openapi/v1/balance` solicitado expresamente.
- Ningun `POST` de pago puede ejecutarse sin `--confirm-spend`.
- Un `POST` con fallo de red o respuesta 5xx se considera ambiguo y nunca se reintenta; hay que adoptar el ID desde el panel antes de continuar.
- Cada `task_id` se escribe en disco antes de consultar saldo, sondear o descargar, evitando doble gasto tras una interrupcion.

## Presupuesto inicial: 100 creditos

La primera fase contiene exactamente cinco humanoides:

1. guardia;
2. arquero;
3. gigante;
4. comandante;
5. jinete del caballero.

Cada uno usa multiimagen `meshy-5` con textura PBR (15 creditos) y auto-rig humanoide (5 creditos): **20 por unidad, 100 en total**. El rig incluye caminar y correr basicos. Ataques, muertes y otros clips personalizados de 3 creditos quedan fuera de esos 100 y se presupuestan antes de cualquier gasto adicional.

El caballo es un activo cuadrupedo separado basado en `knight-horse-turnaround.png`. No forma parte de los cinco humanoides ni de los primeros 100 creditos; se generara y riggeara en una segunda fase con los creditos obtenidos despues. Separarlo evita un rig incorrecto de seis extremidades en el conjunto caballo-jinete.

## Referencias y resultados

Cada `UnitSpec` conserva una guia visual textual coherente con su hoja turnaround y la envia como `texture_prompt`; el modelo usa de una a cuatro vistas, T-pose, PBR y salida GLB. Antes del rig se exige un recuento de caras no superior a 300.000.

Los resultados se guardan solo en `meshy_output/`:

- estado reanudable global en `pipeline_state.json`;
- indice global de proyectos en `history.json`;
- carpeta por unidad con formato `{timestamp}_{slug}_{task-id}`;
- `metadata.json`, `history.json`, vistas preparadas, miniatura y GLB de modelo/rig/caminar/correr.
