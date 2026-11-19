import * as fs from 'fs';
import * as vm from 'vm';

/** Lo que entrega Gemini: PCM de 16 bits, little-endian, mono, 24 kHz. */
export const FRECUENCIA = 24_000;

interface Lame {
  Mp3Encoder: new (canales: number, frecuencia: number, kbps: number) => {
    encodeBuffer(muestras: Int16Array): Int8Array;
    flush(): Int8Array;
  };
}

let lame: Lame | null = null;

/**
 * lamejs empaquetado como script (IIFE): el paquete original revienta en
 * Node ("MPEGMode is not defined") y el fork solo exporta ESM o este
 * script, que declara `var lamejs`. Se evalúa una vez y se toma esa
 * variable; es código de un paquete instalado, no de afuera.
 */
function cargarLame(): Lame {
  if (!lame) {
    const ruta = require.resolve('@breezystack/lamejs');
    lame = vm.runInThisContext(`(function(){${fs.readFileSync(ruta, 'utf8')}\nreturn lamejs;})()`, {
      filename: ruta,
    }) as Lame;
  }
  return lame;
}

/** Los bytes como muestras, copiando si el Buffer no está alineado a 2. */
export function aMuestras(pcm: Buffer): Int16Array {
  const largo = pcm.length - (pcm.length % 2);
  const copia = new ArrayBuffer(largo);
  new Uint8Array(copia).set(pcm.subarray(0, largo));
  return new Int16Array(copia);
}

/**
 * Saca el silencio del principio y del final, dejando un margen corto para
 * que no suene cortado. En un mostrador cada décima cuenta: el modelo suele
 * arrancar con 200-400 ms de nada.
 */
export function recortarSilencio(muestras: Int16Array, umbral = 350, margenMs = 40): Int16Array {
  const margen = Math.round((FRECUENCIA * margenMs) / 1000);
  let inicio = 0;
  while (inicio < muestras.length && Math.abs(muestras[inicio]) < umbral) inicio++;
  let fin = muestras.length - 1;
  while (fin > inicio && Math.abs(muestras[fin]) < umbral) fin--;
  if (inicio >= muestras.length) return muestras.subarray(0, 0);
  return muestras.subarray(Math.max(0, inicio - margen), Math.min(muestras.length, fin + 1 + margen * 3));
}

/** MP3 mono de 48 kbps: una frase de 2 s pesa ~15 KB en vez de ~100 KB en WAV. */
export function aMp3(muestras: Int16Array, kbps = 48): Buffer {
  const { Mp3Encoder } = cargarLame();
  const enc = new Mp3Encoder(1, FRECUENCIA, kbps);
  const partes: Buffer[] = [];
  const agregar = (b: Int8Array) => {
    // Copia: no depender de si el codificador reutiliza su búfer de salida.
    if (b.length) partes.push(Buffer.from(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  };
  for (let i = 0; i < muestras.length; i += 1152) agregar(enc.encodeBuffer(muestras.subarray(i, i + 1152)));
  agregar(enc.flush());
  return Buffer.concat(partes);
}
