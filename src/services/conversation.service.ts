// src/services/conversation.service.ts
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { ConversationData, ConversationStatus } from '../models/conversation.model';
import { DirectLineConversation, DirectLineActivity } from '../models/directline.model';
import { WhatsAppService } from './whatsapp.service';
import { initQueueService } from './queue.service';
import { MessageSender } from '../models/message.model';
import config from '../config/app.config';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';

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
    
    // Cargar conversaciones activas desde la base de datos
    this.loadConversationsFromDB().catch(error => {
      logger.error('Error al cargar conversaciones desde la base de datos', { error });
    });
    
    // Iniciar limpieza periódica de conversaciones inactivas (cada hora)
    setInterval(() => this.cleanupInactiveConversations(), 60 * 60 * 1000);
  }

  /**
   * Cargar conversaciones activas desde la base de datos
   */
  private async loadConversationsFromDB(): Promise<void> {
    try {
      const db = await initDatabaseConnection();
      
      // Obtener conversaciones activas (no completadas)
      const dbConversations = await db.all(
        `SELECT * FROM conversations WHERE status != ?`, 
        [ConversationStatus.COMPLETED]
      );
      
      if (dbConversations && dbConversations.length > 0) {
        for (const dbConv of dbConversations) {
          // Solo cargar en memoria las conversaciones recientes (menos de 24 horas)
          const lastActivity = dbConv.lastActivity;
          const now = Date.now();
          
          // Si la conversación tiene más de 24 horas de inactividad, marcarla como completada
          if (now - lastActivity > 24 * 60 * 60 * 1000) {
            await db.run(
              `UPDATE conversations SET status = ? WHERE conversationId = ?`,
              [ConversationStatus.COMPLETED, dbConv.conversationId]
            );
            continue;
          }
          
          // Cargar conversación activa en memoria
          const conversation: ConversationData = {
            conversationId: dbConv.conversationId,
            token: dbConv.token,
            phone_number_id: dbConv.phone_number_id,
            from: dbConv.from_number,
            isEscalated: dbConv.isEscalated === 1,
            lastActivity: dbConv.lastActivity,
            status: dbConv.status as ConversationStatus
          };
          
          this.conversations.set(dbConv.from_number, conversation);
        }
        
        logger.info(`${this.conversations.size} conversaciones activas cargadas desde la base de datos`);
      }
    } catch (error) {
      logger.error('Error al cargar conversaciones desde la base de datos', { error });
    }
  }

  /**
   * Obtener o crear una conversación para un usuario
   */
  public async getOrCreateConversation(from: string, phone_number_id: string): Promise<ConversationData> {
    // Verificar si ya existe la conversación activa
    let conversation = this.conversations.get(from);
    
    // Si existe pero está inactiva por más de 24 horas, crear una nueva conversación
    if (conversation && Date.now() - conversation.lastActivity > 24 * 60 * 60 * 1000) {
      logger.info(`Conversación inactiva para ${from}, creando una nueva`);
      
      // Marcar la conversación antigua como completada en la base de datos
      try {
        const db = await initDatabaseConnection();
        await db.run(
          `UPDATE conversations SET status = ? WHERE from_number = ? AND status != ?`,
          [ConversationStatus.COMPLETED, from, ConversationStatus.COMPLETED]
        );
      } catch (error) {
        logger.error(`Error al marcar conversación antigua como completada: ${from}`, { error });
      }
      
      // Eliminar de la memoria para que se cree una nueva
      this.conversations.delete(from);
      conversation = undefined;
    }
    
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
      
      // Persistir en la base de datos
      try {
        const db = await initDatabaseConnection();
        await db.run(
          `INSERT INTO conversations 
           (conversationId, token, phone_number_id, from_number, isEscalated, lastActivity, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            conversation.conversationId,
            conversation.token,
            conversation.phone_number_id,
            conversation.from,
            conversation.isEscalated ? 1 : 0,
            conversation.lastActivity,
            conversation.status
          ]
        );
        
        logger.info(`Nueva conversación creada y persistida para ${from}`);
      } catch (error) {
        logger.error(`Error al persistir nueva conversación: ${from}`, { error });
      }
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
        
    const dataStr = data.toString();
    if (!dataStr || dataStr.trim() === '') {
      console.log('Mensaje WebSocket vacío recibido, ignorando');
      return;
    }
    
    // Intentar parsear el JSON con manejo de errores
    let message;
    try {
      message = JSON.parse(dataStr);
    } catch (parseError) {
      console.error('Error al parsear mensaje WebSocket:', dataStr);
      return;
    }
        
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
              
              // Guardar el mensaje del bot en la base de datos
              this.saveMessage(from, 'bot', botResponse.text);
            }
            
            // Actualizar timestamp de actividad
            this.updateConversationActivity(from);
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
   * Guardar mensaje en la base de datos
   */
  private async saveMessage(conversationId: string, from: string, text: string, agentId?: string): Promise<void> {
    try {
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const timestamp = Date.now();
      
      const db = await initDatabaseConnection();
      await db.run(
        `INSERT INTO messages (id, conversationId, from_type, text, timestamp, agentId)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [messageId, conversationId, from, text, timestamp, agentId || null]
      );
      
      logger.debug(`Mensaje guardado en base de datos: ${messageId}`);
    } catch (error) {
      logger.error(`Error al guardar mensaje en base de datos: ${conversationId}`, { error });
    }
  }

  /**
   * Actualizar timestamp de actividad de una conversación
   */
  private async updateConversationActivity(from: string): Promise<void> {
    const conversation = this.conversations.get(from);
    if (!conversation) return;
    
    // Actualizar en memoria
    conversation.lastActivity = Date.now();
    
    // Actualizar en base de datos
    try {
      const db = await initDatabaseConnection();
      await db.run(
        `UPDATE conversations SET lastActivity = ? WHERE conversationId = ?`,
        [conversation.lastActivity, conversation.conversationId]
      );
    } catch (error) {
      logger.error(`Error al actualizar timestamp de actividad: ${from}`, { error });
    }
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
      
      // Guardar mensaje en la base de datos
      await this.saveMessage(from, 'user', message);
      
      return;
    }
    
    // Obtener o crear conversación
    const conversation = await this.getOrCreateConversation(from, phone_number_id);
    
    // Actualizar tiempo de actividad
    conversation.lastActivity = Date.now();
    this.updateConversationActivity(from);
    
    // Guardar mensaje en la base de datos
    await this.saveMessage(from, 'user', message);
    
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
    
    // Guardar mensaje de sistema en la base de datos
    await this.saveMessage(from, 'system', escalationMsg);
    
    // IMPORTANTE: Obtener todo el historial de mensajes de la conversación
    let messageHistory: any[] = [];
    try {
      const db = await initDatabaseConnection();
      messageHistory = await db.all(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC',
        [from]
      );
      
      console.log(`Recuperados ${messageHistory.length} mensajes históricos para la conversación ${from}`);
    } catch (dbError) {
      console.error('Error al recuperar historial de mensajes:', dbError);
    }

    // Añadir a la cola de agentes
    this.queueService.addToQueue({
      conversationId: from,
      from,
      phone_number_id,
      assignedAgent: null,
      metadata: {
        escalationReason: botMessage,
        customFields: {
          hasFullHistory: true   // Usar customFields para propiedades personalizadas
        }
      }
    });
    
    // Añadir todos los mensajes históricos a la conversación en cola
  if (messageHistory.length > 0) {
    for (const msg of messageHistory) {
        // Crear un nuevo objeto de mensaje sin ID para evitar errores de tipo
        await this.queueService.addMessage(from, {
          from: msg.from_type as MessageSender,
          text: msg.text,
          agentId: msg.agentId || undefined
        });
    }
  }
  
  // Añadir el mensaje de escalación del bot si no está ya en el historial
  if (!messageHistory.some(m => m.text === botMessage && m.from_type === 'bot')) {
    await this.queueService.addMessage(from, {
      from: MessageSender.BOT,
      text: botMessage
    });
  }
  
  logger.info(`Conversación escalada a agente: ${from} con ${messageHistory.length} mensajes históricos`);

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
  public async updateConversationStatus(from: string, isEscalated: boolean): Promise<void> {
    const conversation = this.conversations.get(from);
    
    if (conversation) {
      // Actualizar en memoria
      conversation.isEscalated = isEscalated;
      conversation.status = isEscalated ? ConversationStatus.WAITING : ConversationStatus.BOT;
      conversation.lastActivity = Date.now();
      
      // Actualizar en base de datos
      try {
        const db = await initDatabaseConnection();
        await db.run(
          `UPDATE conversations 
           SET isEscalated = ?, status = ?, lastActivity = ? 
           WHERE conversationId = ?`,
          [
            isEscalated ? 1 : 0,
            conversation.status,
            conversation.lastActivity,
            conversation.conversationId
          ]
        );
        
        logger.info(`Estado de conversación actualizado: ${from}, escalada: ${isEscalated}`);
      } catch (error) {
        logger.error(`Error al actualizar estado de conversación: ${from}`, { error });
      }
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
    conversation.status = ConversationStatus.COMPLETED;
    conversation.lastActivity = Date.now();
    
    // Actualizar en base de datos
    try {
      const db = await initDatabaseConnection();
      await db.run(
        `UPDATE conversations 
         SET isEscalated = 0, status = ?, lastActivity = ? 
         WHERE conversationId = ?`,
        [conversation.status, conversation.lastActivity, conversation.conversationId]
      );
    } catch (error) {
      logger.error(`Error al actualizar estado de conversación completada: ${from}`, { error });
    }
    
    // Eliminar de la cola de agentes
    const completed = await this.queueService.completeConversation(from);
    
    // Enviar mensaje de finalización
    if (completed) {
      const completionMessage = "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?";
      
      await this.whatsappService.sendMessage(
        conversation.phone_number_id,
        from,
        completionMessage
      );
      
      // Guardar mensaje de sistema en la base de datos
      await this.saveMessage(from, 'system', completionMessage);
      
      logger.info(`Conversación con agente finalizada: ${from}`);
    }
    
    return completed;
  }

  /**
   * Limpiar conversaciones inactivas (24 horas)
   */
  private async cleanupInactiveConversations(): Promise<void> {
    const INACTIVE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas en milisegundos
    const now = Date.now();
    
    for (const [from, conversation] of this.conversations.entries()) {
      if (now - conversation.lastActivity > INACTIVE_TIMEOUT) {
        logger.info(`Cerrando conversación inactiva (24h): ${from}`);
        
        // Cerrar WebSocket si existe
        if (conversation.wsConnection) {
          try {
            conversation.wsConnection.close();
          } catch (error) {
            logger.error(`Error al cerrar WebSocket para ${from}:`, { error });
          }
        }
        
        // Si estaba escalada, completar en la cola de agentes
        if (conversation.isEscalated) {
          await this.queueService.completeConversation(from);
        }
        
        // Enviar mensaje al usuario sobre cierre por inactividad
        try {
          const timeoutMessage = "Tu conversación ha sido cerrada automáticamente debido a inactividad (24 horas). Si necesitas ayuda nuevamente, envía un nuevo mensaje.";
          
          await this.whatsappService.sendMessage(
            conversation.phone_number_id,
            from,
            timeoutMessage
          );
          
          // Guardar mensaje de sistema en la base de datos
          await this.saveMessage(from, 'system', timeoutMessage);
        } catch (error) {
          logger.error(`Error al enviar mensaje de cierre por inactividad: ${from}`, { error });
        }
        
        // Marcar como completada en la base de datos
        try {
          const db = await initDatabaseConnection();
          await db.run(
            `UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?`,
            [ConversationStatus.COMPLETED, now, conversation.conversationId]
          );
        } catch (error) {
          logger.error(`Error al marcar conversación como completada: ${from}`, { error });
        }
        
        // Eliminar de la memoria
        this.conversations.delete(from);
      }
    }
    
    logger.info('Limpieza de conversaciones inactivas completada');
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