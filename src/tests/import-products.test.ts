import { describe,expect,it } from 'vitest'
import { parseImportSheets } from '../lib/import-products'

describe('catalog import validation',()=>{
  it('groups variants by stable family code and keeps physical rows and SKUs', () => {
    const result = parseImportSheets({ Productos: [
      ['codigo', 'nombre', 'categoria', 'precio', 'familia_codigo', 'familia_nombre', 'atributo_1', 'valor_1', 'atributo_2', 'valor_2'],
      ['F-15-N', 'Funda negra', 'Fundas', '2000', 'silicona', 'Funda de silicona', 'Modelo', 'iPhone 15', 'Color', 'Negro'],
      ['F-15-R', 'Funda roja', 'Fundas', '2100', 'silicona', 'Funda de silicona', 'Color', 'Rojo', 'Modelo', 'iPhone 15'],
      ['CABLE', 'Cable', 'Accesorios', '1000', '', '', '', '', '', ''],
    ] })
    expect(result.errors).toEqual([])
    expect(result.products[0]).toMatchObject({ code: 'F-15-N', familyCode: 'silicona', familyName: 'Funda de silicona', variantAttributes: { Modelo: 'iPhone 15', Color: 'Negro' } })
    expect(result.products[1]?.basePriceCents).toBe(210000)
    expect(result.products[2]).not.toHaveProperty('familyCode')
    expect(result.products[2]).not.toHaveProperty('variantAttributes')
  })
  it('rejects duplicate variant combinations regardless of attribute column order', () => {
    const result = parseImportSheets({ Productos: [
      ['nombre', 'categoria', 'precio', 'familia_codigo', 'familia_nombre', 'atributo_1', 'valor_1', 'atributo_2', 'valor_2'],
      ['Uno', 'Fundas', 100, 'F', 'Funda', 'Modelo', '15', 'Color', 'Negro'],
      ['Dos', 'Fundas', 100, 'f', 'Funda', 'Color', 'Negro', 'Modelo', '15'],
    ] })
    expect(result.errors.join(' ')).toMatch(/combinación de atributos duplicada/)
  })
  it('requires consistent families and complete distinct attributes before importing', () => {
    const result = parseImportSheets({ Productos: [
      ['nombre', 'categoria', 'precio', 'familia_codigo', 'familia_nombre', 'atributo_1', 'valor_1', 'atributo_2', 'valor_2'],
      ['Uno', 'Fundas', 100, 'F', 'Funda', 'Color', 'Negro', '', ''],
      ['Dos', 'Otra', 100, 'F', 'Funda', 'Color', 'Rojo', '', ''],
      ['Tres', 'Fundas', 100, 'F', '', 'Color', 'Azul', '', ''],
      ['Cuatro', 'Fundas', 100, 'F', 'Funda', 'Color', 'Negro', 'color', 'Azul'],
    ] })
    expect(result.products).toHaveLength(2)
    expect(result.errors.join(' ')).toMatch(/mismo nombre de familia, categoría y atributos/)
    expect(result.errors.filter((error) => error.includes('completá familia_codigo'))).toHaveLength(2)
  })
  it('rejects excessive decimal precision in numeric Excel cells instead of rounding it', () => {
    const result = parseImportSheets({ Productos: [['nombre', 'categoria', 'precio'], ['Uno', 'Cat', 1.234], ['Dos', 'Cat', '1,234.56']] })
    expect(result.products).toHaveLength(0)
    expect(result.errors.join(' ')).toMatch(/precio no negativo/)
  })
  it('checks active option counts for known new products without rejecting partial patches to existing products', () => {
    const children = {
      GruposOpciones: [['producto_fila', 'grupo_codigo', 'nombre', 'minimo', 'maximo'], ['2', 'G', 'Extras', 2, 2]],
      Opciones: [['grupo_codigo', 'opcion_codigo', 'nombre', 'precio_adicional', 'activo'], ['G', 'A', 'Uno', 0, 'sí'], ['G', 'B', 'Dos', 0, 'no']],
    }
    const invalid = parseImportSheets({ Productos: [['nombre', 'categoria', 'precio'], ['Nuevo', 'Cat', 100]], ...children })
    expect(invalid.errors.join(' ')).toMatch(/producto nuevo sólo tiene 1 opción activa/)
    const patch = parseImportSheets({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['EXISTING', 'Actualizado', 'Cat', 100]], ...children })
    expect(patch.errors).toEqual([])
  })
  it('accepts omitted codes and keeps absent optional fields absent for patches', () => {
    const result = parseImportSheets({ Productos: [['nombre', 'categoria', 'precio'], ['Uno', 'Cat', '100'], ['Dos', 'Cat', '200']] })
    expect(result.errors).toEqual([])
    expect(result.products).toEqual([
      { rowRef: '2', name: 'Uno', category: 'Cat', basePriceCents: 10000 },
      { rowRef: '3', name: 'Dos', category: 'Cat', basePriceCents: 20000 },
    ])
  })
  it('preserves textual SKU zeros and interior spaces but rejects numeric Excel codes and controls', () => {
    const result = parseImportSheets({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], [' 000123 ', 'Uno', 'Cat', '100'], ['Ab  001', 'Dos', 'Cat', '200'], [123, 'Numérico', 'Cat', '100'], ['A\nB', 'Control', 'Cat', '100']] })
    expect(result.products.map((product) => product.code)).toEqual(['000123', 'Ab  001'])
    expect(result.errors.join(' ')).toMatch(/como texto en Excel/)
    expect(result.errors.join(' ')).toMatch(/código, fila o identificador inválido/)
  })
  it('resolves related sheets by the physical product row without inventing a SKU', () => {
    const result = parseImportSheets({
      Productos: [['nombre', 'categoria', 'precio'], [null, null, null], ['Uno', 'Cat', '100']],
      GruposOpciones: [['producto_fila', 'grupo_codigo', 'nombre', 'minimo', 'maximo'], ['3', 'G1', 'Extras', '0', '1']],
      Opciones: [['grupo_codigo', 'opcion_codigo', 'nombre', 'precio_adicional'], ['G1', 'O1', 'Extra', '10']],
    })
    expect(result.errors).toEqual([])
    expect(result.products[0]?.rowRef).toBe('3')
    expect(result.groups[0]).toMatchObject({ productRowRef: '3' })
  })
  it('rejects contradictory row and code references and ambiguous money notation', () => {
    const result = parseImportSheets({
      Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['A', 'Uno', 'Cat', '100'], ['B', 'Dos', 'Cat', '200'], ['C', 'Tres', 'Cat', '1.234']],
      GruposOpciones: [['producto_fila', 'producto_codigo', 'grupo_codigo', 'nombre', 'minimo', 'maximo'], ['2', 'B', 'G1', 'Extras', 0, 1]],
    })
    expect(result.products).toHaveLength(2)
    expect(result.groups).toHaveLength(0)
    expect(result.errors.join(' ')).toMatch(/mismo producto/)
    expect(result.errors.join(' ')).toMatch(/precio no negativo/)
  })
  it('parses integer cents and related option sheets',()=>{const result=parseImportSheets({Productos:[['codigo','nombre','descripcion','categoria','precio','activo'],['P1','Pizza','Grande','Pizzas','12500,50','sí']],GruposOpciones:[['producto_codigo','grupo_codigo','nombre','obligatorio','minimo','maximo'],['P1','G1','Tamaño','sí',1,1]],Opciones:[['grupo_codigo','opcion_codigo','nombre','precio_adicional'],['G1','O1','Grande','1500.25']]});expect(result.errors).toEqual([]);expect(result.products[0]?.basePriceCents).toBe(1_250_050);expect(result.options[0]?.priceDeltaCents).toBe(150_025)})
  it('reports invalid and duplicate rows without importing them silently',()=>{const result=parseImportSheets({Productos:[['codigo','nombre','categoria','precio'],['A','Uno','Cat',10],['A','Dos','Cat',20],['','Inválido','Cat',-1]]});expect(result.products).toHaveLength(2);expect(result.errors.join(' ')).toMatch(/duplicado/i);expect(result.errors.join(' ')).toMatch(/obligatorios/i)})
  it('requires the product headers, prices and at least one valid row',()=>{const missingHeaders=parseImportSheets({Productos:[['nombre'],['Sin código']]});expect(missingHeaders.products).toEqual([]);expect(missingHeaders.errors.join(' ')).toMatch(/faltan columnas/i);expect(missingHeaders.errors.join(' ')).toMatch(/al menos una fila/i);const missingPrice=parseImportSheets({Productos:[['codigo','nombre','categoria','precio'],['P1','Pizza','Pizzas','']]});expect(missingPrice.products).toEqual([])})
  it('keeps an empty promotional price as null and rejects present invalid values',()=>{const result=parseImportSheets({Productos:[['codigo','nombre','categoria','precio','precio_promocional'],['EMPTY','Sin promoción','Cat',100,''],['NEGATIVE','Negativo','Cat',100,-1],['TEXT','Texto','Cat',100,'no-es-un-precio'],['TOO_HIGH','Fuera de rango','Cat',100,10_000_000_001]]});expect(result.products).toHaveLength(1);expect(result.products[0]).toMatchObject({code:'EMPTY',promotionalPriceCents:null});expect(result.errors).toEqual(expect.arrayContaining(['Productos fila 3: el precio promocional debe ser un importe válido, no negativo y dentro del límite permitido.','Productos fila 4: el precio promocional debe ser un importe válido, no negativo y dentro del límite permitido.','Productos fila 5: el precio promocional debe ser un importe válido, no negativo y dentro del límite permitido.']))})
  it('rejects unsafe cross-sheet references and negative option prices',()=>{const result=parseImportSheets({Productos:[['codigo','nombre','categoria','precio'],['P1','Pizza','Pizzas',100]],GruposOpciones:[['producto_codigo','grupo_codigo','nombre','minimo','maximo'],['NOPE','G1','Tamaño',0,1],['P1','G2','Salsa',0,1]],Opciones:[['grupo_codigo','opcion_codigo','nombre','precio_adicional'],['G2','O1','Extra',-1]]});expect(result.errors.join(' ')).toMatch(/producto_codigo no existe/i);expect(result.errors.join(' ')).toMatch(/precio no negativo/i)})
  it('rejects a category that cannot produce a database slug',()=>{const result=parseImportSheets({Productos:[['codigo','nombre','categoria','precio'],['P1','Pizza','---',100]]});expect(result.products).toEqual([]);expect(result.errors.join(' ')).toMatch(/categoría debe contener letras o números/i)})
})
