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
  // Verificar si ya existe la conversación activa
  let conversation = this.conversations.get(from);
  
  // VERIFICACIÓN ADICIONAL: Si no está en memoria, revisar en BD si hay una completada reciente
  if (!conversation) {
    try {
      const db = await initDatabaseConnection();
      const dbConversation = db.prepare(
        `SELECT * FROM conversations WHERE from_number = ? ORDER BY lastActivity DESC LIMIT 1`
      ).get(from);
      
      if (dbConversation) {
        // Si hay una conversación reciente en BD pero está completada, 
        // no la cargamos en memoria para forzar creación de una nueva
        if (dbConversation.status === ConversationStatus.COMPLETED) {
          logger.info(`Encontrada conversación completada en BD para ${from}, ignorando para crear nueva`);
          // Continuar flujo normal - dejamos conversation como undefined
        } 
        // Si está activa pero no está en memoria, la restauramos
        else if (dbConversation.status !== ConversationStatus.COMPLETED) {
          // Si además es reciente (menos de 24 horas)
          if (Date.now() - dbConversation.lastActivity <= 24 * 60 * 60 * 1000) {
            conversation = {
              conversationId: dbConversation.conversationId,
              token: dbConversation.token,
              phone_number_id: dbConversation.phone_number_id,
              from: dbConversation.from_number,
              isEscalated: dbConversation.isEscalated === 1,
              lastActivity: dbConversation.lastActivity,
              status: dbConversation.status as ConversationStatus
            };
            
            this.conversations.set(from, conversation);
            logger.info(`Restaurada conversación activa ${conversation.conversationId} para ${from} desde BD`);
          } else {
            // Está activa en BD pero inactiva por más de 24h, marcarla como completada
            logger.info(`Conversación ${dbConversation.conversationId} inactiva por >24h, marcando como completada`);
            db.prepare(
              `UPDATE conversations SET status = ? WHERE conversationId = ?`
            ).run(ConversationStatus.COMPLETED, dbConversation.conversationId);
            // Continuar flujo normal para crear una nueva
          }
        }
      }
    } catch (error) {
      logger.error(`Error al verificar conversación en BD para ${from}`, { error });
    }
  }
  
  // MANTENER verificación existente para conversaciones COMPLETED en memoria
  if (conversation && conversation.status === ConversationStatus.COMPLETED) {
    logger.info(`Conversación ${conversation.conversationId} para ${from} está completada, creando una nueva`);
    this.conversations.delete(from);
    conversation = undefined;
  }
  
  // MANTENER verificación existente para inactividad de 24 horas
  if (conversation && Date.now() - conversation.lastActivity > 24 * 60 * 60 * 1000) {
    logger.info(`Conversación inactiva para ${from}, creando una nueva`);
    
    // Marcar la conversación antigua como completada en la base de datos
    try {
      const db = await initDatabaseConnection();
      db.prepare(
        `UPDATE conversations SET status = ? WHERE from_number = ? AND status != ?`
      ).run(ConversationStatus.COMPLETED, from, ConversationStatus.COMPLETED);
    } catch (error) {
      logger.error(`Error al marcar conversación antigua como completada: ${from}`, { error });
    }
    
    // Eliminar de la memoria para que se cree una nueva
    this.conversations.delete(from);
    conversation = undefined;
  }
  
  // Resto del código sigue igual
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
      
      // Log del mensaje WebSocket raw
      logger.debug(`[WS-RAW] Mensaje WebSocket raw para ${conversationId} (${from}):`, {
        raw: dataStr.substring(0, 1000) + (dataStr.length > 1000 ? '... [truncado]' : ''),
        dataLength: dataStr.length,
        receivedAt: new Date().toISOString()
      });
      
      // Intentar parsear el JSON con manejo de errores
      let message;
      try {
        message = JSON.parse(dataStr);
      } catch (parseError) {
        console.error('Error al parsear mensaje WebSocket:', dataStr);
        return;
      }
        
      if (message.activities && message.activities.length > 0) {
        // Log de información sobre las actividades recibidas
        logger.debug(`[WS-INFO] ${message.activities.length} actividades recibidas para ${from}:`, {
          watermark: message.watermark,
          timestamp: new Date().toISOString()
        });

        // Mostrar detalles de cada actividad para debug
        message.activities.forEach((act: DirectLineActivity, idx: number) => {
          if (act.from?.role === 'bot' && act.type === 'message') {
            logger.debug(`[WS-ACTIVIDAD] Bot #${idx+1}:`, {
              id: act.id,
              tipo: act.type,
              timestamp: act.timestamp,
              fechaISO: act.timestamp ? new Date(act.timestamp).toISOString() : 'sin timestamp',
              timestampMs: act.timestamp ? new Date(act.timestamp).getTime() : 0,
              contenido: act.text ? (act.text.substring(0, 50) + (act.text.length > 50 ? '...' : '')) : 'sin texto'
            });
          }
        });
        
        // Filtrar solo los mensajes de texto del bot
        const botResponses = message.activities.filter((a: DirectLineActivity) => 
          a.from?.role === 'bot' && 
          a.type === 'message' &&
          a.text
        );
        
        // Log de mensajes sin ordenar
        logger.debug(`[WS-SIN-ORDENAR] ${botResponses.length} mensajes del bot para ${from}:`, 
          botResponses.map((m: DirectLineActivity, i: number) => ({
            posicionOriginal: i+1,
            id: m.id,
            timestamp: m.timestamp,
            timestampMs: m.timestamp ? new Date(m.timestamp).getTime() : 0,
            contenido: m.text ? (m.text.substring(0, 30) + (m.text.length > 30 ? '...' : '')) : 'sin texto'
          }))
        );
        
        // IMPORTANTE: Crear una copia explícita del array antes de ordenar
        // Ordenar explícitamente por timestamp (de más antiguo a más reciente)
        const sortedResponses = [...botResponses].sort((a: DirectLineActivity, b: DirectLineActivity) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          
          // Log detallado de la comparación para debug
          logger.debug(`[WS-COMPARACION] Comparando:`, {
            msgA: a.id,
            msgB: b.id,
            timeA,
            timeB,
            diferencia: timeA - timeB,
            resultado: timeA < timeB ? "A antes que B" : (timeA === timeB ? "Igual" : "B antes que A")
          });
          
          return timeA - timeB; // Orden ascendente (más antiguo primero)
        });
        
        // Log de mensajes después de ordenar
        logger.debug(`[WS-ORDENADOS] ${sortedResponses.length} mensajes ordenados para ${from}:`, 
          sortedResponses.map((m: DirectLineActivity, i: number) => ({
            posicionFinal: i+1,
            id: m.id,
            timestamp: m.timestamp,
            fechaISO: m.timestamp ? new Date(m.timestamp).toISOString() : 'sin timestamp',
            contenido: m.text ? (m.text.substring(0, 30) + (m.text.length > 30 ? '...' : '')) : 'sin texto'
          }))
        );
        
        // Procesar mensajes de forma estrictamente secuencial
        for (let i = 0; i < sortedResponses.length; i++) {
          const botResponse = sortedResponses[i];
          
          // Log de inicio de procesamiento de cada mensaje
          logger.debug(`[WS-PROCESANDO] Mensaje ${i+1}/${sortedResponses.length} para ${from}:`, {
            id: botResponse.id,
            timestamp: botResponse.timestamp,
            horaProcesoLocal: new Date().toISOString(),
            contenido: botResponse.text ? (botResponse.text.substring(0, 40) + (botResponse.text.length > 40 ? '...' : '')) : 'sin texto'
          });
          
          if (botResponse.text) {
            // Verificar si es un mensaje de escalamiento
            if (this.isEscalationMessage(botResponse.text)) {
              await this.handleEscalation(from, phone_number_id, botResponse.text);
            } else if (!this.isEscalated(from)) {
              // Enviar respuesta normal si no está escalado
              try {
                // Log justo antes de enviar a WhatsApp
                logger.debug(`[WS-ENVIANDO] Enviando mensaje ${i+1} a WhatsApp para ${from}:`, {
                  id: botResponse.id,
                  horaEnvioLocal: new Date().toISOString()
                });
                
                // Enviar el mensaje a WhatsApp y esperar a que termine
                await this.whatsappService.sendMessage(
                  phone_number_id,  // ID del número de WhatsApp Business
                  from,  // Número del usuario destinatario
                  botResponse.text
                );
                
                // Log después de enviar exitosamente
                logger.debug(`[WS-ENVIADO] Mensaje ${i+1} enviado exitosamente a WhatsApp para ${from}:`, {
                  id: botResponse.id,
                  horaFinalizacionLocal: new Date().toISOString()
                });
                
                // Guardar el mensaje del bot en la base de datos
                const conversation = this.conversations.get(from);
                if (conversation) {
                  await this.saveMessage(conversation.conversationId, 'bot', botResponse.text);
                } else {
                  logger.error(`No se encontró conversación para ${from} al guardar mensaje del bot`);
                }
                
                // IMPORTANTE: Esperar más tiempo entre mensajes (1 segundo)
                logger.debug(`[WS-PAUSA] Iniciando pausa de 1 segundo después del mensaje ${i+1} para ${from}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                logger.debug(`[WS-PAUSA-FIN] Pausa finalizada para el mensaje ${i+1}`);
              } catch (sendError) {
                logger.error(`[WS-ERROR] Error al enviar mensaje de bot a WhatsApp: ${from}`, { 
                  error: sendError, 
                  message: botResponse.text.substring(0, 100) 
                });
              }
            }
          }
          
          // Log de finalización del procesamiento de este mensaje
          logger.debug(`[WS-COMPLETADO] Mensaje ${i+1}/${sortedResponses.length} procesado completamente para ${from}`);
        }
        
        // Log de finalización de todos los mensajes
        logger.debug(`[WS-TODOS-COMPLETADOS] Todos los mensajes (${sortedResponses.length}) procesados para ${from}`);
        
        // Actualizar timestamp de actividad una vez al final del procesamiento
        this.updateConversationActivity(from);
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
 * Guardar mensaje en la base de datos con verificación de duplicados
 */
private async saveMessage(conversationId: string, from: string, text: string, agentId?: string): Promise<void> {
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
      return;
    }
    
    // PASO 2: Insertar el nuevo mensaje si no existe duplicado
    db.prepare(
      `INSERT INTO messages (id, conversationId, from_type, text, timestamp, agentId)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(messageId, conversationId, from, text, timestamp, agentId || null);
    
    logger.debug(`Mensaje guardado en base de datos: ${messageId} para conversationId=${conversationId}`);
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
    // Verificar si la conversación está escalada
    if (this.isEscalated(from)) {
      // Obtener conversación para su ID del sistema
      const conversation = this.conversations.get(from);
      if (!conversation) {
        logger.error(`No se encontró conversación para ${from} al enviar mensaje`);
        return;
      }
      
      // Si está escalada, guardar el mensaje en la cola para el agente usando ID del sistema
      this.queueService.addMessage(conversation.conversationId, {
        from: MessageSender.USER,
        text: message
      });
      
      // Guardar mensaje en la base de datos usando ID del sistema
      await this.saveMessage(conversation.conversationId, 'user', message);
      
      return;
    }
    
    // Obtener o crear conversación
    const conversation = await this.getOrCreateConversation(from, phone_number_id);
    
    // Actualizar tiempo de actividad
    conversation.lastActivity = Date.now();
    this.updateConversationActivity(from);
    
    // Guardar mensaje en la base de datos usando ID del sistema
    await this.saveMessage(conversation.conversationId, 'user', message);
    
      // AÑADIR EL LOG JUSTO AQUÍ 👇
    logger.info('DEBUG - Variables para DirectLine:', {
      directlineUrl: `${config.directline.url}/conversations/${conversation.conversationId}/activities`,
      powerPlatformBaseUrl: config.powerPlatform.baseUrl,
      botEndpoint: config.powerPlatform.botEndpoint,
      conversationId: conversation.conversationId,
      tokenLength: conversation.token.length,
      fromPrefix: from.substring(0, 5),
      environment: process.env.NODE_ENV
    });
  

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
  
  if (!conversation || !fromNumber) {
    logger.warn(`No se encontró conversación para completar: ${conversationId}`);
    return false;
  }
  
  try {
    // Inicializar queueService para acceder a los métodos
    const queueService = initQueueService();
    
    // Primero obtenemos información de la cola antes de eliminar
    const queueItem = queueService.getConversation(conversation.conversationId);
    const startTime = queueItem?.startTime || conversation.lastActivity;
    const priority = queueItem?.priority || 1;
    
    // Completamos la conversación (elimina de la cola)
    const completed = await queueService.completeConversation(conversation.conversationId);
    if (!completed) {
      logger.error(`Error al eliminar conversación ${conversationId} de la cola`);
      return false;
    }
    
    // Actualizar estado en la base de datos
    const db = await initDatabaseConnection();
    
    // Guardar información adicional para el historial (startTime y priority)
    const metadata = JSON.stringify({
      completedAt: Date.now(),
      originalStartTime: startTime,
      originalPriority: priority
    });
    
    // Usar una transacción para garantizar consistencia
    const transaction = db.transaction(() => {
      // Actualizar estado en la tabla de conversaciones 
      // Aquí incluimos la hora de inicio original y la prioridad en metadata
      db.prepare(
        `UPDATE conversations 
         SET isEscalated = 0, status = ?, lastActivity = ?, metadata = ? 
         WHERE conversationId = ?`
      ).run(ConversationStatus.COMPLETED, Date.now(), metadata, conversation.conversationId);
      
      // Asegurarse de que no queden registros en la tabla queue
      db.prepare('DELETE FROM queue WHERE conversationId = ?')
        .run(conversation.conversationId);
    });
    
    // Ejecutar la transacción
    transaction();
    
    // Enviar mensaje de finalización
    const completionMessage = "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?";
    
    await this.whatsappService.sendMessage(
      conversation.phone_number_id,
      conversation.from,
      completionMessage
    );
    
    // Guardar mensaje de sistema en la base de datos
    await this.saveMessage(conversation.conversationId, 'system', completionMessage);
    
    logger.info(`Conversación con agente finalizada: ${fromNumber}`);
    
    // IMPORTANTE: Eliminar conversación de la memoria para que futuros mensajes creen una nueva
    this.conversations.delete(fromNumber);
    logger.info(`Conversación eliminada de la memoria: ${fromNumber}`);
    
    return true;
  } catch (error) {
    logger.error(`Error al completar conversación ${conversationId}`, { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined 
    });
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