// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bindingDigest } from './binding.ts';
import type { ApprovalBinding } from './contracts.ts';
import { approvalBindingDigest, sha256Hex } from '../../shared/approvalDigest.ts';

/** O resumo calculado no navegador precisa ser idêntico ao do núcleo (Issue #011, PR 2). */
describe('resumo do vínculo no navegador', () => {
  it('SHA-256 local coincide com o do Node para textos variados (inclusive UTF-8 e blocos-limite)', () => {
    const samples = ['', 'abc', 'ação ✓ 🚀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)];
    for (let i = 0; i < 20; i += 1) samples.push(randomBytes(i * 7).toString('base64'));
    for (const text of samples) expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('resumo do vínculo é o mesmo do servidor; qualquer campo alterado muda o resumo', () => {
    const base: ApprovalBinding = {
      action: 'sandbox.execute',
      projectId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      resource: { type: 'task', id: '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' },
      target: { sha: 'a'.repeat(40), ref: 'agent/claude-code/x' },
      subject: { kind: 'agent', id: 'claude-code' },
      paramsDigest: 'sandbox:abc',
      policyVersion: '2026-11-14.1',
    };
    const variants: ApprovalBinding[] = [
      base,
      { ...base, target: { sha: 'b'.repeat(40), ref: null } },
      { ...base, paramsDigest: 'sandbox:abd' },
      { ...base, policyVersion: '2026-11-15.1' },
      { ...base, subject: { kind: 'agent', id: 'gemini' } },
      { ...base, projectId: null, subject: { kind: 'human', id: 'admin' }, action: 'approvals.retention_change' },
    ];
    const digests = variants.map((b) => {
      expect(approvalBindingDigest(b)).toBe(bindingDigest(b));
      return approvalBindingDigest(b);
    });
    expect(new Set(digests).size).toBe(variants.length);
    // Campos extras de exibição nunca entram no resumo.
    expect(approvalBindingDigest({ ...base, extra: 'x' } as never)).toBe(bindingDigest(base));
  });
});
