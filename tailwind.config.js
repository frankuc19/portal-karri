/**
 * Config para COMPILAR el CSS de Tailwind a un archivo estático
 * (panel/public/assets/tailwind.css) y dejar de usar el Play CDN
 * (cdn.tailwindcss.com), que descarga ~400 KB de JS y compila el CSS en el
 * navegador EN CADA CARGA — la causa de que las páginas abran lento.
 *
 * Para regenerar el CSS cuando se agreguen clases nuevas:
 *   npm run build:css
 *
 * El `content` escanea todo el HTML y JS del panel para incluir solo las
 * clases realmente usadas (CSS chico). Las clases que el JS togglea de forma
 * dinámica (flex, hidden) quedan cubiertas porque también se escanean los .js.
 */
module.exports = {
  content: [
    './panel/public/**/*.html',
    './panel/public/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        electric:        '#78fcd6',
        'electric-dim':  '#00ffb6',
        'green-wa':      '#00ff41',
        'dark-900':      '#ffffff',
        'dark-800':      '#ffffff',
        'dark-700':      '#ffffff',
        'dark-600':      '#f1f3f2',
        'dark-500':      '#f4f5f6',
        'dark-400':      '#e3e6e5',
        // compat aliases — mantienen clases JS sin cambios
        primary:                     '#78fcd6',
        'on-primary':                '#080b0a',
        error:                       '#dc2626',
        background:                  '#ffffff',
        'on-surface':                '#12181a',
        'on-surface-variant':        'rgba(15,23,22,0.5)',
        outline:                     'rgba(15,23,22,0.35)',
        'outline-variant':           'rgba(15,23,22,0.08)',
        'surface-container':         '#e3e6e5',
        'surface-container-low':     '#ffffff',
        'surface-container-lowest':  '#ffffff',
        'surface-container-high':    '#f1f3f2',
        'surface-container-highest': '#f1f3f2',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
};
