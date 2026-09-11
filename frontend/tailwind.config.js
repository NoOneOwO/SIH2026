/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Command-centre dark theme tokens (centralized).
        // Keep semantic usage: green = operational, amber = warning,
        // red = danger, teal = navigation/data.
        cmd: {
          bg: '#071018',
          panel: '#101B23',
          panel2: '#14222B',
          border: '#263742',
          track: '#1E2E38',
          ink: '#E8EEF0',
          muted: '#91A2AD',
          teal: '#65BFA9',
          tealdim: '#1B3430',
          green: '#55C99A',
          amber: '#D8B24C',
          red: '#D96B70',
          slateblue: '#8FA8B8',
        },
        damsafe: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#1e3a5f',
        },
        danger: {
          light: '#f8d7da',
          DEFAULT: '#dc3545',
          dark: '#c82333',
        },
        warning: {
          light: '#fff3cd',
          DEFAULT: '#ffc107',
          dark: '#e0a800',
        },
      },
    },
  },
  plugins: [],
};
