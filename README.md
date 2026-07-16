# Cuatro Reinos — batalla local 2v2

Juego de estrategia y cartas construido con TypeScript, React y Three.js. La partida se simula localmente: no hay cuentas, servidor multijugador ni conexiones WebSocket.

## Partida

- Equipo Azul: Reino Azul (tú) y Pacto Esmeralda (IA media).
- Equipo Rival: Dominio Carmesí y Corte Violeta (ambos IA media).
- Sólo tú controlas cartas y despliegues. Los otros tres reinos son autónomos.
- No existe fuego amigo. Gana el equipo que destruye los dos castillos rivales.
- El círculo central acelera la regeneración de elixir del equipo que lo controla.
- Elixir maximo: 100; la barra muestra diez tramos de 10 puntos.
- Las tres IA de nivel medio coordinan defensa 2v2, objetivo central, torres, heroes y hechizos con reglas deterministas.

## Jugar sin abrir Codex

Haz doble clic en `JUGAR.cmd`. El lanzador abre el build de producción en el navegador mediante un servidor local ligero.

Para desarrollo:

```powershell
npm install
npm run dev
```

Después abre `http://127.0.0.1:5173/`.

## Controles

- Haz clic en una carta y después en un tramo válido para desplegar.
- `Q` / `E`: girar la cámara 90°.
- Rueda del ratón: zoom.
- `WASD` o flechas: desplazar la cámara.
- Los hechizos se pueden lanzar sobre cualquier carril.

## Dirección artística

- Ilustración de fantasía con contorno oscuro y sombreado por bandas.
- Tablero isométrico con anillo, rombo interior y cuatro rutas centrales.
- Ocho cartas con una única lámina de arte 4×2 recortada por CSS.
- Castillos, tropas, vegetación, caminos y objetivo creados de forma procedural en Three.js.
- El arte del juego es original y se distribuye con este proyecto.

## Modo gráfico seguro

WebGL2, calidad media y un máximo de 768 entidades son los valores predeterminados para evitar problemas de controladores WebGPU. WebGPU queda como opción manual mediante `?webgpu`.

## Verificación

```powershell
npm test
npm run build
npm run benchmark
```

## Arquitectura

- `packages/content`: catálogo JSON y mapa de cinco nodos/doce carriles.
- `packages/sim`: simulación determinista, equipos 2v2, economía, IA, rutas, combate y victoria.
- `apps/client`: Web Worker, Vite, React, HUD y renderer procedural Three.js.
- `.github/workflows/deploy-pages.yml`: build y publicación automática en GitHub Pages.
