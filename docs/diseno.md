# Guía de diseño

Identidad: **agenda de papel con rotulador**. El cromo de la interfaz es neutro (papel y tinta). Lo único saturado son los colores de los calendarios del usuario. Hay un solo detalle memorable: un trazo de rotulador amarillo (`.mark`) que señala **hoy** y **ahora**, y nada más.

Archivos: `web/src/styles/tokens.css` (variables y `@font-face`) y `web/src/styles/base.css` (reset, elementos base y utilidades). Los dos se importan una sola vez en `main.ts`. Cada componente mantiene su CSS con ámbito propio y **solo usa tokens**: no se escriben colores, radios ni tamaños sueltos.

## Tokens

| Token                        | Claro                       | Oscuro (automático)       | Uso                                        |
| ---------------------------- | --------------------------- | ------------------------- | ------------------------------------------ |
| `--bg`                       | #EEF1F4 niebla              | #0F141A                   | fondo de la app                            |
| `--surface`                  | #FFFFFF papel               | #171E26                   | listas, hojas                              |
| `--surface-2`                | #F7F8FA                     | #1D2630                   | hover, zonas secundarias                   |
| `--ink`                      | #17202B tinta               | #E8EDF2                   | texto                                      |
| `--ink-2`                    | #5C6B7A                     | #9AA8B6                   | texto secundario (AA sobre bg y surface)   |
| `--line`                     | #D8DEE5                     | #2A3541                   | separadores de 1px                         |
| `--accent` / `--accent-ink`  | #2F5BEA / blanco            | #7C9BFF / #0F141A         | acción principal, enlaces, foco            |
| `--accent-soft`              | tinte del 12 %              | igual                     | fondos de selección suaves                 |
| `--mark` / `--mark-ink`      | #FFD84D / tinta             | igual (tinta oscura)      | solo para hoy y ahora                      |
| `--danger`, `--warn`, `--ok` | #C62828, #955A00\*, #1E7A3C | #FF8A80, #F0B44C, #6FCF97 | estados                                    |
| `--shadow-float`             | una única sombra suave      |                           | solo para hojas, menús y el botón flotante |

\* #B26A00 daba 3.7:1 sobre `--bg`, así que se oscureció a #955A00 (4.9:1). Todos los pares texto/fondo cumplen AA (4.5:1) en ambos modos. El texto sobre `--danger` usa `--accent-ink`.

- **Espaciado:** `--sp-1..7` = 4/8/12/16/24/32/48 px.
- **Radios por jerarquía:** `--r-s` 6px (controles pequeños), `--r-m` 12px (superficies agrupadas), `--r-l` 20px (hojas). No se usa el mismo radio para todo.
- **Táctil:** `--tap` 44px como mínimo para cualquier elemento pulsable.
- **Zonas seguras:** `--safe-top/right/bottom/left` (valores de `env(safe-area-inset-*)`).
- **Movimiento:** `--dur` 180ms, `--ease`.

## Tipografía

- **Bricolage Grotesque** (`--font-display`): títulos, cabeceras y números grandes de día. **Figtree** (`--font-body`): resto de la interfaz.
- Están alojadas en el propio proyecto (fontsource, solo el subconjunto latin y el eje wght) y entran en la precaché del service worker: 61 KB en total.
- **Escala:** `--fs-xs`, `--fs-s`, `--fs-m`, `--fs-l`, `--fs-xl`, `--fs-2xl`, `--fs-display` (las mayores usan clamp).
- **Interlineado:** `--lh-body` 1.5 y `--lh-display` 1.1.
- **Ancho de línea:** `--measure` 68ch.
- **Horas y números:** se escriben en `<time>` o con la clase `.num`, que usan cifras tabulares.

## Clases utilitarias (base.css)

- `.btn`: botón base con 44px de alto y `--r-s`. Variantes: `.btn-primary` (cobalto), `.btn-quiet` (sin fondo, texto cobalto) y `.btn-danger`. Sirven también en `<a>`.
- `input`, `textarea`, `select` llevan ya su estilo (ancho 100 %, 44px, 16px para que iOS no haga zoom).
- `.list`: lista agrupada al estilo iOS. Se escribe `<ul class="list"><li><a|button>…</a></li></ul>`. El contenedor usa `--surface` con `--r-m` y las filas se separan con una línea de 1px. Para filas sin enlace se usa `.list-row`. **No se usan tarjetas sueltas con sombra.**
- `.bar`: barra vertical de 4px con el color del calendario, `<span class="bar" style="--c: {color}"></span>`, colocada dentro de una fila flex.
- `.mark`: trazo de rotulador detrás de un texto o número, `<span class="mark">24</span>`. Fuerza el color `--mark-ink`. **Solo se usa para hoy y ahora**: el día de hoy en el calendario, la línea de "ahora" y la pestaña activa.
- `.sheet`: hoja, `<dialog class="sheet">` abierta con `showModal()`. En móvil sale desde abajo con `--r-l` arriba y respeta la zona segura. A partir de 768px se muestra como diálogo centrado de 32rem como máximo.
- `.muted` (texto `--ink-2`) y `.sr-only`.
- `:focus-visible` dibuja un anillo cobalto de 2px con desplazamiento. No hay que quitarlo.
- Con `prefers-reduced-motion` se anulan todas las transiciones y animaciones.

## Layout (`components/Layout.svelte`)

Contrato: `<Layout sidebar={snippet?}>{pantalla}</Layout>`. Las rutas y el guard siguen en `App.svelte`.

- `children`: la pantalla activa.
- `sidebar?: Snippet`: zona bajo "Nota rápida" en el menú lateral de escritorio (ahí irá el filtro de calendarios). En móvil no se muestra.

Cada pantalla declara su título y sus acciones con `components/PageHeader.svelte`:

```svelte
<PageHeader title="Hoy">
  {#snippet actions()}<button class="btn btn-quiet">Actualizar</button>{/snippet}
</PageHeader>
```

Esto genera un `<h1>` grande en Bricolage con las acciones a la derecha. La pantalla no debe envolverse en contenedores con relleno propio, porque el Layout ya pone los márgenes y el ancho máximo.

- **Por debajo de 1024px (iPhone y tableta):**
  - No hay barra superior. El contenido empieza bajo la zona segura y tiene un ancho máximo de 720px.
  - Barra de pestañas inferior fija con 4 destinos (Hoy, Calendario, Notas, Ajustes), cada uno con icono SVG y etiqueta visible. La pestaña activa lleva `.mark` y `aria-current="page"`. La barra respeta `--safe-bottom`.
  - Botón flotante redondo de "Nota rápida" (56px, cobalto) sobre la barra, a la derecha.
  - El contenido tiene relleno inferior suficiente para que no lo tapen ni la barra ni el botón flotante.
- **A partir de 1024px:**
  - Menú lateral fijo de 232px con el nombre de la app, los 4 destinos, el botón principal "Nota rápida" y debajo el `sidebar`.
  - Contenido con márgenes de 48px y un ancho máximo de 880px.
- **Puntos de referencia (landmarks):** `nav "Navegación principal"` (lateral) y `nav "Navegación inferior"` (pestañas) están siempre en el DOM. Cada vista oculta uno con CSS y los tests cuentan con que existan los dos. Hay un único `<main>`.

## Prohibido

- Texto en MAYÚSCULAS en etiquetas, cabeceras o botones. Se escribe en minúscula normal ("Nota rápida").
- Etiquetas con fuente monoespaciada.
- La flecha "→" decorativa.
- Colores, radios o sombras escritos a mano fuera de los tokens. El único color saturado es el de los calendarios.
- Tarjetas con sombra. Para agrupar se usa `.list`.
- Usar el mismo radio para todo.
- Animaciones de entrada decorativas. El movimiento solo responde a acciones del usuario, como abrir una hoja o confirmar.
- Elementos pulsables de menos de 44px, o quitar el foco visible.
- Usar `.mark` para algo que no sea hoy o ahora.
- Añadir librerías de UI o CSS, o cargar fuentes desde un CDN.
