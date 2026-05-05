import type Anthropic from '@anthropic-ai/sdk';

export interface Session {
  id: string;
  messages: Anthropic.Messages.MessageParam[];
  createdAt: Date;
  updatedAt: Date;
}

export function createSession(id?: string): Session {
  return {
    id: id ?? crypto.randomUUID(),
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function addMessage(
  session: Session,
  message: Anthropic.Messages.MessageParam,
): void {
  session.messages.push(message);
  session.updatedAt = new Date();
}
