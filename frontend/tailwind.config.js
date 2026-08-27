/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './hooks/**/*.{js,ts,jsx,tsx}',
    './store/**/*.{js,ts,jsx,tsx}',
  ],
  // Tailwind is available as utility complement to our custom CSS design system.
  // Primary styling uses CSS custom properties in globals.css.
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        'bg-primary':    '#080b14',
        'bg-secondary':  '#0d1220',
        'bg-card':       '#111826',
        'accent-blue':   '#3b82f6',
        'accent-purple': '#8b5cf6',
        'success':       '#10b981',
        'danger':        '#ef4444',
        'warning':       '#f59e0b',
      },
    },
  },
  plugins: [],
};
