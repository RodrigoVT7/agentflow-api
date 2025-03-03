export interface DirectLineActivity {
    type: string;
    from: {
      id: string;
      role?: string;
    };
    text?: string;
    attachments?: any[];
    suggestedActions?: any;
    timestamp?: string;
    localTimestamp?: string;
    id?: string;
    channelId?: string;
    conversation?: {
      id: string;
    };
  }
  
  export interface DirectLineConversation {
    conversationId: string;
    token: string;
    expiresIn: number;
    streamUrl?: string;
  }