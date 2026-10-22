/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
    '../../packages/shared/src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#0d9488', // Teal 600
        secondary: '#f0fdfa', // Teal 50
        accent: '#14b8a6', // Teal 500
        dark: '#0f172a', // Slate 900
        whatsapp: '#25D366',
        'whatsapp-dark': '#128C7E',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s ease-out both',
      },
    },
  },
  plugins: [],
};
