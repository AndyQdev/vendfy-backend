/**
 * Descarga condicional de una fuente.
 *
 * Guarda junto al archivo el ETag y el Last-Modified que devolvió el servidor;
 * la próxima vez los manda de vuelta y, si la fuente no cambió, el servidor
 * contesta 304 y no se baja nada. Para Open Food Facts eso son 1,28 GB que no se
 * repiten los días en que no hubo exportación nueva.
 *
 * Escribe primero en `.part` y renombra al terminar: una descarga cortada nunca
 * queda con el nombre del archivo bueno.
 */

import { createWriteStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT = 'Vendfy-Catalogo/1.0 (andres.03.12.2003@gmail.com)';
const INTENTOS = 3;

interface MetaDescarga {
  url: string;
  etag?: string;
  lastModified?: string;
  bytes: number;
  descargadoEn: string;
}

export interface ResultadoDescarga {
  ruta: string;
  /** false si el servidor dijo que no cambió y se usó la copia guardada. */
  descargado: boolean;
  bytes: number;
  lastModified?: string;
  /** Presente cuando no se pudo bajar y se usó la copia de un día anterior. */
  aviso?: string;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

export async function descargar(url: string, ruta: string, etiqueta: string): Promise<ResultadoDescarga> {
  await mkdir(dirname(ruta), { recursive: true });
  const rutaMeta = `${ruta}.meta.json`;
  const previo: MetaDescarga | null =
    existsSync(ruta) && existsSync(rutaMeta) ? JSON.parse(readFileSync(rutaMeta, 'utf8')) : null;

  let ultimoError: unknown;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
      if (previo?.url === url) {
        if (previo.etag) headers['If-None-Match'] = previo.etag;
        if (previo.lastModified) headers['If-Modified-Since'] = previo.lastModified;
      }

      const res = await fetch(url, { headers, redirect: 'follow' });

      if (res.status === 304 && previo) {
        console.log(`  ${etiqueta}: sin cambios desde ${previo.lastModified ?? previo.descargadoEn}`);
        return { ruta, descargado: false, bytes: previo.bytes, lastModified: previo.lastModified };
      }
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} al descargar ${url}`);
      }

      const total = Number(res.headers.get('content-length') ?? 0);
      let recibido = 0;
      let ultimoAviso = Date.now();
      const cuerpo = Readable.fromWeb(res.body as any);
      cuerpo.on('data', (trozo: Buffer) => {
        recibido += trozo.length;
        if (Date.now() - ultimoAviso > 10_000) {
          ultimoAviso = Date.now();
          const pct = total ? ` (${((recibido / total) * 100).toFixed(0)} %)` : '';
          console.log(`  ${etiqueta}: ${mb(recibido)}${total ? ` de ${mb(total)}` : ''}${pct}`);
        }
      });

      const parcial = `${ruta}.part`;
      await pipeline(cuerpo, createWriteStream(parcial));
      const bytes = statSync(parcial).size;
      if (total && bytes !== total) {
        await unlink(parcial).catch(() => {});
        throw new Error(`descarga incompleta: ${bytes} de ${total} bytes`);
      }
      renameSync(parcial, ruta);

      const meta: MetaDescarga = {
        url,
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
        bytes,
        descargadoEn: new Date().toISOString(),
      };
      writeFileSync(rutaMeta, JSON.stringify(meta, null, 2));
      console.log(`  ${etiqueta}: descargado ${mb(bytes)}`);
      return { ruta, descargado: true, bytes, lastModified: meta.lastModified };
    } catch (error) {
      ultimoError = error;
      const espera = 15_000 * intento;
      console.warn(`  ${etiqueta}: intento ${intento}/${INTENTOS} falló (${(error as Error).message})`);
      if (intento < INTENTOS) await new Promise((r) => setTimeout(r, espera));
    }
  }

  // Si no se pudo bajar pero hay una copia de un día anterior, se usa esa:
  // un catálogo de ayer es mucho mejor que ningún catálogo. Quien llama
  // registra el aviso para que se vea en el super-admin.
  if (previo) {
    const aviso = `no se pudo descargar (${(ultimoError as Error)?.message}); se usó la copia del ${previo.descargadoEn}`;
    console.warn(`  ${etiqueta}: ${aviso}`);
    return { ruta, descargado: false, bytes: previo.bytes, lastModified: previo.lastModified, aviso };
  }
  throw ultimoError;
}
