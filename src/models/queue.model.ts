import { Message } from "./message.model";

export interface QueueItem {
    conversationId: string;
    from: string;
    phone_number_id: string;
    startTime: number;
    priority: number;
    tags: string[];
    assignedAgent: string | null;
    messages: Message[];
    metadata?: {
      escalationReason?: string;
      userLocation?: string;
      previousInteractions?: number;
      customFields?: Record<string, any>;
      hasFullHistory?: boolean;  // Añadir esta propiedad
      originalMessage?: string;  // También útil para diagnóstico
    };
  }