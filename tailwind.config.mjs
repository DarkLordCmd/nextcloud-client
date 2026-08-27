/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src-ui/index.html', './src-ui/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        nc: {
          bg: '#1a1d23',
          panel: '#21252d',
          border: '#323842',
          hover: '#2a303b',
          accent: '#0082c9',
          accenthover: '#0a93dd',
          text: '#d7dbe0',
          muted: '#8a919c',
        },
      },
    },
  },
  plugins: [],
};
