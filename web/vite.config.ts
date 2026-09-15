import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// appType defaults to 'spa': any unknown path (/sim, /docs) serves index.html, so a
// refresh on a client route never 404s in dev or `vite preview`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
