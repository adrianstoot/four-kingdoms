import * as THREE from "three";

function gradePixels(context: CanvasRenderingContext2D, width: number, height: number): void {
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const isGrass = green > red * 1.08 && green > blue * 1.4;
    const isRoad = red > green * 1.18 && green > blue * 1.8;

    if (isGrass) {
      pixels[index] = Math.min(255, red * 0.48 + green * 0.12);
      pixels[index + 1] = Math.min(255, red * 0.18 + green * 0.48);
      pixels[index + 2] = Math.min(255, red * 0.2 + green * 0.08);
    } else if (isRoad) {
      pixels[index] = Math.min(255, red * 0.65 + green * 0.13);
      pixels[index + 1] = Math.min(255, red * 0.18 + green * 0.58);
      pixels[index + 2] = Math.min(255, red * 0.2 + green * 0.1 + blue * 0.1);
    } else {
      const luminance = red * 0.213 + green * 0.715 + blue * 0.072;
      pixels[index] = Math.min(255, (luminance + (red - luminance) * 0.68) * 0.82);
      pixels[index + 1] = Math.min(255, (luminance + (green - luminance) * 0.68) * 0.82);
      pixels[index + 2] = Math.min(255, (luminance + (blue - luminance) * 0.68) * 0.82);
    }
  }

  context.putImageData(imageData, 0, 0);
}

export function createPaintedTerrainTexture(sourceUrl: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas 2D is required for the painted terrain palette.");
  context.fillStyle = "#516329";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.MirroredRepeatWrapping;
  texture.wrapT = THREE.MirroredRepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;

  new THREE.TextureLoader().load(sourceUrl, (loadedTexture) => {
    const source = loadedTexture.image as HTMLImageElement;
    canvas.width = source.naturalWidth || source.width;
    canvas.height = source.naturalHeight || source.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    try {
      gradePixels(context, canvas.width, canvas.height);
    } catch {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.filter = "saturate(0.62) brightness(0.78)";
      context.drawImage(source, 0, 0);
      context.filter = "none";
    }
    texture.needsUpdate = true;
    loadedTexture.dispose();
  }, undefined, () => {
    texture.needsUpdate = true;
  });
  return texture;
}
