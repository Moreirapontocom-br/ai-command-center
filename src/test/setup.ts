import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // Nenhum teste faz chamadas de rede reais: sem simulação explícita, o servidor é "inalcançável".
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Rede desabilitada nos testes'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
