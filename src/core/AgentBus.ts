/**
 * AgentBus — in-process agent-to-agent message routing.
 *
 * All agents register themselves on startup. Any agent can then dispatch
 * a text payload to any other agent by ID — no Slack API call required.
 */

export interface HandoffReceiver {
  receiveHandoff(text: string): Promise<void>;
}

class AgentBus {
  private readonly agents = new Map<string, HandoffReceiver>();

  register(id: string, agent: HandoffReceiver): void {
    this.agents.set(id, agent);
  }

  async dispatch(targetId: string, text: string): Promise<string> {
    const agent = this.agents.get(targetId);
    if (!agent) {
      const known = [...this.agents.keys()].join(', ') || '(none)';
      return `No agent with id "${targetId}" found. Known agents: ${known}`;
    }
    void agent.receiveHandoff(text);
    return `Dispatched to ${targetId}.`;
  }

  list(): string[] {
    return [...this.agents.keys()];
  }
}

export const agentBus = new AgentBus();
