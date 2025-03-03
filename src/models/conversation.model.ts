import { WebSocket } from 'ws';

export enum ConversationStatus {
  BOT = 'bot',
  WAITING = 'waiting',
  ASSIGNED = 'assigned',
  COMPLETED = 'completed',
}

export interface ConversationData {
  conversationId: string;
  token: string;
  wsConnection?: WebSocket;
  phone_number_id: string;
  from: string;
  isEscalated: boolean;
  lastActivity: number;
  status: ConversationStatus;
}