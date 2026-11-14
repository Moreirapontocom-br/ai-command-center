import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../../shared/contracts.ts';
import App from '../../App';
import { apiError, configuredStatus, json, mockApi, PROJECT_ID, snapshotReply } from '../../test/githubFixtures';

const event = (overrides: Partial<AuditEvent>): AuditEvent => ({
  id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  seq: 1,
  at: '2026-11-14T10:00:00.000Z',
  action: 'auth.login',
  actor: { kind: 'human', id: 'admin' },
  projectId: null,
  resource: { type: 'session', id: null },
  outcome: 'success',
  context: {},
  ...overrides,
});

async function openAudit() {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Auditoria' }));
}

const base = { status: [json(configuredStatus)], snapshot: [snapshotReply()] };

describe('página de auditoria', () => {
  it('lista eventos com data, ação, resultado, autor, projeto e contexto', async () => {
    mockApi({
      ...base,
      audit: [
        json({
          events: [
            event({ id: 'a1b2c3d4-0000-4000-8000-000000000003', seq: 3, action: 'task.status_changed', projectId: PROJECT_ID, resource: { type: 'task', id: '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' }, context: { from: 'pending', to: 'in_progress' } }),
            event({ id: 'a1b2c3d4-0000-4000-8000-000000000002', seq: 2, action: 'auth.login_rejected', actor: { kind: 'system', id: 'anonymous' }, outcome: 'failure', context: { reason: 'invalid_credentials' } }),
            event({ id: 'a1b2c3d4-0000-4000-8000-000000000001', seq: 1 }),
          ],
          nextBefore: null,
          retention: { droppedEvents: 0 },
        }),
      ],
    });
    render(<App />);
    await openAudit();
    const list = await screen.findByRole('list', { name: 'Eventos de auditoria' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Status da tarefa alterado');
    expect(items[0]).toHaveTextContent('Sucesso');
    expect(items[0]).toHaveTextContent('Autor: admin@example.test (administrador)');
    expect(items[0]).toHaveTextContent('Projeto: AI Command Center');
    expect(items[0]).toHaveTextContent('from=pending to=in_progress');
    expect(items[1]).toHaveTextContent('Login recusado');
    expect(items[1]).toHaveTextContent('Falha');
    expect(items[1]).toHaveTextContent('Sistema (cliente não autenticado)');
    expect(items[0].querySelector('time')).toHaveAttribute('datetime', '2026-11-14T10:00:00.000Z');
  });

  it('filtros por projeto, evento e resultado viram parâmetros da consulta', async () => {
    const fetchMock = mockApi({ ...base });
    render(<App />);
    await openAudit();
    const user = userEvent.setup();
    const filters = await screen.findByRole('region', { name: 'Filtros' });
    await user.selectOptions(within(filters).getByLabelText('Projeto'), PROJECT_ID);
    await user.selectOptions(within(filters).getByLabelText('Evento'), 'task.completion_confirmed');
    await user.selectOptions(within(filters).getByLabelText('Resultado'), 'blocked');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
        `/api/audit?projectId=${PROJECT_ID}&action=task.completion_confirmed&outcome=blocked`,
      ),
    );
    expect(await screen.findByText('Nenhum evento para os filtros escolhidos.')).toBeInTheDocument();
    // Nenhuma escrita é enviada pela página de auditoria.
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).startsWith('/api/audit') && init?.method === 'POST')).toBe(false);
  });

  it('paginação e aviso de retenção', async () => {
    const fetchMock = mockApi({
      ...base,
      audit: [
        json({ events: [event({ seq: 10 })], nextBefore: 10, retention: { droppedEvents: 12 } }),
        json({ events: [event({ id: 'b1b2c3d4-0000-4000-8000-000000000009', seq: 9, action: 'auth.logout' })], nextBefore: null, retention: { droppedEvents: 12 } }),
      ],
    });
    render(<App />);
    await openAudit();
    expect(await screen.findByText(/12 evento\(s\) antigo\(s\) foram descartados/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Carregar mais' }));
    const list = await screen.findByRole('list', { name: 'Eventos de auditoria' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Logout');
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain('/api/audit?before=10');
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
  });

  it('erro da API é exibido com mensagem clara', async () => {
    mockApi({ ...base, audit: [apiError('bad_request', 400)] });
    render(<App />);
    await openAudit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar a auditoria');
  });

  it('servidor fora do ar: auditoria indisponível', async () => {
    render(<App />);
    await openAudit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Auditoria indisponível');
  });
});
