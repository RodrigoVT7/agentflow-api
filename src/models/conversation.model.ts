// src/models/conversation.model.ts
import WebSocket from 'ws';

export enum ConversationStatus {
    BOT = 'bot',
    WAITING = 'waiting',
    AGENT = 'agent',
    COMPLETED = 'completed'
}

export interface ConversationData {
    conversationId: string;
    token: string;
    tokenTimestamp?: number; // Marca de tiempo cuando se obtuvo el token
    wsConnection?: WebSocket;
    phone_number_id: string;
    from: string;
    isEscalated: boolean;
    lastActivity: number;
    status: ConversationStatus;
}