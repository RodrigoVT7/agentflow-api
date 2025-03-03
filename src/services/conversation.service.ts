// src/services/conversation.service.ts
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { ConversationData, ConversationStatus } from '../models/conversation.model';
import { DirectLineConversation, DirectLineActivity } from '../models/directline.model';
import { WhatsAppService } from './whatsapp.service';
import { initQueueService } from './queue.service';
import { MessageSender } from '../models/message.model';
import config from '../config/app.config';

class ConversationService {
  private conversations: Map<string, ConversationData>;
  private whatsappService: WhatsAppService;
  private queueService = initQueueService();
  
  // Patrones para detectar escalamiento en mensajes del bot
  private escalationPatterns: string[] = [
    "la remisión a un agente por chat",
    "te comunicaré con un agente",
    "hablar con un agente",
    "hablar con una persona",
    "hablar con alguien",
    "devolver llamada",
    "llamar al servicio"
  ];

  constructor() {
    this.conversations = new Map<string, ConversationData>();
    this.whatsappService = new WhatsAppService();
    
    // Iniciar limpieza periódica de conversaciones inactivas
    setInterval(() => this.cleanupInactiveConversations(), 15 * 60 * 1000);
  }

  /**
   * Obtener o crear una conversación para un usuario
   */
  public async getOrCreateConversation(from: string, phone_number_id: string): Promise<ConversationData> {
    // Verificar si ya existe la conversación
    let conversation = this.conversations.get(from);
    
    if (!conversation) {
      // Crear una nueva conversación con DirectLine
      const directLineConversation = await this.createDirectLineConversation();
      
      // Configurar WebSocket para recibir respuestas del bot
      const wsConnection = await this.setupWebSocketConnection(
        directLineConversation.conversationId,
        directLineConversation.token,
        phone_number_id,
        from
      );
      
      // Crear nueva conversación
      conversation = {
        conversationId: directLineConversation.conversationId,
        token: directLineConversation.token,
        wsConnection,
        phone_number_id,
        from,
        isEscalated: false,
        lastActivity: Date.now(),
        status: ConversationStatus.BOT
      };
      
      this.conversations.set(from, conversation);
    }
    
    return conversation;
  }

  /**
   * Crear una nueva conversación DirectLine
   */
  private async createDirectLineConversation(): Promise<DirectLineConversation> {
    const response = await fetch(`${config.directline.url}/conversations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await this.getDirectLineToken()}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Error al crear conversación DirectLine: ${response.statusText}`);
    }
    
    return await response.json() as DirectLineConversation;
  }

  /**
   * Obtener token de DirectLine
   */
  private async getDirectLineToken(): Promise<string> {
    const response = await fetch(
      `${config.powerPlatform.baseUrl}${config.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`
    );
    
    if (!response.ok) {
      throw new Error(`Error al obtener token DirectLine: ${response.statusText}`);
    }
    
    const data: any = await response.json();
    return data.token;
  }

  /**
   * Configurar conexión WebSocket para la conversación
   */
  private async setupWebSocketConnection(
    conversationId: string,
    token: string,
    phone_number_id: string,
    from: string
  ): Promise<WebSocket> {
    const wsConnection = new WebSocket(
      `wss://directline.botframework.com/v3/directline/conversations/${conversationId}/stream?watermark=-1`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    wsConnection.on('message', async (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.activities && message.activities.length > 0) {
          // Buscar respuesta del bot
          const botResponse = message.activities.find((a: DirectLineActivity) => 
            a.from?.role === 'bot' && 
            a.type === 'message' &&
            a.text
          );
          
          if (botResponse && botResponse.text) {
            // Verificar si es un mensaje de escalamiento
            if (this.isEscalationMessage(botResponse.text)) {
              await this.handleEscalation(from, phone_number_id, botResponse.text);
            } else if (!this.isEscalated(from)) {
              // Enviar respuesta normal si no está escalado
              await this.whatsappService.sendMessage(
                phone_number_id,
                from,
                botResponse.text
              );
            }
          }
        }
      } catch (error) {
        console.error('Error al procesar mensaje WebSocket:', error);
      }
    });

    wsConnection.on('error', (error) => {
      console.error(`Error en WebSocket para conversación ${conversationId}:`, error);
    });

    return wsConnection;
  }

  /**
   * Enviar mensaje a la conversación
   */
  public async sendMessage(from: string, phone_number_id: string, message: string): Promise<void> {
    // Verificar si la conversación está escalada
    if (this.isEscalated(from)) {
      // Si está escalada, guardar el mensaje en la cola para el agente
      this.queueService.addMessage(from, {
        from: MessageSender.USER,
        text: message
      });
      return;
    }
    
    // Obtener o crear conversación
    const conversation = await this.getOrCreateConversation(from, phone_number_id);
    
    // Actualizar tiempo de actividad
    conversation.lastActivity = Date.now();
    
    // Enviar mensaje al bot
    const response = await fetch(`${config.directline.url}/conversations/${conversation.conversationId}/activities`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${conversation.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'message',
        from: { id: from },
        text: message
      })
    });
    
    if (!response.ok) {
      throw new Error(`Error al enviar mensaje a DirectLine: ${response.statusText}`);
    }
  }

  /**
   * Verificar si un mensaje indica que se debe escalar la conversación
   */
  private isEscalationMessage(message: string): boolean {
    const lowerMessage = message.toLowerCase();
    return this.escalationPatterns.some(phrase => 
      lowerMessage.includes(phrase.toLowerCase())
    );
  }

  /**
   * Manejar el proceso de escalamiento
   */
  private async handleEscalation(from: string, phone_number_id: string, botMessage: string): Promise<void> {
    // Actualizar estado de la conversación
    this.updateConversationStatus(from, true);
    
    // Enviar mensaje de confirmación al usuario
    const escalationMsg = "Tu conversación ha sido transferida a un agente. Pronto te atenderán.";
    await this.whatsappService.sendMessage(phone_number_id, from, escalationMsg);
    
    // Añadir a la cola de agentes
    this.queueService.addToQueue({
      conversationId: from,
      from,
      phone_number_id,
      assignedAgent: null,
      metadata: {
        escalationReason: botMessage
      }
    });
    
    // Añadir el mensaje del bot a la conversación en cola
    this.queueService.addMessage(from, {
      from: MessageSender.BOT,
      text: botMessage
    });
  }

  /**
   * Verificar si una conversación está escalada
   */
  public isEscalated(from: string): boolean {
    const conversation = this.conversations.get(from);
    return conversation ? conversation.isEscalated : false;
  }

  /**
   * Actualizar estado de escalamiento de una conversación
   */
  public updateConversationStatus(from: string, isEscalated: boolean): void {
    const conversation = this.conversations.get(from);
    
    if (conversation) {
      conversation.isEscalated = isEscalated;
      conversation.status = isEscalated ? ConversationStatus.WAITING : ConversationStatus.BOT;
      conversation.lastActivity = Date.now();
    }
  }

  /**
   * Finalizar conversación con agente y volver al bot
   */
  public async completeAgentConversation(from: string): Promise<boolean> {
    const conversation = this.conversations.get(from);
    
    if (!conversation) {
      return false;
    }
    
    // Actualizar estado
    conversation.isEscalated = false;
    conversation.status = ConversationStatus.BOT;
    conversation.lastActivity = Date.now();
    
    // Eliminar de la cola de agentes
    const completed = this.queueService.completeConversation(from);
    
    // Enviar mensaje de finalización
    if (await completed) {
      await this.whatsappService.sendMessage(
        conversation.phone_number_id,
        from,
        "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?"
      );
    }
    
    return completed;
  }

  /**
   * Limpiar conversaciones inactivas
   */
  private cleanupInactiveConversations(): void {
    const INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
    
    for (const [from, conversation] of this.conversations.entries()) {
      if (Date.now() - conversation.lastActivity > INACTIVE_TIMEOUT) {
        // Cerrar WebSocket si existe
        if (conversation.wsConnection) {
          try {
            conversation.wsConnection.close();
          } catch (error) {
            console.error(`Error al cerrar WebSocket para ${from}:`, error);
          }
        }
        
        // Eliminar conversación
        this.conversations.delete(from);
        
        // Si estaba escalada, eliminar de la cola de agentes
        if (conversation.isEscalated) {
          this.queueService.completeConversation(from);
        }
        
        console.log(`Conversación inactiva eliminada: ${from}`);
      }
    }
  }
}

// Singleton
let conversationServiceInstance: ConversationService | null = null;

export function initConversationService(): ConversationService {
  if (!conversationServiceInstance) {
    conversationServiceInstance = new ConversationService();
  }
  return conversationServiceInstance;
}

export default initConversationService;