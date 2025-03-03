export enum MessageSender {
    USER = 'user',
    BOT = 'bot',
    AGENT = 'agent',
    SYSTEM = 'system',
  }
  
  export interface Message {
    id: string;
    conversationId: string;
    from: MessageSender;
    text: string;
    timestamp: number;
    agentId?: string;
    attachmentUrl?: string;
    metadata?: Record<string, any>;
  }