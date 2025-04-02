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
      
      // Get active conversations (not completed) - use prepared statement
      const dbConversations = db.prepare(
        `SELECT * FROM conversations WHERE status != ?`
      ).all(ConversationStatus.COMPLETED);
      
      if (dbConversations && dbConversations.length > 0) {
        for (const dbConv of dbConversations) {
          // Only load recent conversations (less than 24 hours)
          const lastActivity = dbConv.lastActivity;
          const now = Date.now();
          
          // If conversation is inactive for more than 24 hours, mark as completed
          if (now - lastActivity > 24 * 60 * 60 * 1000) {
            db.prepare(
              `UPDATE conversations SET status = ? WHERE conversationId = ?`
            ).run(ConversationStatus.COMPLETED, dbConv.conversationId);
            continue;
          }
          
          // Load active conversation into memory
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
        
        logger.info(`${this.conversations.size} active conversations loaded from database`);
      }
    } catch (error) {
      logger.error('Error loading conversations from database', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

/**
 * Obtener o crear una conversación para un usuario
 */
public async getOrCreateConversation(from: string, phone_number_id: string): Promise<ConversationData> {
  // Verificar si ya existe la conversación activa en memoria
  let conversation = this.conversations.get(from);
  
  // Si encontramos una conversación completada en memoria, eliminarla
  if (conversation && conversation.status === ConversationStatus.COMPLETED) {
    logger.info(`Conversación en memoria ${conversation.conversationId} para ${from} está completada, eliminando para crear una nueva`);
    this.conversations.delete(from);
    conversation = undefined;
  }
  
  // Si no está en memoria o fue eliminada por estar completada, verificar en la base de datos
  if (!conversation) {
    try {
      const db = await initDatabaseConnection();
      
      // Buscar SOLO conversaciones NO completadas para este número
      const dbConversation = db.prepare(
        `SELECT * FROM conversations 
         WHERE from_number = ? AND status != ? 
         ORDER BY lastActivity DESC LIMIT 1`
      ).get(from, ConversationStatus.COMPLETED);
      
      if (dbConversation) {
        logger.debug(`[CONV-VERIFICACION] Conversación activa encontrada en BD para ${from}:`, {
          id: dbConversation.conversationId,
          estado: dbConversation.status,
          lastActivity: new Date(dbConversation.lastActivity).toISOString(),
          isEscalated: dbConversation.isEscalated
        });
        
        // Cargar conversación no completada encontrada en BD
        conversation = {
          conversationId: dbConversation.conversationId,
          token: dbConversation.token,
          phone_number_id: dbConversation.phone_number_id,
          from: dbConversation.from_number,
          isEscalated: dbConversation.isEscalated === 1,
          lastActivity: dbConversation.lastActivity,
          status: dbConversation.status as ConversationStatus
        };
        
        // Configurar WebSocket para esta conversación restaurada
        conversation.wsConnection = await this.setupWebSocketConnection(
          conversation.conversationId,
          conversation.token,
          phone_number_id,
          from
        );
        
        this.conversations.set(from, conversation);
        logger.info(`Conversación restaurada desde BD: ${conversation.conversationId} para ${from} (estado: ${conversation.status})`);
      } else {
        logger.info(`No hay conversaciones activas en BD para ${from}, se creará una nueva`);
      }
    } catch (error) {
      logger.error(`Error al verificar conversación en BD para ${from}:`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Continuamos para crear una nueva conversación
    }
  }
  
  // VERIFICACIÓN DE INACTIVIDAD: Si está inactiva por más de 24 horas
  if (conversation && Date.now() - conversation.lastActivity > 24 * 60 * 60 * 1000) {
    logger.info(`Conversación ${conversation.conversationId} inactiva para ${from}, creando una nueva`);
    
    // Marcar la conversación antigua como completada en la base de datos
    try {
      const db = await initDatabaseConnection();
      db.prepare(
        `UPDATE conversations SET status = ? WHERE conversationId = ?`
      ).run(ConversationStatus.COMPLETED, conversation.conversationId);
    } catch (error) {
      logger.error(`Error al marcar conversación antigua como completada: ${from}`, { error });
      // Continuamos a pesar del error para crear una nueva
    }
    
    // Eliminar de la memoria para que se cree una nueva
    this.conversations.delete(from);
    conversation = undefined;
  }
  
  // CREAR NUEVA: Si llegamos aquí sin una conversación válida, crear una nueva
  if (!conversation) {
    logger.info(`Creando nueva conversación para ${from}`);
    
    try {
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
        db.prepare(
          `INSERT INTO conversations 
           (conversationId, token, phone_number_id, from_number, isEscalated, lastActivity, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          conversation.conversationId,
          conversation.token,
          conversation.phone_number_id,
          conversation.from,
          conversation.isEscalated ? 1 : 0,
          conversation.lastActivity,
          conversation.status
        );
        
        logger.info(`Nueva conversación creada y persistida: ${conversation.conversationId} para ${from}`);
      } catch (error) {
        logger.error(`Error al persistir nueva conversación: ${from}`, { error });
        // Continuamos a pesar del error para devolver la conversación ya creada
      }
    } catch (error) {
      logger.error(`Error crítico al crear nueva conversación para ${from}:`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error(`No se pudo crear una nueva conversación: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  if (!conversation) {
    throw new Error(`No se pudo obtener ni crear una conversación para ${from}`);
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

  // Set para rastrear IDs de mensajes ya procesados para esta conversación específica
  const processedMessageIds = new Set<string>();

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
        logger.debug(`Recibidas ${message.activities.length} actividades para ${from}`);
        
        // Filtrar solo los mensajes válidos del bot que no han sido procesados
        const botResponses = message.activities.filter((a: DirectLineActivity) => {
          return a.from?.role === 'bot' && 
                 a.type === 'message' &&
                 a.text &&
                 a.id &&
                 !processedMessageIds.has(a.id);
        });
        
        // Si no hay mensajes nuevos, salir
        if (botResponses.length === 0) {
          logger.debug(`No hay mensajes nuevos para procesar en este paquete`);
          return;
        }
        
        // Ordenar mensajes por timestamp
        const sortedMessages = [...botResponses].sort((a: DirectLineActivity, b: DirectLineActivity) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeA - timeB; // Ordenar de más antiguo a más reciente
        });
        
        logger.debug(`Procesando ${sortedMessages.length} mensajes ordenados por timestamp`);
        
        // Registrar los IDs para evitar procesamiento duplicado
        for (const message of sortedMessages) {
          if (message.id) {
            processedMessageIds.add(message.id);
          }
        }
        
        // Procesar mensajes ordenados
        for (let i = 0; i < sortedMessages.length; i++) {
          const botResponse = sortedMessages[i];
          
          logger.debug(`Procesando mensaje ${i+1}/${sortedMessages.length}: ${botResponse.id}`);
          
          if (botResponse.text) {
            // Verificar si es un mensaje de escalamiento
            if (this.isEscalationMessage(botResponse.text)) {
              await this.handleEscalation(from, phone_number_id, botResponse.text);
            } else if (!this.isEscalated(from)) {
              try {
                // Esperar un tiempo fijo antes de enviar cada mensaje (excepto el primero)
                if (i > 0) {
                  logger.debug(`Esperando 2 segundos antes de enviar mensaje ${i+1}`);
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                // Enviar mensaje a WhatsApp
                await this.whatsappService.sendMessage(
                  phone_number_id,
                  from,
                  botResponse.text
                );
                
                logger.debug(`Mensaje ${i+1} enviado exitosamente a WhatsApp`);
                
                // Guardar mensaje en base de datos
                const conversation = this.conversations.get(from);
                if (conversation) {
                  await this.saveMessage(conversation.conversationId, 'bot', botResponse.text);
                }
                
                // Pausa consistente después de cada mensaje
                logger.debug(`Pausa de 1 segundo después del mensaje ${i+1}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (error) {
                logger.error(`Error al enviar mensaje a WhatsApp: ${error}`);
              }
            }
          }
        }
        
        // Actualizar timestamp de la conversación
        this.updateConversationActivity(from);
      }
    } catch (error) {
      logger.error(`Error al procesar mensaje WebSocket: ${error}`);
    }
  });

  wsConnection.on('error', (error) => {
    logger.error(`Error en WebSocket para conversación ${conversationId}: ${error}`);
  });

  return wsConnection;
}

/**
 * Guardar mensaje en la base de datos con verificación de duplicados
 */
private async saveMessage(conversationId: string, from: string, text: string, agentId?: string): Promise<boolean> {
  if (!conversationId || !from || !text) {
    logger.error('Error al guardar mensaje: parámetros incompletos', {
      conversationId: conversationId || 'VACÍO',
      from: from || 'VACÍO',
      textLength: text ? text.length : 0
    });
    return false;
  }
  
  try {
    // Generar un messageId único
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = Date.now();
    
    const db = await initDatabaseConnection();
    
    // PASO 1: Verificar si ya existe un mensaje similar para evitar duplicados
    // Buscamos mensajes con el mismo texto, de la misma fuente, en la misma conversación
    // y en un rango de tiempo cercano (10 segundos)
    const timeWindow = 10000; // 10 segundos en milisegundos
    const minTime = timestamp - timeWindow;
    
    const existingMessage = db.prepare(`
      SELECT id FROM messages 
      WHERE conversationId = ? 
      AND from_type = ? 
      AND text = ? 
      AND timestamp > ?
    `).get(conversationId, from, text, minTime);
    
    // Si ya existe un mensaje similar reciente, no insertar duplicado
    if (existingMessage) {
      logger.warn(`Evitando insertar mensaje duplicado para conversación ${conversationId}`, {
        existingId: existingMessage.id,
        newId: messageId,
        text: text.substring(0, 30) + (text.length > 30 ? '...' : '')
      });
      return true; // Consideramos éxito si ya existe
    }
    
    // PASO 2: Verificar si la conversación existe
    const conversationExists = db.prepare(
      'SELECT conversationId FROM conversations WHERE conversationId = ?'
    ).get(conversationId);
    
    if (!conversationExists) {
      logger.error(`No se puede guardar mensaje: Conversación ${conversationId} no existe en BD`);
      return false;
    }
    
    // PASO 3: Insertar el nuevo mensaje
    db.prepare(
      `INSERT INTO messages (id, conversationId, from_type, text, timestamp, agentId)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(messageId, conversationId, from, text, timestamp, agentId || null);
    
    logger.debug(`Mensaje guardado en base de datos: ${messageId} para conversationId=${conversationId}`);
    return true;
  } catch (error) {
    logger.error(`Error al guardar mensaje en base de datos: ${conversationId}`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      from,
      textPreview: text.substring(0, 30) + (text.length > 30 ? '...' : '')
    });
    return false;
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
    
    // Actualizar en base de datos usando ID del sistema
    try {
      const db = await initDatabaseConnection();
      db.prepare(
        `UPDATE conversations SET lastActivity = ? WHERE conversationId = ?`
      ).run(conversation.lastActivity, conversation.conversationId);
    } catch (error) {
      logger.error(`Error al actualizar timestamp de actividad: ${from}`, { error });
    }
  }

/**
 * Enviar mensaje a la conversación
 */
public async sendMessage(from: string, phone_number_id: string, message: string): Promise<void> {
  try {
    // Verificar si existe conversación en memoria
    let conversation = this.conversations.get(from);
    
    // Si la conversación está completada, eliminarla para forzar la creación de una nueva
    if (conversation && conversation.status === ConversationStatus.COMPLETED) {
      logger.info(`Conversación en memoria ${conversation.conversationId} para ${from} está completada, eliminando para crear una nueva`);
      this.conversations.delete(from);
      conversation = undefined;
    }
    
    // Si no hay conversación en memoria, verificar en BD, solo buscando las no completadas
    if (!conversation) {
      try {
        const db = await initDatabaseConnection();
        const dbConversation = db.prepare(
          `SELECT * FROM conversations 
           WHERE from_number = ? AND status != ? 
           ORDER BY lastActivity DESC LIMIT 1`
        ).get(from, ConversationStatus.COMPLETED);
        
        if (dbConversation) {
          // Restaurar conversación activa si existe en BD
          logger.info(`Restaurando conversación activa desde BD para ${from}: ${dbConversation.conversationId} (${dbConversation.status})`);
          
          conversation = {
            conversationId: dbConversation.conversationId,
            token: dbConversation.token,
            phone_number_id: dbConversation.phone_number_id,
            from: dbConversation.from_number,
            isEscalated: dbConversation.isEscalated === 1,
            lastActivity: dbConversation.lastActivity,
            status: dbConversation.status as ConversationStatus
          };
          
          // Configurar WebSocket para esta conversación restaurada
          conversation.wsConnection = await this.setupWebSocketConnection(
            conversation.conversationId,
            conversation.token,
            phone_number_id,
            from
          );
          
          this.conversations.set(from, conversation);
        } else {
          logger.info(`No se encontraron conversaciones activas en BD para ${from}, se creará una nueva`);
        }
      } catch (error) {
        logger.error(`Error al verificar conversación en BD: ${from}`, { 
          error: error instanceof Error ? error.message : String(error) 
        });
        // Continuar el flujo para crear una nueva
      }
    }
    
    // Si tenemos una conversación escalada, enviar a la cola de agentes
    if (conversation && conversation.isEscalated) {
      logger.info(`Mensaje de ${from} enviado a conversación escalada ${conversation.conversationId}`);
      
      // Añadir a la cola para el agente
      await this.queueService.addMessage(conversation.conversationId, {
        from: MessageSender.USER,
        text: message
      });
      
      // Guardar mensaje en la base de datos
      await this.saveMessage(conversation.conversationId, 'user', message);
      
      // Actualizar timestamp de actividad
      conversation.lastActivity = Date.now();
      this.updateConversationActivity(from);
      
      return;
    }
    
    // Si llegamos aquí, necesitamos obtener o crear una conversación con el bot
    if (!conversation) {
      // Crear una nueva conversación con el bot
      conversation = await this.getOrCreateConversation(from, phone_number_id);
      logger.info(`Nueva conversación creada para ${from}: ${conversation.conversationId}`);
    }
    
    // Actualizar tiempo de actividad
    conversation.lastActivity = Date.now();
    this.updateConversationActivity(from);
    
    // Guardar mensaje en la base de datos
    await this.saveMessage(conversation.conversationId, 'user', message);
    
    // Enviar mensaje al bot
    logger.info(`Enviando mensaje al bot para ${from}`, {
      conversationId: conversation.conversationId
    });
    
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
      const errorText = await response.text();
      logger.error(`Error al enviar mensaje a DirectLine: ${response.status} ${response.statusText}`, {
        errorText,
        conversationId: conversation.conversationId
      });
      throw new Error(`Error al enviar mensaje a DirectLine: ${response.statusText}`);
    }
    
    logger.info(`Mensaje enviado exitosamente al bot para ${from}`, {
      conversationId: conversation.conversationId
    });
  } catch (error) {
    logger.error(`Error en sendMessage: ${from}`, { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined 
    });
    throw error; // Re-lanzar para manejo superior
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
  // Verificar si la conversación ya está escalada para evitar duplicación
  const existingConversation = this.conversations.get(from);
  if (existingConversation && existingConversation.isEscalated) {
    logger.debug(`Conversación ${from} ya está escalada, ignorando nueva solicitud`);
    return;
  }

  // Actualizar estado de la conversación
  await this.updateConversationStatus(from, true);
  
  // Obtener la conversación para usar su ID del sistema
  const conversation = this.conversations.get(from);
  if (!conversation) {
    logger.error(`No se encontró conversación para ${from} al intentar escalar`);
    return;
  }
  
  // Enviar mensaje de confirmación al usuario
  const escalationMsg = "Tu conversación ha sido transferida a un agente. Pronto te atenderán.";
  
  // CORRECCIÓN: Usar phone_number_id como emisor y from como destinatario
  await this.whatsappService.sendMessage(
    phone_number_id,  // ID del número de WhatsApp Business
    from,  // Número del usuario destinatario
    escalationMsg
  );
  
  // Guardar mensaje de sistema en la base de datos con ID del sistema
  await this.saveMessage(conversation.conversationId, 'system', escalationMsg);
  
  // Guardar mensaje del bot que provocó la escalación si no lo hicimos ya
  // Solo si es diferente al mensaje de confirmación
  if (botMessage !== escalationMsg) {
    const db = await initDatabaseConnection();
    
    // Verificar si ya guardamos este mensaje para evitar duplicados
    const existingBotMessage = db.prepare(
      'SELECT id FROM messages WHERE conversationId = ? AND from_type = ? AND text = ? LIMIT 1'
    ).get(conversation.conversationId, 'bot', botMessage);
    
    if (!existingBotMessage) {
      await this.saveMessage(conversation.conversationId, 'bot', botMessage);
    }
  }
  
  logger.info(`Conversación escalada correctamente: ${from}`);
  
  // Añadir a la cola de agentes - IMPORTANTE: NO AÑADIMOS LOS MENSAJES HISTÓRICOS AQUÍ
  // Solo añadimos la referencia a la conversación existente
  await this.queueService.addToQueue({
    conversationId: conversation.conversationId,
    from,
    phone_number_id,
    assignedAgent: null,
    metadata: {
      escalationReason: botMessage,
      customFields: {
        hasFullHistory: true
      }
    }
  });
  
  // No es necesario volver a añadir los mensajes históricos a la cola
  // Los agentes pueden recuperarlos directamente de la base de datos
  // cuando obtengan la conversación
  
  logger.info(`Conversación escalada a agente: ${from}`);
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
        db.prepare(
          `UPDATE conversations 
           SET isEscalated = ?, status = ?, lastActivity = ? 
           WHERE conversationId = ?`
        ).run(
          isEscalated ? 1 : 0,
          conversation.status,
          conversation.lastActivity,
          conversation.conversationId
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
public async completeAgentConversation(conversationId: string): Promise<boolean> {
  // Buscar conversación por ID o por número
  let conversation: ConversationData | undefined;
  let fromNumber: string | undefined;
  
  // Primero intentar buscar por conversationId directamente
  for (const [from, conv] of this.conversations.entries()) {
    if (conv.conversationId === conversationId) {
      conversation = conv;
      fromNumber = from;
      break;
    }
  }
  
  // Si no encontramos por conversationId, intentar buscar como si el conversationId fuera un número de teléfono
  if (!conversation && !fromNumber) {
    conversation = this.conversations.get(conversationId);
    if (conversation) {
      fromNumber = conversationId;
    }
  }
  
  // Si no encontramos por ninguno de los métodos anteriores, buscar directamente en la BD
  if (!conversation || !fromNumber) {
    try {
      const db = await initDatabaseConnection();
      const dbConversation = db.prepare(
        'SELECT * FROM conversations WHERE conversationId = ?'
      ).get(conversationId);
      
      if (dbConversation) {
        // Si la encontramos en BD, reconstruir objeto temporal
        conversation = {
          conversationId: dbConversation.conversationId,
          token: dbConversation.token,
          phone_number_id: dbConversation.phone_number_id,
          from: dbConversation.from_number,
          isEscalated: dbConversation.isEscalated === 1,
          lastActivity: dbConversation.lastActivity,
          status: dbConversation.status as ConversationStatus
        };
        fromNumber = dbConversation.from_number;
        
        logger.info(`Conversación ${conversationId} recuperada de BD para completar: fromNumber=${fromNumber}`);
      } else {
        logger.warn(`No se pudo encontrar la conversación ${conversationId} en BD`);
      }
    } catch (error) {
      logger.error(`Error al buscar conversación ${conversationId} en BD`, { error });
    }
  }
  
  // Si todavía no tenemos los datos necesarios, no podemos continuar
  if (!conversation || !fromNumber) {
    logger.warn(`No se puede completar la conversación ${conversationId}: datos insuficientes`);
    return false;
  }
  
  // Guardar info importante para envío de mensaje aunque se limpie de memoria
  const phoneNumberId = conversation.phone_number_id;
  const userPhoneNumber = conversation.from;
  const convId = conversation.conversationId;
  
  // Verificar que tenemos los datos mínimos para mensaje
  if (!phoneNumberId || !userPhoneNumber) {
    logger.error(`Datos incompletos para enviar mensaje de finalización: phoneNumberId=${phoneNumberId}, userNumber=${userPhoneNumber}`);
    return false;
  }
  
  try {
    // 1. PRIMER PASO: ENVIAR MENSAJE DE FINALIZACIÓN
    // Hacemos esto primero para asegurar que se envíe antes de cualquier cambio en BD
    const completionMessage = "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?";
    
    logger.info(`Intentando enviar mensaje de finalización a ${userPhoneNumber} vía ${phoneNumberId}`);
    
    try {
      // Usar nuestro servicio de WhatsApp directamente (no this.whatsappService)
      const whatsappService = new WhatsAppService();
      
      const messageSent = await whatsappService.sendMessage(
        phoneNumberId,
        userPhoneNumber,
        completionMessage
      );
      
      if (messageSent) {
        logger.info(`Mensaje de finalización enviado exitosamente a ${userPhoneNumber}`);
        
        // Intentar guardar mensaje en la base de datos
        try {
          await this.saveMessage(convId, 'system', completionMessage);
          logger.debug(`Mensaje de finalización guardado en BD para ${convId}`);
        } catch (saveError) {
          logger.warn(`No se pudo guardar mensaje de finalización en BD: ${convId}`, { error: saveError });
          // Continuar aunque falle el guardado
        }
      } else {
        logger.error(`Error al enviar mensaje de finalización a ${userPhoneNumber}`);
      }
    } catch (msgError) {
      logger.error(`Excepción al enviar mensaje de finalización a ${userPhoneNumber}`, { 
        error: msgError instanceof Error ? msgError.message : String(msgError)
      });
      // Continuar con el proceso a pesar del error
    }
    
    // 2. SEGUNDO PASO: ELIMINAR DE MEMORIA Y ACTUALIZAR BD
    // Inicializar queueService para acceder a los métodos
    const queueService = initQueueService();
    
    // Eliminar de la cola si estaba ahí
    await queueService.completeConversation(convId);
    
    // Marcar como completada en la base de datos
    try {
      const db = await initDatabaseConnection();
      
      // Verificar si ya está completada
      const currentStatus = db.prepare(
        'SELECT status FROM conversations WHERE conversationId = ?'
      ).get(convId);
      
      if (currentStatus && currentStatus.status === ConversationStatus.COMPLETED) {
        logger.info(`Conversación ${convId} ya estaba marcada como completada en BD`);
      } else {
        // Actualizar estado a completada
        db.prepare(
          'UPDATE conversations SET status = ?, isEscalated = 0, lastActivity = ? WHERE conversationId = ?'
        ).run(ConversationStatus.COMPLETED, Date.now(), convId);
        
        // Eliminar de la cola en BD por si acaso
        db.prepare('DELETE FROM queue WHERE conversationId = ?').run(convId);
        
        logger.info(`Conversación ${convId} marcada como completada en BD`);
      }
    } catch (dbError) {
      logger.error(`Error al actualizar estado en BD para ${convId}`, { error: dbError });
      // Continuar a pesar del error para limpiar memoria
    }
    
    // 3. TERCER PASO: LIMPIAR MEMORIA
    // Actualizar estado en memoria antes de eliminar
    if (conversation) {
      conversation.status = ConversationStatus.COMPLETED;
    }
    
    // Eliminar de memoria
    if (this.conversations.has(fromNumber)) {
      this.conversations.delete(fromNumber);
      logger.info(`Conversación eliminada de la memoria: ${fromNumber}`);
    }
    
    return true;
  } catch (error) {
    logger.error(`Error general al completar conversación ${conversationId}`, { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined 
    });
    
    // Intentar limpiar memoria aunque haya error
    if (fromNumber && this.conversations.has(fromNumber)) {
      this.conversations.delete(fromNumber);
      logger.info(`Conversación eliminada de la memoria a pesar del error: ${fromNumber}`);
    }
    
    return false;
  }
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
          await this.queueService.completeConversation(conversation.conversationId);
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
          await this.saveMessage(conversation.conversationId, 'system', timeoutMessage);
        } catch (error) {
          logger.error(`Error al enviar mensaje de cierre por inactividad: ${from}`, { error });
        }
        
        // Marcar como completada en la base de datos
        try {
          const db = await initDatabaseConnection();
          db.prepare(
            `UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?`
          ).run(ConversationStatus.COMPLETED, now, conversation.conversationId);
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