// src/models/directline.model.ts
import WebSocket from 'ws';

export interface DirectLineConversation {
    conversationId: string;
    token: string;
    expires_in: number;
    streamUrl?: string;
}

export interface DirectLineToken {
    token: string;
    timestamp: number;
}

export interface DirectLineActivity {
    id?: string;
    type: string;
    timestamp?: string;
    from?: {
        id: string;
        name?: string;
        role?: string;
    };
    text?: string;
    value?: any;
    attachments?: any[];
    suggestedActions?: {
        actions: {
            type: string;
            title: string;
            value: string;
        }[];
    };
    channelData?: any;
}