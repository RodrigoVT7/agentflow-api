export enum AgentStatus {
    OFFLINE = 'offline',
    ONLINE = 'online',
    BUSY = 'busy',
    AWAY = 'away',
  }
  
  export interface Agent {
    id: string;
    name: string;
    email: string;
    status: AgentStatus;
    activeConversations: string[];
    maxConcurrentChats: number;
    role: 'agent' | 'supervisor' | 'admin';
    lastActivity: number;
    password?: string;
    socketId?: string;
  }