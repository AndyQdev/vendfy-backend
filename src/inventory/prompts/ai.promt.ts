import { StoreContext } from '../interfaces/ai.interface';

// Debe coincidir con src/shared/lib/category-icons.ts del frontend.
// Son nombres de íconos de lucide-react (válidos también en lucide-react-native).
export const ALLOWED_CATEGORY_ICONS: readonly string[] = [
  // Tienda y compras
  'Tag', 'Package', 'ShoppingBag', 'ShoppingCart', 'Gift', 'Receipt', 'Ticket', 'Store',
  // Hogar
  'Home', 'Sofa', 'Bed', 'Lamp', 'Bath', 'Armchair', 'DoorOpen', 'BookOpen',
  // Tecnología
  'Laptop', 'Smartphone', 'Tablet', 'Headphones', 'Watch', 'Camera', 'Monitor',
  'Keyboard', 'Mouse', 'Gamepad2', 'Cpu', 'Cable', 'HardDrive', 'Printer', 'Router', 'Tv',
  // Moda y accesorios
  'Shirt', 'Glasses', 'Gem', 'Crown', 'Footprints', 'Sparkles',
  // Comida y bebida
  'Coffee', 'Pizza', 'IceCream', 'Wine', 'Beer', 'CakeSlice', 'Utensils',
  'Apple', 'Sandwich', 'Carrot', 'Egg', 'Fish', 'Beef',
  // Deportes
  'Dumbbell', 'Bike', 'Medal', 'Trophy', 'Tent',
  // Belleza y bienestar
  'Flower', 'Flower2', 'Heart', 'Palette', 'Brush', 'Scissors', 'Droplet',
  // Niños y juguetes
  'Baby', 'Book', 'Rocket', 'Puzzle', 'ToyBrick',
  // Oficina
  'Briefcase', 'Pen', 'FileText', 'Newspaper', 'Calculator',
  // Vehículos
  'Car', 'Bus', 'Plane', 'Ship', 'Fuel', 'Train',
  // Herramientas
  'Wrench', 'Hammer', 'Drill', 'PaintBucket', 'HardHat',
  // Naturaleza
  'Leaf', 'TreePine', 'Sprout',
  // Mascotas
  'Dog', 'Cat', 'Bird', 'Rabbit', 'PawPrint',
  // Entretenimiento
  'Music', 'Film', 'Disc', 'Mic', 'Guitar',
  // Salud
  'Stethoscope', 'Pill', 'Syringe', 'HeartPulse', 'BriefcaseMedical',
  // Otros
  'Flame', 'Zap', 'Sun', 'Moon', 'Cloud',
] as const;

/**
 * Cómo escribir las especificaciones. De ellas salen los filtros de la tienda
 * web (GET product/store/:id/filtros): si una laptop dice "RAM" y otra
 * "Memoria RAM", el comprador ve dos filtros para lo mismo. La comparación ya
 * ignora mayúsculas, tildes y espacios ("16GB" = "16 GB"); esto cubre lo que
 * no se puede adivinar, que son los sinónimos.
 */
/**
 * Cuándo proponer una subcategoría. Solo cuando ordena de verdad: una tienda
 * chica con todo en dos niveles es más difícil de recorrer, no más fácil.
 */
const REGLA_SUBCATEGORIAS = `SUBCATEGORÍAS (opcional): hay dos niveles como máximo, escritos "Principal › Subcategoría" (ej: "Accesorios › Cargadores", "Computación › Laptops"). Úsalas SOLO cuando una categoría junte muchos productos de tipos distintos (más de 8) o cuando ya existan en la lista. Si no, usa una categoría simple sin "›". Nunca más de dos niveles.`;

export const GUIA_ESPECIFICACIONES =`REGLAS PARA LAS ESPECIFICACIONES (de ellas salen los filtros de la tienda web):
- Claves cortas y SIEMPRE las mismas para el mismo dato, en español y con mayúscula inicial. Usá estas cuando apliquen:
  · Electrónica: "Procesador", "RAM", "Almacenamiento", "Pantalla", "Sistema operativo", "Tarjeta gráfica", "Batería", "Conectividad", "Color".
  · Ropa y calzado: "Talla", "Color", "Material", "Género", "Temporada".
  · Perfumes y cuidado personal: "Contenido", "Familia olfativa", "Género", "Tipo de piel".
  · Alimentos y bebidas: "Contenido", "Sabor", "Presentación", "Origen".
  · Hogar: "Material", "Medidas", "Color", "Capacidad".
- Valores cortos (menos de 40 caracteres), un solo dato por valor y con la unidad: "16 GB", "15,6 pulgadas", "512 GB SSD", "100 ml". Nada de oraciones.
- No repitas como especificación la marca ni el nombre del producto: la marca tiene su propio campo.`;

export class AiPrompts {

  /**
   * Prompt principal para generar productos desde cualquier fuente (archivo, imagen, texto)
   * Incluye categorías existentes para asignación inteligente
   */
  static buildGenerateProductsPrompt(
    content: string,
    contentType: 'file' | 'image',
    existingCategories: string[],
    userPrompt?: string,
  ): string {
    const categoriesSection = existingCategories.length > 0
      ? `CATEGORÍAS EXISTENTES DEL USUARIO:
${existingCategories.map((c, i) => `${i + 1}. ${c}`).join('\n')}

REGLA DE CATEGORÍAS: Asigna cada producto a una de las categorías existentes si tiene sentido, escribiéndola EXACTAMENTE como aparece en la lista (con su ruta si la tiene, "Accesorios › Cargadores"). Si un producto NO encaja en ninguna categoría existente, puedes proponer una nueva en el campo "categoryName". Prioriza SIEMPRE las categorías existentes.
${REGLA_SUBCATEGORIAS}`
      : `El usuario NO tiene categorías aún. Genera nombres de categorías apropiados en el campo "categoryName" para cada producto. Agrupa productos similares bajo la misma categoría. Genera entre 3-6 categorías distintas según los productos.
${REGLA_SUBCATEGORIAS}`;

    const userPromptSection = userPrompt?.trim()
      ? `\nINSTRUCCIONES DEL USUARIO (PRIORIDAD MÁXIMA):
${userPrompt.trim()}

IMPORTANTE: Las instrucciones del usuario tienen PRIORIDAD sobre las reglas generales. Si el usuario pide nombres creativos, precios específicos, stock particular, etc., respétalas al 100%.
`
      : '';

    const sourceInstruction = contentType === 'image'
      ? `Analiza las imágenes y crea productos basándose en lo que ves. Solo describe productos REALMENTE visibles.`
      : `Analiza el siguiente contenido y extrae todos los productos mencionados. Respeta nombres exactos cuando los haya.`;

    const iconsSection = `ÍCONOS VÁLIDOS PARA CATEGORÍAS (lucide-react). Elige EXACTAMENTE uno de esta lista para el campo "categoryIcon" según el tema de la categoría del producto. Devuelve el nombre TAL CUAL, respetando mayúsculas y minúsculas. Si ninguno encaja, usa "Tag".
${ALLOWED_CATEGORY_ICONS.join(', ')}`;

    return `${userPromptSection}
${sourceInstruction}

${categoriesSection}

${iconsSection}

POR CADA PRODUCTO genera:
- name: Nombre del producto (claro y descriptivo)
- description: Descripción útil del producto (2-3 oraciones)
- price: Precio en BOB (realista para el mercado boliviano)
- stockQuantity: Stock inicial (por defecto 0 si no se especifica)
- categoryName: Nombre de categoría existente o nueva
- categoryIcon: Nombre del ícono de la lista anterior que mejor represente la CATEGORÍA (no el producto). Productos de la misma categoría deben tener el MISMO categoryIcon.
- tags: Array de 3-5 tags relevantes (ej: ["electrónica", "portátil", "gaming"])
- specifications: Objeto con especificaciones clave-valor (ej: {"Material": "Algodón", "Talla": "M"})

${GUIA_ESPECIFICACIONES}

CONTENIDO A ANALIZAR:
${content}

RESPONDE ÚNICAMENTE con JSON válido en este formato:
{
  "products": [
    {
      "name": "Nombre del producto",
      "description": "Descripción del producto",
      "price": 150.00,
      "stockQuantity": 0,
      "categoryName": "Nombre de categoría",
      "categoryIcon": "Package",
      "tags": ["tag1", "tag2", "tag3"],
      "specifications": {"Clave": "Valor"}
    }
  ]
}`;
  }

  /**
   * Prompt para procesar chunks de texto de archivos grandes
   */
  static buildChunkPrompt(chunk: string, chunkNumber: number, totalChunks: number, existingCategories: string[], userPrompt?: string): string {
    return this.buildGenerateProductsPrompt(
      `(Chunk ${chunkNumber}/${totalChunks}):\n${chunk}`,
      'file',
      existingCategories,
      userPrompt,
    );
  }

  /**
   * Prompt para generar categorías basadas en contexto de tienda
   */
  static buildCategoriesPrompt(userPrompt: string, storeContext: StoreContext): string {
    const contextSection = this.buildStoreContextSection(storeContext);

    return `
${contextSection}

Basándote en el contexto de la tienda y la solicitud del usuario, genera categorías relevantes y útiles.

SOLICITUD DEL USUARIO:
${userPrompt}

INSTRUCCIONES:
1. Genera entre 3-8 categorías relevantes según la solicitud
2. Cada categoría debe tener un nombre claro y una descripción útil
3. Las categorías deben ser prácticas para organizar productos

RESPONDE EN ESTE FORMATO JSON EXACTO:
{
  "categories": [
    {
      "name": "Nombre de la categoría",
      "description": "Descripción clara y útil de la categoría"
    }
  ]
}`;
  }

  /**
   * Prompt para generar marcas basadas en contexto de tienda
   */
  static buildBrandsPrompt(userPrompt: string, storeContext: StoreContext): string {
    const contextSection = this.buildStoreContextSection(storeContext);

    return `
${contextSection}

Basándote en el contexto de la tienda, genera marcas relevantes y realistas.

SOLICITUD DEL USUARIO:
${userPrompt}

RESPONDE EN ESTE FORMATO JSON EXACTO:
{
  "brands": [
    {
      "name": "Nombre de la marca",
      "description": "Descripción del enfoque de la marca"
    }
  ]
}`;
  }

  private static buildStoreContextSection(storeContext: StoreContext): string {
    let contextSection = `CONTEXTO DE LA TIENDA:\nNombre: ${storeContext.name}`;

    if (storeContext.description) {
      contextSection += `\nDescripción: ${storeContext.description}`;
    }

    if (storeContext.recentProducts.length > 0) {
      contextSection += `\n\nPRODUCTOS RECIENTES:`;
      storeContext.recentProducts.forEach((product, index) => {
        contextSection += `\n${index + 1}. ${product.name}`;
        if (product.categoryName) contextSection += ` (${product.categoryName})`;
      });
    }

    return contextSection + '\n';
  }

  static getSystemMessages() {
    return {
      imageAnalysis: 'Eres un experto catalogador de inventario que analiza imágenes para crear productos. Identificas lo que ves, generas descripciones útiles, tags y especificaciones. Asignas categorías inteligentemente. Siempre respondes en JSON válido.',

      textAnalysis: 'Eres un experto catalogador de inventario. Creas productos con descripciones, tags y especificaciones a partir del contenido proporcionado. Asignas categorías inteligentemente. Siempre respondes en JSON válido.',

      categoryGeneration: 'Eres un experto en organización de inventarios. Generas categorías útiles y bien estructuradas.',

      brandGeneration: 'Eres un experto en branding. Generas marcas realistas y atractivas.',
    };
  }
}
