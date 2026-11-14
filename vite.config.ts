/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { appSecurityHeaders } from './shared/securityHeaders.ts';

// O navegador só fala com `/api` na própria origem; o Vite repassa para o servidor somente leitura
// local (`npm run server`). Nenhuma credencial passa pelo Vite nem entra no bundle.
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: `http://127.0.0.1:${process.env.API_PORT ?? '8787'}`,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // CSP e demais cabeçalhos de segurança (shared/securityHeaders.ts). O dev server precisa de uma
  // política mais permissiva (scripts/estilos inline do HMR); o preview usa a política de produção.
  server: { proxy: apiProxy, headers: appSecurityHeaders('development') },
  preview: { proxy: apiProxy, headers: appSecurityHeaders('production') },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
