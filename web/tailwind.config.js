/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          900: '#0b0f19',
          800: '#111827',
          700: '#1b2436',
        },
      },
    },
  },
  plugins: [],
};
