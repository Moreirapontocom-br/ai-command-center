import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewId } from '../../types';
import { AppLayout } from './AppLayout';

function TestApp() {
  const [view, setView] = useState<ViewId>('dashboard');
  return (
    <AppLayout currentView={view} onNavigate={setView}>
      <button type="button">Ação do conteúdo</button>
    </AppLayout>
  );
}

function getToggle() {
  // O botão do cabeçalho é o único que controla a sidebar via aria-controls.
  return document.querySelector<HTMLButtonElement>('button[aria-controls="app-sidebar"]')!;
}

function getDrawer() {
  return screen.getByRole('dialog', { name: 'Menu de navegação' });
}

async function openMenu() {
  const user = userEvent.setup();
  render(<TestApp />);
  await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
  return user;
}

describe('AppLayout — menu mobile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('atualiza nome acessível e aria-expanded conforme o estado', async () => {
    await openMenu();
    const toggle = getToggle();
    expect(toggle).toHaveAccessibleName('Fechar menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(getDrawer()).toHaveAttribute('aria-modal', 'true');
  });

  it('não expõe a gaveta como diálogo quando fechada', () => {
    render(<TestApp />);
    expect(getToggle()).toHaveAccessibleName('Abrir menu');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('move o foco para dentro da gaveta ao abrir', async () => {
    await openMenu();
    expect(within(getDrawer()).getByRole('button', { name: 'Fechar menu' })).toHaveFocus();
  });

  it('fecha com Escape e devolve o foco ao botão do menu', async () => {
    const user = await openMenu();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(getToggle()).toHaveFocus();
  });

  it('fecha pelo botão interno e devolve o foco', async () => {
    const user = await openMenu();
    await user.click(within(getDrawer()).getByRole('button', { name: 'Fechar menu' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getToggle()).toHaveFocus();
  });

  it('fecha ao clicar no overlay e devolve o foco', async () => {
    const user = await openMenu();
    await user.click(screen.getByTestId('sidebar-overlay'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getToggle()).toHaveFocus();
  });

  it('mantém o foco do Tab dentro da gaveta (nos dois sentidos)', async () => {
    const user = await openMenu();
    const drawer = getDrawer();
    const closeButton = within(drawer).getByRole('button', { name: 'Fechar menu' });
    const lastNavItem = within(drawer).getByRole('button', { name: 'Auditoria' });

    await user.tab({ shift: true });
    expect(lastNavItem).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();

    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(drawer).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('torna o conteúdo de fundo inerte apenas com a gaveta aberta', async () => {
    const user = await openMenu();
    const content = screen.getByRole('main').parentElement!;
    expect(content).toHaveAttribute('inert');

    await user.keyboard('{Escape}');
    expect(content).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: 'Ação do conteúdo' }));
  });

  it('navega pela gaveta, fecha o menu e devolve o foco', async () => {
    const user = await openMenu();
    await user.click(within(getDrawer()).getByRole('button', { name: 'Agentes' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Agentes' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getToggle()).toHaveFocus();
  });

  it('fecha a gaveta ao mudar para o layout desktop', async () => {
    let listener: (() => void) | undefined;
    const mql = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mql));

    await openMenu();
    expect(getDrawer()).toBeInTheDocument();

    mql.matches = true;
    act(() => listener?.());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
