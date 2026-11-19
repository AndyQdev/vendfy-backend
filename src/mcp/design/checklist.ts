/**
 * Criterios de aceptación del storefront.
 *
 * Es la puerta de salida de la Fase 3: el agente no puede declarar terminado el
 * trabajo sin recorrerlos uno por uno. Están redactados para poder responderse
 * con sí o no mirando el código y la pantalla; un criterio que se responde
 * "más o menos" no sirve de criterio.
 */

export interface CriterioAceptacion {
  id: string;
  grupo: string;
  criterio: string;
  /** Cómo se comprueba. Sin esto, el agente se autoaprueba. */
  comoVerificar: string;
}

export const ACCEPTANCE_CHECKLIST: CriterioAceptacion[] = [
  // ---------------------------------------------------------------- estructura
  {
    id: 'arq-1',
    grupo: 'Arquitectura',
    criterio: 'Es un proyecto Next.js con App Router y TypeScript, no archivos sueltos.',
    comoVerificar: 'Existen package.json, app/layout.tsx y app/page.tsx. No hay ningún index.html en la raíz.',
  },
  {
    id: 'arq-2',
    grupo: 'Arquitectura',
    criterio: 'La UI está partida en componentes reutilizables.',
    comoVerificar: 'La tarjeta de producto vive en components/ y se usa desde el inicio y desde las categorías. Ningún archivo pasa de 300 líneas.',
  },
  {
    id: 'arq-3',
    grupo: 'Arquitectura',
    criterio: 'Todas las llamadas a la API pasan por lib/vendfy.ts.',
    comoVerificar: 'Buscar "fetch(" en app/ y components/: no debe haber ninguno fuera de lib/.',
  },

  // --------------------------------------------------------------------- datos
  {
    id: 'dat-1',
    grupo: 'Datos',
    criterio: 'Ningún producto, precio, stock ni reseña quedó copiado en un archivo.',
    comoVerificar: 'No existe data.json, productos.ts ni arrays de catálogo en el código. Todo sale de la API en runtime.',
  },
  {
    id: 'dat-2',
    grupo: 'Datos',
    criterio: 'Los precios se muestran con dos decimales y el símbolo de config.currency.',
    comoVerificar: 'Un producto de 25.5 se ve "Bs 25.50". No hay ninguna división ni multiplicación por 100.',
  },
  {
    id: 'dat-3',
    grupo: 'Datos',
    criterio: 'Un producto con stock 0 y sellWithoutStock se ofrece como "A pedido", no como "Agotado".',
    comoVerificar: 'Buscar uno en el catálogo; debe poder agregarse al carrito.',
  },
  {
    id: 'dat-4',
    grupo: 'Datos',
    criterio: 'No se muestran líneas de IVA ni impuestos.',
    comoVerificar: 'El total del carrito es exactamente subtotal + envío.',
  },

  // -------------------------------------------------------------------- diseño
  {
    id: 'dis-1',
    grupo: 'Diseño',
    criterio: 'Ningún componente escribe un color literal.',
    comoVerificar: 'Buscar "#" seguido de hex y clases como bg-blue-500 en components/ y app/: no debe haber ninguna. Todo sale de los tokens.',
  },
  {
    id: 'dis-2',
    grupo: 'Diseño',
    criterio: 'El color de marca de la tienda es el que manda en la página.',
    comoVerificar: 'Los botones primarios usan hsl(var(--primary)) y ese valor viene del colorTheme real.',
  },
  {
    id: 'dis-3',
    grupo: 'Diseño',
    criterio: 'Toda insignia de estado lleva su palabra escrita.',
    comoVerificar: 'No existe ningún indicador que solo sea un punto o un fondo de color.',
  },
  {
    id: 'dis-4',
    grupo: 'Diseño',
    criterio: 'Los productos sin foto tienen un marcador propio.',
    comoVerificar: 'No hay iconos de imagen rota ni URLs de via.placeholder.com en la grilla.',
  },
  {
    id: 'dis-5',
    grupo: 'Diseño',
    criterio: 'Existen los estados vacíos.',
    comoVerificar: 'Buscar algo que no exista: aparece un mensaje con salida, no una pantalla en blanco.',
  },

  // --------------------------------------------------------------------- móvil
  {
    id: 'mov-1',
    grupo: 'Móvil',
    criterio: 'A 360 px de ancho no hay scroll horizontal en ninguna pantalla.',
    comoVerificar: 'Abrir el inspector a 360 px y recorrer inicio, detalle, carrito y checkout.',
  },
  {
    id: 'mov-2',
    grupo: 'Móvil',
    criterio: 'Los controles táctiles miden 44 px o más.',
    comoVerificar: 'Botón de agregar, chips de categoría y control de cantidad.',
  },
  {
    id: 'mov-3',
    grupo: 'Móvil',
    criterio: 'Las entradas de formulario tienen fuente de 16 px.',
    comoVerificar: 'Enfocar un campo en iOS no debe hacer zoom.',
  },

  // ------------------------------------------------------------------ flujo real
  {
    id: 'flu-1',
    grupo: 'Flujo',
    criterio: 'El catálogo carga desde la API y las categorías filtran de verdad.',
    comoVerificar: 'Elegir una categoría cambia la grilla y el conteo coincide con productCount.',
  },
  {
    id: 'flu-2',
    grupo: 'Flujo',
    criterio: 'El flujo carrito → cliente → dirección → pedido crea una orden real.',
    comoVerificar: 'Completarlo de punta a punta y comprobar que el pedido aparece en el panel de Vendfy. Después borrarlo.',
  },
  {
    id: 'flu-3',
    grupo: 'Flujo',
    criterio: 'El envío se calcula igual que en el backend.',
    comoVerificar: 'Con delivery calculated, el costo mostrado es Math.round(5 + km * 2) y coincide con el de la orden creada.',
  },
  {
    id: 'flu-4',
    grupo: 'Flujo',
    criterio: 'No se prometen avisos de WhatsApp que no van a salir.',
    comoVerificar: 'Contrastar con get_notifications_config: si la tienda no tiene número conectado, la web no dice que le llegará un mensaje.',
  },

  // ----------------------------------------------------------------- publicación
  {
    id: 'pub-1',
    grupo: 'Publicación',
    criterio: 'La metadata Open Graph está completa.',
    comoVerificar: 'generateMetadata devuelve title, description e image. Pegar el enlace en WhatsApp muestra previsualización.',
  },
  {
    id: 'pub-2',
    grupo: 'Publicación',
    criterio: 'Las imágenes tienen alt real.',
    comoVerificar: 'El alt es el nombre del producto, no "imagen" ni vacío.',
  },
  {
    id: 'pub-3',
    grupo: 'Publicación',
    criterio: 'El proyecto compila.',
    comoVerificar: 'npm run build termina sin errores de TypeScript.',
  },
];

export function buildChecklistDoc(storeName: string): string {
  const grupos = [...new Set(ACCEPTANCE_CHECKLIST.map((c) => c.grupo))];
  const cuerpo = grupos
    .map((g) => {
      const items = ACCEPTANCE_CHECKLIST.filter((c) => c.grupo === g)
        .map(
          (c) =>
            `- [ ] **${c.id}** · ${c.criterio}\n      _Verificar:_ ${c.comoVerificar}`,
        )
        .join('\n');
      return `### ${g}\n${items}`;
    })
    .join('\n\n');

  return `# Criterios de aceptación — ${storeName}

Recorrelos UNO POR UNO antes de decir que terminaste. Marcá solo lo que
comprobaste de verdad: marcar sin verificar es peor que no tener checklist,
porque da por bueno lo que nadie miró.

Si alguno no se cumple, arreglalo y volvé a revisarlo. Si alguno no aplica a
esta tienda, decí por qué.

${cuerpo}

Al terminar, informá al usuario: cuántos criterios pasaron, cuáles no aplican y
qué quedó pendiente de su lado (por ejemplo, fotos de productos o el logo).
`;
}
