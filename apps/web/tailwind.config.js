/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,jsx,mdx}',
    './components/**/*.{js,jsx,mdx}',
    './app/**/*.{js,jsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#0d9488', // Teal 600
        secondary: '#f0fdfa', // Teal 50
        accent: '#14b8a6', // Teal 500
        dark: '#0f172a', // Slate 900
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      }
    },
  },
  plugins: [],
};
