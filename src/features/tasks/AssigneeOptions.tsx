import type { AgentRef } from '../../../shared/contracts.ts';
import { AGENT_LABELS } from './workLabels';

export interface AssigneeChoices {
  users: Array<{ userId: string; label: string }>;
  agents: AgentRef[];
}

/** `<option>`s de responsável: pessoas (do servidor) e agentes. */
export function AssigneeOptions({ choices }: { choices: AssigneeChoices }) {
  return (
    <>
      <optgroup label="Pessoas">
        {choices.users.map((user) => (
          <option key={user.userId} value={`human:${user.userId}`}>
            {user.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Agentes">
        {choices.agents.map((agent) => (
          <option key={agent} value={`agent:${agent}`}>
            {AGENT_LABELS[agent]}
          </option>
        ))}
      </optgroup>
    </>
  );
}
