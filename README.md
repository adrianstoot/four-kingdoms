# Imperios del Enjambre

Juego de estrategia 3D local para navegador, desarrollado con TypeScript, React y Three.js. Una alianza de dos colonias combate contra otro equipo de dos hormigueros sobre un micromundo vivo de raíces, hojas, resina y bioluminiscencia.

## Jugar

**Versión web:** [https://adrianstoot.github.io/four-kingdoms/](https://adrianstoot.github.io/four-kingdoms/)

La partida es completamente local: no requiere cuenta, servidor multijugador ni conexión WebSocket.

## Batalla 2v2

- Alianza Zafiro: Colonia Zafiro, controlada por ti, y Nido Esmeralda, dirigido por una IA.
- Enjambre rival: Enjambre Rubí y Colmena Amatista, ambos dirigidos por IA.
- Las tres IA usan las mismas cartas, costes, zonas de despliegue y reglas que el jugador.
- No existe fuego amigo. Vence el equipo que destruye los dos hormigueros rivales.
- El Corazón del Bosque concede una bonificación de regeneración de néctar al equipo que lo controla.
- Cada colonia almacena hasta 100 puntos de néctar.
- La simulación es determinista, funciona a 20 Hz y se ejecuta en un Web Worker.

## Criaturas y fenómenos

La mano completa permanece siempre disponible:

- Hormiga Soldado: combatiente de primera línea.
- Abeja Aguijón: hostigadora aérea de largo alcance.
- Mantis Cazadora: depredadora veloz con ataque de carga.
- Escarabajo Titán: ariete viviente especializado en estructuras.
- Monarca: heroína alada única con reaparición.
- Torre Termita: nido defensivo para los pads laterales.
- Bomba Ácida: proyectil corrosivo con daño de área.
- Enjambre Eléctrico: luciérnagas ionizadas que encadenan varios objetivos.

## Controles

- Haz clic en una carta y después en una zona válida del camino para desplegarla.
- La carta continúa seleccionada para permitir despliegues rápidos consecutivos.
- `Esc` o un clic derecho corto cancelan la selección.
- Arrastra con el botón derecho para rotar e inclinar la cámara.
- Arrastra con el botón central para desplazar el punto de enfoque.
- Usa la rueda para acercar o alejar la cámara hacia la posición del cursor.
- `WASD`, las flechas y los bordes de la pantalla desplazan la vista.
- `Q` y `E` giran la cámara.
- Los fenómenos pueden apuntar a cualquier carril.

## Arte y tecnología

- Micromundo insectoide con hormigueros, raíces, setas, piedras, hojas, polen y luciérnagas.
- Criaturas animadas con estados de aparición, reposo, marcha, ataque, impacto y muerte.
- Terreno, vegetación, estructuras, efectos, cartas y fondos creados específicamente para este proyecto.
- Arte 100 % original: geometría procedural de Three.js, SVG vectoriales propios y modelos construidos mediante los scripts Blender incluidos en el repositorio.
- No se incorporan imágenes, modelos ni animaciones descargados de terceros.
- Render WebGPU cuando está disponible, con fallback WebGL2.
- Cámara RTS 3D, instancing, pooling de efectos, interpolación de snapshots y rutas por spline.
- Sonido original sintetizado por código y reproducido con Howler.

## Desarrollo

Requiere Node.js con npm.

```powershell
npm ci
npm run dev
```

Abre `http://127.0.0.1:5173/`.

## Build y pruebas

```powershell
npm test
npm run typecheck
npm run build
npm run benchmark
```

El build de producción se genera en `apps/client/dist`.

## Publicación

Cada actualización de la rama `main` ejecuta `.github/workflows/deploy-pages.yml`, compila el proyecto y publica `apps/client/dist` en GitHub Pages.

## Arquitectura

- `packages/content`: catálogo validado, mapa, carriles, rutas y zonas de despliegue.
- `packages/sim`: economía, equipos 2v2, IA, combate, captura y victoria deterministas.
- `apps/client`: interfaz React, Web Worker, audio y renderer Three.js.
- `apps/client/src/game/environment`: entorno procedural del micromundo.
- `apps/client/public/models/insects`: modelos y manifiesto de las criaturas insectoides.
