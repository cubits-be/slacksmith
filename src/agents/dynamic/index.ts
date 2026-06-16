import { SlacksmithAgent, SharedServices } from '../base/SlacksmithAgent';

export class DynamicAgent extends SlacksmithAgent {
  readonly id: string;
  readonly name: string;
  readonly persona = ''; // loaded from PERSONA.md at runtime
  readonly allowedTools: string[] | undefined;
  readonly excludedTools: string[] | undefined;

  constructor(
    id: string,
    name: string,
    botToken: string,
    appToken: string,
    services: SharedServices,
    model?: string,
    allowedTools?: string[],
    excludedTools?: string[],
  ) {
    super(botToken, appToken, services, model);
    this.id = id;
    this.name = name;
    this.allowedTools = allowedTools;
    this.excludedTools = excludedTools;
  }
}
