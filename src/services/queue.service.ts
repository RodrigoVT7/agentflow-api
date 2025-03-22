// src/services/queue.service.ts
import { EventEmitter } from 'events';
import { QueueItem } from '../models/queue.model';
import { Message, MessageSender } from '../models/message.model';
import { ConversationStatus } from '../models/conversation.model';
import { WebSocketService } from '../websocket/server';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';

class QueueService {
  private agentQueues: Map<string, QueueItem>;
  private events: EventEmitter;
  private webSocketService?: WebSocketService;

  constructor() {
    this.agentQueues = new Map<string, QueueItem>();
    this.events = new EventEmitter();
    
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
      db.prepare(
        'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?'
      ).run(ConversationStatus.ASSIGNED, Date.now(), conversationId);
      
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
  if (!this.agentQueues.has(conversationId)) {
    logger.warn(`Intento de completar conversación inexistente en cola: ${conversationId}`);
    return false;
  }
  
  // Obtener la conversación antes de eliminarla
  const conversation = this.agentQueues.get(conversationId);
  
  // Eliminar de la memoria
  this.agentQueues.delete(conversationId);
  
  try {
    const db = await initDatabaseConnection();
    
    // Usar una transacción para garantizar que todas las operaciones se completen
    const transaction = db.transaction(() => {
      // Actualizar estado en la base de datos (no eliminar para mantener historial)
      db.prepare(
        'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?'
      ).run(ConversationStatus.COMPLETED, Date.now(), conversationId);
      
      // Eliminar de la cola
      db.prepare('DELETE FROM queue WHERE conversationId = ?').run(conversationId);
    });
    
    // Ejecutar la transacción
    transaction();
    
    // Notificar actualización
    this.notifyQueueUpdated();
    
    logger.info(`Conversación ${conversationId} completada y eliminada de la cola`);
    
    // Emitir evento de conversación completada con datos para análisis
    if (conversation) {
      this.events.emit('conversation:completed', {
        conversationId,
        startTime: conversation.startTime,
        endTime: Date.now(),
        messageCount: conversation.messages.length,
        assignedAgent: conversation.assignedAgent
      });
    }
    
    return true;
  } catch (error) {
    logger.error(`Error al completar conversación ${conversationId}`, { error });
    
    // Si ocurre un error, intentar volver a añadir la conversación a la memoria
    // para evitar pérdida de datos
    if (conversation) {
      this.agentQueues.set(conversationId, conversation);
    }
    
    return false;
  }
}

  /**
   * Añadir un mensaje a una conversación
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
  
    if (!queueItem) {
      logger.warn(`Intento de añadir mensaje a conversación inexistente: ${conversationId}`);
      return null;
    }

    // Crear un nuevo ID para el mensaje
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const newMessage: Message = {
      id: messageId,
      conversationId,
      ...message,
      timestamp: Date.now()
    };
    
    // Añadir a memoria
    queueItem.messages.push(newMessage);
    
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
      
      // Notificar actualización
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
   * Notificar actualización de una conversación específica
   */
  private notifyConversationUpdated(conversationId: string): void {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return;
    
    // Emitir evento local
    this.events.emit(`conversation:${conversationId}:updated`, conversation);
    
    // Notificar al agente asignado vía WebSocket
    if (this.webSocketService && conversation.assignedAgent) {
      this.webSocketService.sendToAgent(conversation.assignedAgent, 'conversation:updated', conversation);
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