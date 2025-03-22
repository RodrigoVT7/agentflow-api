export enum AgentStatus {
    OFFLINE = 'Desconectado',
    ONLINE = 'En linea',
    BUSY = 'Ocupado',
    AWAY = 'No disponible',
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