/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        sandstorm: {
          bg: '#15131b',
          surface: '#1d1a26',
          'surface-hover': '#221f2e',
          border: '#2a2536',
          'border-light': '#342f42',
          text: '#e8e4f0',
          'text-secondary': '#b8b0cc',
          muted: '#7a7094',
          accent: '#d4a854',
          'accent-hover': '#e0bc72',
          'accent-dim': 'rgba(212, 168, 84, 0.15)',
          rail: '#0e0c15',
          // Kanban column state colors (editorial palette)
          'state-refining': '#c9a227',
          'state-ready': '#4a7fb5',
          'state-instack': '#c9a227',
          'state-propen': '#7b5ea7',
          'state-merged': '#4a8c6e',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', 'monospace'],
      },
      boxShadow: {
        'glow': '0 0 20px rgba(212, 168, 84, 0.15)',
        'card': '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
        'card-hover': '0 4px 12px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3)',
        'dialog': '0 20px 60px rgba(0, 0, 0, 0.5), 0 8px 20px rgba(0, 0, 0, 0.3)',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
