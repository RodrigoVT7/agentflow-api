// src/services/queue.service.ts
import { EventEmitter } from 'events';
import { QueueItem } from '../models/queue.model';
import { Message, MessageSender } from '../models/message.model';
import { ConversationStatus } from '../models/conversation.model';
import { WebSocketService } from '../websocket/server';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';
import { WhatsAppService } from './whatsapp.service';
import { initConversationService } from './conversation.service';
import config from '../config/app.config';

interface ConversationTimerInfo {
  timerId: NodeJS.Timeout;
  lastUserMessageTimestamp: number;
  waitingMessagesSent: number;
}


class QueueService {
  private agentQueues: Map<string, QueueItem>;
  private events: EventEmitter;
  private webSocketService?: WebSocketService;
 // Nuevas propiedades para temporizadores
 private conversationTimers: Map<string, ConversationTimerInfo> = new Map();
 private whatsappService: WhatsAppService;

  constructor() {
    this.agentQueues = new Map<string, QueueItem>();
    this.events = new EventEmitter();

    // Inicializar WhatsAppService para enviar mensajes automáticos
    this.whatsappService = new WhatsAppService();

    
    // Cargar estado inicial desde SQLite
    this.loadInitialState();
  }

  /**
   * Cargar estado inicial de la cola desde SQLite
   */
  private async loadInitialState(): Promise<void> {
    try {
      const db = await initDatabaseConnection();
      
      // Get conversations in queue - use prepared statement
      const queueItems = db.prepare('SELECT * FROM queue').all();
      
      if (queueItems && queueItems.length > 0) {
        // Clear current map
        this.agentQueues.clear();
        
        for (const item of queueItems) {
          // Load messages associated with this conversation - use prepared statement
          const messages = db.prepare(
            'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC'
          ).all(item.conversationId);
          
          // Convert JSON strings to objects
          const tags = item.tags ? JSON.parse(item.tags) : [];
          const metadata = item.metadata ? JSON.parse(item.metadata) : {};
          
          // Create queue item in memory
          const queueItem: QueueItem = {
            conversationId: item.conversationId,
            from: item.from_number,
            phone_number_id: item.phone_number_id,
            startTime: item.startTime,
            priority: item.priority,
            tags: tags,
            assignedAgent: item.assignedAgent || null,
            messages: messages.map((msg: any) => ({
              id: msg.id,
              conversationId: msg.conversationId,
              from: msg.from_type as MessageSender,
              text: msg.text,
              timestamp: msg.timestamp,
              agentId: msg.agentId || undefined,
              attachmentUrl: msg.attachmentUrl || undefined,
              metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined
            })),
            metadata: metadata
          };
          
          this.agentQueues.set(item.conversationId, queueItem);
        }
        
        logger.info(`Loaded ${queueItems.length} conversations in queue from SQLite`);
      }
    } catch (error) {
      logger.error('Error loading initial queue state from SQLite', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

/**
 * Añadir una conversación a la cola de espera
 */
public async addToQueue(queueItem: Omit<QueueItem, 'startTime' | 'messages' | 'priority' | 'tags'>): Promise<QueueItem> {
  try {
    // Verificar si ya existe en la cola para evitar duplicados
    const existingItem = this.agentQueues.get(queueItem.conversationId);
    if (existingItem) {
      logger.warn(`Conversación ${queueItem.conversationId} ya existe en la cola, actualizando metadata`);
      
      // Actualizar metadata si es necesario
      if (queueItem.metadata) {
        existingItem.metadata = {
          ...existingItem.metadata,
          ...queueItem.metadata
        };
        
        // Actualizar en BD
        await this.updateMetadata(queueItem.conversationId, existingItem.metadata);
      }
      
      return existingItem;
    }
    
    // Si no existe, crear nueva entrada
    const newQueueItem: QueueItem = {
      ...queueItem,
      startTime: Date.now(),
      messages: [], // Inicialmente vacío, se cargarán bajo demanda
      priority: 1,  // Prioridad normal por defecto
      tags: [],
      metadata: queueItem.metadata || {}
    };
    
    // Guardar en memoria
    this.agentQueues.set(queueItem.conversationId, newQueueItem);
    
    // Verificar si ya existe en base de datos
    const db = await initDatabaseConnection();
    const existingQueueEntry = db.prepare(
      'SELECT conversationId FROM queue WHERE conversationId = ?'
    ).get(queueItem.conversationId);
    
    if (existingQueueEntry) {
      logger.warn(`Conversación ${queueItem.conversationId} ya existe en BD, actualizando`);
      
      // Actualizar la entrada existente
      const tagsJson = JSON.stringify(newQueueItem.tags);
      const metadataJson = JSON.stringify(newQueueItem.metadata);
      
      db.prepare(`
        UPDATE queue 
        SET startTime = ?, priority = ?, tags = ?, assignedAgent = ?, metadata = ? 
        WHERE conversationId = ?
      `).run(
        newQueueItem.startTime,
        newQueueItem.priority,
        tagsJson,
        newQueueItem.assignedAgent,
        metadataJson,
        queueItem.conversationId
      );
    } else {
      // Insertar nueva entrada
      const tagsJson = JSON.stringify(newQueueItem.tags);
      const metadataJson = JSON.stringify(newQueueItem.metadata);
      
      db.prepare(`
        INSERT INTO queue
        (conversationId, from_number, phone_number_id, startTime, priority, tags, assignedAgent, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newQueueItem.conversationId,
        newQueueItem.from,
        newQueueItem.phone_number_id,
        newQueueItem.startTime,
        newQueueItem.priority,
        tagsJson,
        newQueueItem.assignedAgent,
        metadataJson
      );
    }
    
    // Notificar a los agentes disponibles
    this.notifyQueueUpdated();
    
    logger.info(`Conversación ${queueItem.conversationId} añadida a la cola`);
    
    // Cargar mensajes existentes para esta conversación
    this.loadMessagesForQueueItem(newQueueItem);
    
    // NUEVO: Iniciar temporizador de espera en cola si no hay agente asignado
    if (!newQueueItem.assignedAgent) {
      logger.info(`Iniciando temporizador de espera en cola para ${newQueueItem.conversationId}`);
      this.startQueueWaitTimer(newQueueItem.conversationId, newQueueItem.startTime);
    }
    
    return newQueueItem;
  } catch (error) {
    logger.error(`Error al añadir a la cola: ${queueItem.conversationId}`, { error });
    throw error;
  }
}

/**
 * Cargar mensajes existentes para un elemento de la cola
 * (Esta función evita duplicaciones al cargar mensajes)
 */
private async loadMessagesForQueueItem(queueItem: QueueItem): Promise<void> {
  try {
    // Solo cargar mensajes si están vacíos
    if (queueItem.messages.length === 0) {
      const messages = await this.getMessages(queueItem.conversationId);
      queueItem.messages = messages;
      logger.debug(`Cargados ${messages.length} mensajes para ${queueItem.conversationId}`);
    }
  } catch (error) {
    logger.error(`Error al cargar mensajes para ${queueItem.conversationId}`, { error });
  }
}

  /**
   * Asignar un agente a una conversación
   */
  public async assignAgent(conversationId: string, agentId: string): Promise<boolean> {
    const queueItem = this.agentQueues.get(conversationId);
    
    if (!queueItem) {
      logger.warn(`Intento de asignar agente a conversación inexistente: ${conversationId}`);
      return false;
    }
    
    // Si ya está asignado a este mismo agente, no hacer nada para evitar duplicados
    if (queueItem.assignedAgent === agentId) {
      logger.debug(`Agente ${agentId} ya está asignado a conversación ${conversationId}, evitando mensaje duplicado`);
      return true;
    }
    
    // Si ya está asignado a otro agente, no permitir reasignación
    if (queueItem.assignedAgent && queueItem.assignedAgent !== agentId) {
      logger.warn(`Conversación ${conversationId} ya asignada a ${queueItem.assignedAgent}, intento de asignación a ${agentId}`);
      return false;
    }
    
    // Actualizar en memoria
    queueItem.assignedAgent = agentId;
    
    try {
      // Actualizar en SQLite
      const db = await initDatabaseConnection();
      
      db.prepare(
        'UPDATE queue SET assignedAgent = ? WHERE conversationId = ?'
      ).run(agentId, conversationId);
      
      // Actualizar estado de la conversación
      // Actualizar estado de la conversación
db.prepare(
  'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?'
).run(ConversationStatus.AGENT, Date.now(), conversationId);

  // --- Lógica de Temporizador ---
     // 1. Limpiar cualquier temporizador de espera en cola existente
     this.clearConversationTimer(conversationId);
    
     // 2. Verificar si el último mensaje fue del usuario para iniciar temporizador de respuesta
     const messages = queueItem.messages;
     if (messages && messages.length > 0) {
       // Ordenar mensajes por timestamp (más reciente primero)
       const sortedMessages = [...messages].sort((a, b) => b.timestamp - a.timestamp);
       const lastMessage = sortedMessages[0];
       
       if (lastMessage && lastMessage.from === 'user') {
         // Iniciar temporizador de respuesta de agente para este mensaje específico
         logger.info(`Usuario esperando respuesta en ${conversationId}, iniciando temporizador para agente asignado ${agentId}`);
         this.startAgentResponseTimer(conversationId, lastMessage.timestamp);
       }
     }
     
      // --- Fin Lógica de Temporizador ---

      // Añadir mensaje de sistema
      await this.addSystemMessage(conversationId, `Agente ${agentId} se ha unido a la conversación`);
      
      // Notificar actualización
      this.notifyQueueUpdated();
      this.notifyConversationUpdated(conversationId);
      
      logger.info(`Conversación ${conversationId} asignada al agente ${agentId}`);
      return true;
    } catch (error) {
      logger.error(`Error al asignar agente ${agentId} a conversación ${conversationId}`, { error });
      return false;
    }
  }

/**
 * Finalizar una conversación y eliminarla de la cola
 */
public async completeConversation(conversationId: string): Promise<boolean> {
  
      // --- Lógica de Temporizador ---
      this.clearConversationTimer(conversationId); // Limpiar temporizador al completar
      // --- Fin Lógica de Temporizador ---
  
  
  // Obtener la conversación si existe en memoria
  const conversation = this.agentQueues.get(conversationId);
  
  // Flag para rastrear si estaba en memoria
  let wasInMemory = false;
  
  // Eliminar de la memoria si existe
  if (this.agentQueues.has(conversationId)) {
    this.agentQueues.delete(conversationId);
    wasInMemory = true;
    logger.info(`Conversación ${conversationId} eliminada de la cola en memoria`);
  } else {
    logger.debug(`Conversación ${conversationId} no encontrada en la cola en memoria`);
  }
  
  try {
    const db = await initDatabaseConnection();
    
    // Verificar si la conversación existe en la base de datos
    const existsInDB = db.prepare(
      'SELECT conversationId, status FROM conversations WHERE conversationId = ?'
    ).get(conversationId);
    
    if (!existsInDB) {
      logger.warn(`Conversación ${conversationId} no encontrada en la base de datos`);
      return wasInMemory; // Retornamos true si al menos la quitamos de memoria
    }
    
    // Verificar si ya está completada
    if (existsInDB.status === 'completed') {
      logger.info(`Conversación ${conversationId} ya estaba marcada como completada en la base de datos`);
      // Eliminar de la cola si todavía existe un registro
      db.prepare('DELETE FROM queue WHERE conversationId = ?').run(conversationId);
      return true;
    }
    
    // Actualizar estado en la base de datos usando sentencias individuales
    // evitando transacciones para reducir posibilidad de errores
    
    // 1. Actualizar estado en conversaciones
    db.prepare(
      'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?'
    ).run('completed', Date.now(), conversationId);
    
    // 2. Eliminar de la cola
    db.prepare('DELETE FROM queue WHERE conversationId = ?').run(conversationId);
    
    logger.info(`Conversación ${conversationId} marcada como completada en la base de datos`);
    
    // Notificar actualización solo si había una conversación en memoria
    if (wasInMemory) {
      this.notifyQueueUpdated();
      
      // Emitir evento de conversación completada con datos básicos
      this.events.emit('conversation:completed', {
        conversationId,
        endTime: Date.now()
      });
    }
    
    return true;
  } catch (error) {
    logger.error(`Error al completar conversación ${conversationId}`, { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined 
    });
    
    return wasInMemory; // Retornamos true si al menos la quitamos de memoria
  }
}

/**
 * Añadir un mensaje a una conversación con recuperación mejorada
 */
public async addMessage(conversationId: string, message: Omit<Message, 'id' | 'conversationId' | 'timestamp'>): Promise<Message | null> {
  // Verificar si es un número de teléfono o un conversationId real
  let queueItem = this.agentQueues.get(conversationId);

  // Si no encontramos la conversación, verificar si conversationId es un número de teléfono
  if (!queueItem) {
    // Buscar conversación por número en nuestras conversaciones
    for (const item of this.agentQueues.values()) {
      if (item.from === conversationId) {
        queueItem = item;
        logger.warn(`Intento de usar número (${conversationId}) como conversationId, usando ID correcto: ${queueItem.conversationId}`);
        // Usar el conversationId correcto
        conversationId = queueItem.conversationId;
        break;
      }
    }
  }

  // --- INICIO MODIFICACIÓN: RECUPERAR CONVERSACIÓN FALTANTE ---
  // Si aún no tenemos queueItem, intentar recuperarlo de la base de datos
  if (!queueItem) {
    logger.warn(`Conversación ${conversationId} no encontrada en memoria de QueueService. Intentando recuperar...`);
    try {
      const db = await initDatabaseConnection();
      
      // Primero, verificar si la conversación existe en la tabla conversations
      const dbConversation = db.prepare(
        `SELECT conversationId, from_number, phone_number_id, isEscalated, status, lastActivity
         FROM conversations
         WHERE conversationId = ? AND (status = ? OR status = ?)`
      ).get(conversationId, ConversationStatus.WAITING, ConversationStatus.AGENT);

      if (dbConversation) {
        logger.info(`Conversación ${conversationId} recuperada de BD para añadir a la cola en memoria.`);
        
        // Buscar si está en la tabla queue también
        const queueEntry = db.prepare('SELECT * FROM queue WHERE conversationId = ?').get(conversationId);
        
        // Valores iniciales para reconstrucción
        let startTime = dbConversation.lastActivity - (30 * 60 * 1000); // 30 minutos antes como fallback
        let priority = 1;
        let tags: string[] = [];
        let assignedAgent: string | null = null;
        let metadata = { 
          escalationReason: 'Recuperada de BD después de mensaje perdido',
          customFields: { 
            reconstructionReason: 'Recuperada de BD después de mensaje perdido' 
          },
          hasFullHistory: true
        };
        
        // Si existe en la tabla queue, usar esos valores
        if (queueEntry) {
          logger.debug(`Datos de cola encontrados para ${conversationId}`);
          startTime = queueEntry.startTime;
          priority = queueEntry.priority;
          tags = queueEntry.tags ? JSON.parse(queueEntry.tags) : [];
          assignedAgent = queueEntry.assignedAgent || null;
          // Mezclar el metadata existente con nuestros campos nuevos
          if (queueEntry.metadata) {
            try {
              const existingMetadata = JSON.parse(queueEntry.metadata);
              metadata = {
                ...existingMetadata,
                customFields: {
                  ...(existingMetadata.customFields || {}),
                  reconstructionReason: 'Recuperada de BD después de mensaje perdido'
                }
              };
            } catch (jsonError) {
              logger.warn(`Error al parsear metadata de cola para ${conversationId}`, { error: jsonError });
              // Mantener el metadata predeterminado si hay error
            }
          }
        } else {
          logger.warn(`Conversación ${conversationId} no existe en tabla 'queue', reconstruyendo con valores predeterminados`);
          
          // Si no existe en queue, intentar insertar para mantener consistencia
          try {
            db.prepare(`
              INSERT INTO queue
              (conversationId, from_number, phone_number_id, startTime, priority, tags, assignedAgent, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              conversationId,
              dbConversation.from_number,
              dbConversation.phone_number_id,
              startTime,
              priority,
              JSON.stringify(tags),
              assignedAgent,
              JSON.stringify(metadata)
            );
            logger.info(`Conversación ${conversationId} añadida a tabla queue para consistencia`);
          } catch (insertError) {
            logger.error(`Error al insertar conversación en tabla queue: ${conversationId}`, { error: insertError });
            // Continuar aunque falle la inserción
          }
        }
        
        // Reconstruir objeto QueueItem
        const reconstructedQueueItem: QueueItem = {
          conversationId: dbConversation.conversationId,
          from: dbConversation.from_number,
          phone_number_id: dbConversation.phone_number_id,
          startTime: startTime,
          priority: priority,
          tags: tags,
          assignedAgent: assignedAgent,
          messages: [], // Se cargarán bajo demanda después
          metadata: metadata
        };
        
        // Cargar mensajes existentes para esta conversación
        try {
          const messages = await this.getMessages(conversationId);
          reconstructedQueueItem.messages = messages;
          logger.debug(`Cargados ${messages.length} mensajes para conversación recuperada ${conversationId}`);
        } catch (msgError) {
          logger.warn(`Error al cargar mensajes para conversación recuperada ${conversationId}`, { error: msgError });
          // Continuar con mensajes vacíos si falla la carga
        }
        
        // Añadir a la memoria
        this.agentQueues.set(conversationId, reconstructedQueueItem);
        queueItem = reconstructedQueueItem;
        
        // Notificar a los agentes que la cola ha sido actualizada
        this.notifyQueueUpdated();
        
        logger.info(`Conversación ${conversationId} reconstruida en memoria y añadida a la cola`);
      } else {
        logger.error(`No se pudo recuperar la conversación ${conversationId} de la BD o no está en estado WAITING/AGENT`);
        return null;
      }
    } catch (fetchError) {
      logger.error(`Error al intentar recuperar conversación ${conversationId} de BD`, { 
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        stack: fetchError instanceof Error ? fetchError.stack : undefined 
      });
      return null;
    }
  }
  // --- FIN MODIFICACIÓN ---

  if (!queueItem) {
    logger.warn(`Intento de añadir mensaje a conversación inexistente o no recuperable: ${conversationId}`);
    return null;
  }

  // Crear un nuevo ID para el mensaje
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const newMessage: Message = {
    id: messageId,
    conversationId,
    ...message,
    timestamp: Date.now()
  };
  
  // Añadir a memoria
  queueItem.messages.push(newMessage);

      // --- Lógica de Temporizador ---
      if (queueItem.assignedAgent) { // Solo gestionar temporizadores si hay un agente asignado
        if (message.from === 'user') {
          // Usuario envió un mensaje, iniciar el temporizador para respuesta del agente
          this.startAgentResponseTimer(conversationId, newMessage.timestamp);
        } else if (message.from === 'agent' && message.agentId === queueItem.assignedAgent) {
          // Agente respondió, limpiar el temporizador
          this.clearConversationTimer(conversationId);
        }
      }
      // --- Fin Lógica de Temporizador ---

  
  try {
    // Guardar en SQLite
    const db = await initDatabaseConnection();
    
    // Convertir metadata a JSON si existe
    const metadataJson = newMessage.metadata ? JSON.stringify(newMessage.metadata) : null;
    
    db.prepare(
      `INSERT INTO messages
       (id, conversationId, from_type, text, timestamp, agentId, attachmentUrl, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newMessage.id,
      newMessage.conversationId,
      newMessage.from,
      newMessage.text,
      newMessage.timestamp,
      newMessage.agentId || null,
      newMessage.attachmentUrl || null,
      metadataJson
    );
    
    // Actualizar timestamp de actividad en la conversación
    db.prepare(
      'UPDATE conversations SET lastActivity = ? WHERE conversationId = ?'
    ).run(Date.now(), conversationId);
    
    // Notificar actualización - CRÍTICO para notificar a los agentes
    this.notifyConversationUpdated(conversationId);
    
    // Emitir evento de nuevo mensaje
    this.events.emit('message:added', newMessage);
    
    logger.debug(`Nuevo mensaje añadido a conversación ${conversationId}`, {
      from: newMessage.from,
      messageId: newMessage.id
    });
    
    return newMessage;
  } catch (error) {
    logger.error(`Error al guardar mensaje en conversación ${conversationId}`, { error });
    // Eliminar de memoria si no se pudo guardar en BD
    queueItem.messages.pop();
    return null;
  }
}

  /**
   * Añadir un mensaje de sistema a una conversación
   */
  public async addSystemMessage(conversationId: string, text: string): Promise<Message | null> {
    return this.addMessage(conversationId, {
      from: MessageSender.SYSTEM,
      text
    });
  }

  /**
   * Obtener todas las conversaciones en cola
   */
  public getQueue(): QueueItem[] {
    return Array.from(this.agentQueues.values());
  }

  /**
   * Obtener una conversación específica
   */
  public getConversation(conversationId: string): QueueItem | undefined {
    return this.agentQueues.get(conversationId);
  }

/**
 * Obtener mensajes de una conversación
 */
public async getMessages(conversationId: string): Promise<Message[]> {
  try {
    // Buscar directamente en la base de datos para garantizar consistencia
    // Esto evita mezclar mensajes de la memoria y la base de datos
    const db = await initDatabaseConnection();
    
    logger.debug(`Obteniendo mensajes para conversación ${conversationId} directamente desde BD`);
    
    const messages = db.prepare(
      'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC'
    ).all(conversationId);
    
    // Convertir a formato esperado
    const formattedMessages = messages.map((msg: any) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      from: msg.from_type as MessageSender,
      text: msg.text,
      timestamp: msg.timestamp,
      agentId: msg.agentId || undefined,
      attachmentUrl: msg.attachmentUrl || undefined,
      metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined
    }));
    
    logger.debug(`Recuperados ${formattedMessages.length} mensajes para conversación ${conversationId}`);
    
    return formattedMessages;
  } catch (error) {
    logger.error(`Error al obtener mensajes para conversación ${conversationId}`, { error });
    
    // Intentar recuperar desde la memoria como fallback
    const queueItem = this.agentQueues.get(conversationId);
    if (queueItem) {
      logger.warn(`Fallback: Utilizando mensajes en memoria para ${conversationId} (${queueItem.messages.length} mensajes)`);
      return queueItem.messages;
    }
    
    return [];
  }
}

  /**
   * Actualizar prioridad de una conversación
   */
  public async updatePriority(conversationId: string, priority: number): Promise<boolean> {
    const queueItem = this.agentQueues.get(conversationId);
    
    if (!queueItem) {
      logger.warn(`Intento de actualizar prioridad de conversación inexistente: ${conversationId}`);
      return false;
    }
    
    // Validar prioridad
    if (priority < 1 || priority > 5) {
      logger.warn(`Valor de prioridad inválido: ${priority}`);
      return false;
    }
    
    // Actualizar en memoria
    queueItem.priority = priority;
    
    try {
      // Actualizar en SQLite
      const db = await initDatabaseConnection();
      db.prepare(
        'UPDATE queue SET priority = ? WHERE conversationId = ?'
      ).run(priority, conversationId);
      
      // Añadir mensaje de sistema si la prioridad es alta
      if (priority >= 3) {
        await this.addSystemMessage(
          conversationId, 
          `Prioridad actualizada a ${priority} (${priority >= 4 ? 'Urgente' : 'Alta'})`
        );
      }
      
      // Notificar actualización
      this.notifyQueueUpdated();
      
      logger.info(`Prioridad de conversación ${conversationId} actualizada a ${priority}`);
      
      return true;
    } catch (error) {
      logger.error(`Error al actualizar prioridad de conversación ${conversationId}`, { error });
      return false;
    }
  }

  /**
   * Añadir o eliminar tags de una conversación
   */
  public async updateTags(conversationId: string, tags: string[]): Promise<boolean> {
    const queueItem = this.agentQueues.get(conversationId);
    
    if (!queueItem) {
      logger.warn(`Intento de actualizar tags de conversación inexistente: ${conversationId}`);
      return false;
    }
    
    // Actualizar en memoria
    queueItem.tags = tags;
    
    try {
      // Actualizar en SQLite
      const db = await initDatabaseConnection();
      const tagsJson = JSON.stringify(tags);
      
      db.prepare(
        'UPDATE queue SET tags = ? WHERE conversationId = ?'
      ).run(tagsJson, conversationId);
      
      // Notificar actualización
      this.notifyQueueUpdated();
      
      logger.info(`Tags de conversación ${conversationId} actualizados: ${tags.join(', ')}`);
      
      return true;
    } catch (error) {
      logger.error(`Error al actualizar tags de conversación ${conversationId}`, { error });
      return false;
    }
  }

  /**
   * Actualizar metadatos de una conversación
   */
  public async updateMetadata(conversationId: string, metadata: Record<string, any>): Promise<boolean> {
    const queueItem = this.agentQueues.get(conversationId);
    
    if (!queueItem) {
      logger.warn(`Intento de actualizar metadata de conversación inexistente: ${conversationId}`);
      return false;
    }
    
    // Actualizar en memoria
    queueItem.metadata = {
      ...queueItem.metadata,
      ...metadata
    };
    
    try {
      // Actualizar en SQLite
      const db = await initDatabaseConnection();
      const metadataJson = JSON.stringify(queueItem.metadata);
      
      db.prepare(
        'UPDATE queue SET metadata = ? WHERE conversationId = ?'
      ).run(metadataJson, conversationId);
      
      logger.debug(`Metadata de conversación ${conversationId} actualizada`);
      
      return true;
    } catch (error) {
      logger.error(`Error al actualizar metadata de conversación ${conversationId}`, { error });
      return false;
    }
  }

  /**
   * Obtener conversaciones asignadas a un agente
   */
  public async getConversationsByAgent(agentId: string): Promise<QueueItem[]> {
    const allConversations = this.getQueue();
    return allConversations.filter(item => item.assignedAgent === agentId);
  }

  /**
   * Obtener conversaciones sin asignar
   */
  public async getUnassignedConversations(): Promise<QueueItem[]> {
    const allConversations = this.getQueue();
    return allConversations.filter(item => !item.assignedAgent);
  }

  /**
   * Buscar conversación más antigua sin asignar
   */
  public async getOldestUnassignedConversation(): Promise<QueueItem | null> {
    const unassigned = await this.getUnassignedConversations();
    
    if (unassigned.length === 0) {
      return null;
    }
    
    // Ordenar por prioridad (mayor primero) y luego por tiempo (más antiguo primero)
    return unassigned.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.startTime - b.startTime;
    })[0];
  }

  /**
   * Notificar a todos los agentes sobre actualización de la cola
   */
  private notifyQueueUpdated(): void {
    // Emitir evento local
    this.events.emit('queue:updated', this.getQueue());
    
    // Notificar vía WebSocket si está disponible
    if (this.webSocketService) {
      this.webSocketService.broadcastToAgents('queue:updated', this.getQueue());
    }
  }

/**
 * Notificar actualización de una conversación específica de manera más robusta
 * Esta función garantiza que los agentes sean notificados sobre nuevos mensajes
 * incluso cuando hay problemas de sincronización entre servicios
 */
private notifyConversationUpdated(conversationId: string): void {
  // Obtener la conversación para usar sus datos
  const conversation = this.getConversation(conversationId);
  
  if (!conversation) {
    logger.warn(`No se pudo notificar actualización: Conversación ${conversationId} no encontrada en memoria`);
    
    // Intentar buscar a qué agente podría estar asignada aunque no esté en memoria
    this.tryNotifyAssignedAgentByConversationId(conversationId);
    return;
  }
  
  // Emitir evento local
  this.events.emit(`conversation:${conversationId}:updated`, conversation);
  
  // Notificar al agente asignado vía WebSocket
  if (this.webSocketService && conversation.assignedAgent) {
    // Verificar que tenemos el servicio WebSocket
    if (!this.webSocketService) {
      logger.warn(`No se pudo notificar vía WebSocket: WebSocketService no disponible para ${conversationId}`);
      return;
    }
    
    try {
      // Enviar notificación al agente asignado
      const sent = this.webSocketService.sendToAgent(
        conversation.assignedAgent, 
        'conversation:updated', 
        conversation
      );
      
      if (sent) {
        logger.debug(`Notificación de actualización enviada al agente ${conversation.assignedAgent} para conversación ${conversationId}`);
      } else {
        logger.warn(`No se pudo enviar notificación al agente ${conversation.assignedAgent} para conversación ${conversationId}`);
      }
    } catch (error) {
      logger.error(`Error al enviar notificación WebSocket: ${conversationId}`, { error });
    }
  } else {
    logger.debug(`No hay agente asignado para notificar sobre conversación ${conversationId}`);
    
    // Si no hay agente asignado, notificar a todos los agentes sobre la actualización de la cola
    // para que puedan ver mensajes nuevos de conversaciones sin asignar
    if (this.webSocketService) {
      try {
        this.webSocketService.broadcastToAgents('queue:updated', this.getQueue());
        logger.debug(`Broadcast de actualización de cola enviado a todos los agentes`);
      } catch (broadcastError) {
        logger.error(`Error al hacer broadcast de actualización de cola`, { error: broadcastError });
      }
    }
  }
}

/**
 * Intenta notificar al agente asignado buscando en la base de datos
 * cuando la conversación no está en memoria
 */
private async tryNotifyAssignedAgentByConversationId(conversationId: string): Promise<void> {
  try {
    // Buscar en BD a qué agente está asignada esta conversación
    const db = await initDatabaseConnection();
    
    // Primero buscar en la tabla queue
    const queueEntry = db.prepare(
      'SELECT assignedAgent FROM queue WHERE conversationId = ?'
    ).get(conversationId);
    
    if (queueEntry && queueEntry.assignedAgent) {
      logger.info(`Conversación ${conversationId} encontrada en BD asignada a ${queueEntry.assignedAgent}`);
      
      if (this.webSocketService) {
        // Enviar una notificación genérica de que hay un nuevo mensaje
        const sent = this.webSocketService.sendToAgent(
          queueEntry.assignedAgent, 
          'message:notification', 
          {
            conversationId,
            messageTime: Date.now(),
            note: 'Nueva actividad detectada, actualice para ver detalles'
          }
        );
        
        if (sent) {
          logger.info(`Notificación de respaldo enviada al agente ${queueEntry.assignedAgent} para conversación ${conversationId}`);
        } else {
          logger.warn(`No se pudo enviar notificación de respaldo al agente ${queueEntry.assignedAgent}`);
        }
        
        // También enviar actualización general de la cola
        this.webSocketService.broadcastToAgents('queue:updated', this.getQueue());
      }
    } else {
      logger.warn(`No se encontró agente asignado en BD para conversación ${conversationId}`);
      
      // Si no hay agente asignado, notificar a todos sobre actualización de cola
      if (this.webSocketService) {
        this.webSocketService.broadcastToAgents('queue:updated', this.getQueue());
      }
    }
  } catch (error) {
    logger.error(`Error al buscar agente asignado en BD para ${conversationId}`, { error });
  }
}

  /**
   * Establecer servicio WebSocket para notificaciones
   */
  public setWebSocketService(wsService: WebSocketService): void {
    this.webSocketService = wsService;
  }

  /**
   * Registrar manejador de eventos
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    this.events.on(event, listener);
  }

  /**
   * Obtener estadísticas de la cola
   */
  public getQueueStats(): Record<string, any> {
    const queue = this.getQueue();
    const unassigned = queue.filter(item => !item.assignedAgent);
    const assigned = queue.filter(item => !!item.assignedAgent);
    
    // Calcular tiempos promedio
    const now = Date.now();
    const waitTimes = queue.map(item => now - item.startTime);
    const avgWaitTime = waitTimes.length > 0 
      ? waitTimes.reduce((sum, time) => sum + time, 0) / waitTimes.length 
      : 0;
    
    // Conversaciones por prioridad
    const byPriority = {
      1: queue.filter(item => item.priority === 1).length,
      2: queue.filter(item => item.priority === 2).length,
      3: queue.filter(item => item.priority === 3).length,
      4: queue.filter(item => item.priority === 4).length,
      5: queue.filter(item => item.priority === 5).length
    };
    
    return {
      total: queue.length,
      unassigned: unassigned.length,
      assigned: assigned.length,
      avgWaitTimeMs: avgWaitTime,
      byPriority
    };
  }

    /**
   * Limpiar cualquier temporizador activo para una conversación
   */
    private clearConversationTimer(conversationId: string): void {
      if (this.conversationTimers.has(conversationId)) {
        const timerInfo = this.conversationTimers.get(conversationId);
        if (timerInfo?.timerId) {
          clearTimeout(timerInfo.timerId);
        }
        this.conversationTimers.delete(conversationId);
        logger.debug(`Timer eliminado para conversación ${conversationId}`);
      }
    }

     /**
   * Iniciar o reiniciar el temporizador de respuesta del agente para una conversación
   */
  private startAgentResponseTimer(conversationId: string, userMessageTimestamp: number): void {
    // Limpiar temporizador existente primero
    this.clearConversationTimer(conversationId);

    const timeoutDurationMs = config.agentSupport.responseTimeoutSeconds * 1000;

    logger.debug(`Iniciando temporizador de respuesta de agente (${timeoutDurationMs}ms) para ${conversationId}`);

    const timerId = setTimeout(() => {
      // Usar un wrapper no-async para evitar rechazos de promesas no manejados en setTimeout
      this.handleAgentResponseTimeout(conversationId, 1, userMessageTimestamp)
        .catch(error => {
          logger.error(`Error al manejar timeout para ${conversationId}`, { error });
        });
    }, timeoutDurationMs);

    this.conversationTimers.set(conversationId, {
      timerId,
      lastUserMessageTimestamp: userMessageTimestamp,
      waitingMessagesSent: 0 // Reiniciar contador cuando se inicia el temporizador
    });
  }


   /**
   * Manejar el timeout cuando un agente no ha respondido
   */
   private async handleAgentResponseTimeout(
    conversationId: string, 
    attempt: number, 
    originalUserMessageTimestamp: number
  ): Promise<void> {
    logger.info(`Timeout de respuesta de agente activado para ${conversationId}, intento ${attempt}`);

    // Obtener el elemento de cola (detalles de la conversación)
    const queueItem = this.agentQueues.get(conversationId);
    if (!queueItem || !queueItem.assignedAgent) {
      logger.warn(`Timeout para ${conversationId}, pero la conversación no se encuentra en la cola o no tiene agente asignado. Limpiando temporizador.`);
      this.clearConversationTimer(conversationId); // Asegurar que el temporizador se limpia
      return;
    }

    // Verificar si un agente ha respondido *desde* el mensaje del usuario que activó este temporizador
    const lastAgentMessage = queueItem.messages
      .filter(m => m.from === 'agent' && m.agentId === queueItem.assignedAgent)
      .sort((a, b) => b.timestamp - a.timestamp)[0]; // Obtener el último mensaje del agente

    if (lastAgentMessage && lastAgentMessage.timestamp > originalUserMessageTimestamp) {
      logger.info(`El agente respondió a ${conversationId} antes del timeout. No se requiere acción.`);
      // El agente respondió, limpiar la información del temporizador pero no iniciar uno nuevo
      this.conversationTimers.delete(conversationId);
      return;
    }

    // --- El agente NO ha respondido aún ---

    const timerInfo = this.conversationTimers.get(conversationId);
    // Actualizar el mapa de temporizadores inmediatamente para reflejar que el timeout se ha disparado para este intento
    if (timerInfo) {
      this.conversationTimers.set(conversationId, { ...timerInfo, waitingMessagesSent: attempt });
    } else {
      // No debería ocurrir si el temporizador se disparó, pero manejar defensivamente
      logger.warn(`Información de temporizador faltante para ${conversationId} durante el manejador de timeout`);
      this.conversationTimers.set(conversationId, {
        timerId: null as any, // El temporizador ya se disparó
        lastUserMessageTimestamp: originalUserMessageTimestamp,
        waitingMessagesSent: attempt
      });
    }

    if (attempt === 1) {
      // Primer timeout: Enviar mensaje de espera y reiniciar temporizador para redirección
      logger.info(`Enviando mensaje de espera a ${conversationId}`);
      try {
        await this.whatsappService.sendMessage(
          queueItem.phone_number_id,
          queueItem.from,
          config.agentSupport.waitingMessage
        );
        await this.addSystemMessage(conversationId, `Sistema: Se envió '${config.agentSupport.waitingMessage}' debido a inactividad del agente.`);

        // Reiniciar temporizador para la siguiente acción (redirección)
        const nextTimeoutDurationMs = config.agentSupport.responseTimeoutSeconds * 
                                     config.agentSupport.redirectTimeoutMultiplier * 1000;
        logger.debug(`Reiniciando temporizador para ${conversationId} (${nextTimeoutDurationMs}ms) para posible redirección.`);

        const nextTimerId = setTimeout(() => {
          this.handleAgentResponseTimeout(conversationId, 2, originalUserMessageTimestamp)
            .catch(error => {
              logger.error(`Error al manejar timeout de redirección para ${conversationId}`, { error });
            });
        }, nextTimeoutDurationMs);

        // Actualizar mapa de temporizadores con nuevo timerId pero mantener timestamp original y contador incrementado
        const currentTimerInfo = this.conversationTimers.get(conversationId);
        if (currentTimerInfo) {
          this.conversationTimers.set(conversationId, {
            ...currentTimerInfo,
            timerId: nextTimerId,
            // waitingMessagesSent sigue siendo 1 de la actualización anterior
          });
        }
      } catch (error) {
        logger.error(`Error al enviar mensaje de espera o reiniciar temporizador para ${conversationId}`, { error });
        // Limpiar temporizador si el envío falló para prevenir posibles bucles
        this.clearConversationTimer(conversationId);
      }
    } else if (attempt >= 2) {
      // Segundo timeout (o subsecuente): Redireccionar al menú del bot
      logger.info(`Redireccionando conversación ${conversationId} de vuelta al bot debido a inactividad del agente.`);
      // Limpiar completamente el temporizador antes de redireccionar
      this.clearConversationTimer(conversationId);
      try {
        const conversationService = initConversationService(); // Obtener instancia
        await conversationService.redirectConversationToBot(conversationId);
        // No es necesario añadir mensaje de sistema aquí, redirectConversationToBot lo maneja
      } catch (error) {
        logger.error(`Error al redireccionar conversación ${conversationId} al bot`, { error });
      }
    }
  }
    
   /**
   * Elimina la asignación de agente y limpia los temporizadores relacionados sin marcar la conversación como completada.
   * Usado cuando se redirecciona al bot debido a inactividad.
   */
   public async removeAssignmentAndClearTimer(conversationId: string): Promise<boolean> {
    this.clearConversationTimer(conversationId); // Limpiar temporizador primero

    const queueItem = this.agentQueues.get(conversationId);
    if (!queueItem) {
      logger.warn(`Intento de eliminar asignación para ${conversationId}, pero no se encontró en memoria de cola.`);
      // Intentar actualizar BD de todos modos, podría ser solo inconsistencia de memoria
    } else {
      queueItem.assignedAgent = null; // Eliminar de memoria
    }

    try {
      const db = await initDatabaseConnection();
      // Eliminar asignación de la tabla queue
      const result = db.prepare('UPDATE queue SET assignedAgent = NULL WHERE conversationId = ?')
                      .run(conversationId);

      if (result.changes > 0) {
        logger.info(`Asignación de agente eliminada de la tabla queue para ${conversationId}`);
      } else {
        logger.warn(`No se encontró asignación en la tabla queue para eliminar para ${conversationId}`);
      }

      this.notifyQueueUpdated(); // Notificar a los agentes sobre el cambio
      return true;
    } catch (error) {
      logger.error(`Error al eliminar asignación de agente de la tabla queue para ${conversationId}`, { error });
      // Si la BD falló, revertir cambio en memoria si es posible
      if (queueItem) queueItem.assignedAgent = 'error_reverting'; // Indicar estado fallido quizás?
      return false;
    }
  }

  /**
 * Elimina completamente una conversación de la cola
 * Usado cuando se redirecciona al bot por inactividad u otros motivos
 */
public async removeFromQueue(conversationId: string): Promise<boolean> {
  // Limpiar cualquier temporizador existente
  this.clearConversationTimer(conversationId);
  
  // Verificar si está en memoria antes de eliminar
  const wasInMemory = this.agentQueues.has(conversationId);
  
  // Eliminar de la memoria
  const deleted = this.agentQueues.delete(conversationId);
  
  try {
    // Eliminar de la base de datos
    const db = await initDatabaseConnection();
    const result = db.prepare('DELETE FROM queue WHERE conversationId = ?').run(conversationId);
    
    if (result.changes > 0) {
      logger.info(`Conversación ${conversationId} eliminada de la tabla queue`);
    } else {
      logger.warn(`Conversación ${conversationId} no encontrada en la tabla queue`);
    }
    
    // Emitir evento para notificar de la eliminación
    this.events.emit('conversation:removed', { 
      conversationId, 
      reason: 'redirected_to_bot',
      timestamp: Date.now() 
    });
    
    // Notificar a todos los agentes que la cola ha cambiado
    this.notifyQueueUpdated();
    
    logger.info(`Conversación ${conversationId} eliminada completamente de la cola`);
    
    // Devolver true si estaba en memoria y se eliminó
    return wasInMemory;
  } catch (error) {
    logger.error(`Error al eliminar conversación ${conversationId} de la cola`, { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Aún así notificar para intentar actualizar la vista de los agentes
    try {
      this.notifyQueueUpdated();
    } catch (notifyError) {
      logger.error(`Error secundario al notificar eliminación de ${conversationId}`, { error: notifyError });
    }
    
    // Devolver true solo si se eliminó de memoria
    return deleted;
  }
}


/**
 * Iniciar temporizador de espera en cola (cuando no hay agente asignado)
 * Este se inicia desde el momento de la escalación
 */
private startQueueWaitTimer(conversationId: string, startTime: number): void {
  // Limpiar temporizador existente primero
  this.clearConversationTimer(conversationId);

  const timeoutDurationMs = config.agentSupport.responseTimeoutSeconds * 1000;

  logger.debug(`Iniciando temporizador de espera en cola (${timeoutDurationMs}ms) para ${conversationId}`);

  const timerId = setTimeout(() => {
    this.handleQueueWaitTimeout(conversationId, 1, startTime)
      .catch(error => {
        logger.error(`Error al manejar timeout de cola para ${conversationId}`, { error });
      });
  }, timeoutDurationMs);

  this.conversationTimers.set(conversationId, {
    timerId,
    lastUserMessageTimestamp: startTime,
    waitingMessagesSent: 0 // Reiniciar contador
  });
}

/**
 * Manejar timeout de espera en cola (sin agente asignado)
 */
private async handleQueueWaitTimeout(
  conversationId: string, 
  attempt: number, 
  queueStartTime: number
): Promise<void> {
  logger.info(`Timeout de espera en cola activado para ${conversationId}, intento ${attempt}`);

  // Obtener el elemento de cola
  const queueItem = this.agentQueues.get(conversationId);
  if (!queueItem) {
    logger.warn(`Timeout para ${conversationId}, pero la conversación no se encuentra en la cola. Limpiando temporizador.`);
    this.clearConversationTimer(conversationId);
    return;
  }

  // Verificar si un agente ha sido asignado desde que se inició el temporizador
  if (queueItem.assignedAgent) {
    logger.info(`La conversación ${conversationId} ya tiene agente asignado (${queueItem.assignedAgent}). Limpiando temporizador de cola.`);
    this.clearConversationTimer(conversationId);
    return;
  }

  const timerInfo = this.conversationTimers.get(conversationId);
  // Actualizar información del temporizador
  if (timerInfo) {
    this.conversationTimers.set(conversationId, { ...timerInfo, waitingMessagesSent: attempt });
  } else {
    // Manejo defensivo
    logger.warn(`Información de temporizador faltante para ${conversationId} durante timeout de cola`);
    this.conversationTimers.set(conversationId, {
      timerId: null as any,
      lastUserMessageTimestamp: queueStartTime,
      waitingMessagesSent: attempt
    });
  }

  if (attempt === 1) {
    // Primer timeout: Enviar mensaje de espera y reiniciar temporizador para posible redirección
    logger.info(`Enviando mensaje de espera a ${conversationId} (en cola sin agente)`);
    try {
      await this.whatsappService.sendMessage(
        queueItem.phone_number_id,
        queueItem.from,
        config.agentSupport.waitingMessage
      );
      await this.addSystemMessage(conversationId, `Sistema: Se envió '${config.agentSupport.waitingMessage}' debido a tiempo de espera en cola.`);

      // Reiniciar temporizador para siguiente acción
      const nextTimeoutDurationMs = config.agentSupport.responseTimeoutSeconds * 
                                  config.agentSupport.redirectTimeoutMultiplier * 1000;
      logger.debug(`Reiniciando temporizador de cola para ${conversationId} (${nextTimeoutDurationMs}ms) para posible redirección.`);

      const nextTimerId = setTimeout(() => {
        this.handleQueueWaitTimeout(conversationId, 2, queueStartTime)
          .catch(error => {
            logger.error(`Error al manejar timeout de redirección de cola para ${conversationId}`, { error });
          });
      }, nextTimeoutDurationMs);

      // Actualizar mapa de temporizadores
      const currentTimerInfo = this.conversationTimers.get(conversationId);
      if (currentTimerInfo) {
        this.conversationTimers.set(conversationId, {
          ...currentTimerInfo,
          timerId: nextTimerId,
        });
      }
    } catch (error) {
      logger.error(`Error al enviar mensaje de espera en cola para ${conversationId}`, { error });
      this.clearConversationTimer(conversationId);
    }
  } else if (attempt >= 2) {
    // Segundo timeout: Redireccionar al bot
    logger.info(`Redireccionando conversación ${conversationId} al bot debido a tiempo excesivo en cola sin asignación.`);
    // Limpiar temporizador antes de redireccionar
    this.clearConversationTimer(conversationId);
    try {
      const conversationService = initConversationService();
      await conversationService.redirectConversationToBot(conversationId);
    } catch (error) {
      logger.error(`Error al redireccionar conversación ${conversationId} desde timeout de cola`, { error });
    }
  }
}


}

// Singleton para acceso global
let queueServiceInstance: QueueService | null = null;

export function initQueueService(): QueueService {
  if (!queueServiceInstance) {
    queueServiceInstance = new QueueService();
  }
  return queueServiceInstance;
}

export default initQueueService;