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
      
      // Obtener conversaciones en cola
      const queueItems = await db.all('SELECT * FROM queue');
      
      if (queueItems && queueItems.length > 0) {
        // Limpiar el mapa actual
        this.agentQueues.clear();
        
        for (const item of queueItems) {
          // Cargar los mensajes asociados a esta conversación
          const messages = await db.all(
            'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC',
            [item.conversationId]
          );
          
          // Convertir las cadenas JSON a objetos
          const tags = item.tags ? JSON.parse(item.tags) : [];
          const metadata = item.metadata ? JSON.parse(item.metadata) : {};
          
          // Crear objeto de cola en memoria
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
        
        logger.info(`Cargadas ${queueItems.length} conversaciones en cola desde SQLite`);
      }
    } catch (error) {
      logger.error('Error al cargar estado inicial de cola desde SQLite', { error });
    }
  }

  /**
   * Añadir una conversación a la cola de espera
   */
  public async addToQueue(queueItem: Omit<QueueItem, 'startTime' | 'messages' | 'priority' | 'tags'>): Promise<QueueItem> {
    const newQueueItem: QueueItem = {
      ...queueItem,
      startTime: Date.now(),
      messages: [],
      priority: 1, // Prioridad normal por defecto
      tags: [],
      metadata: queueItem.metadata || {}
    };
    
    // Guardar en memoria
    this.agentQueues.set(queueItem.conversationId, newQueueItem);
    
    try {
      // Guardar en SQLite
      const db = await initDatabaseConnection();
      
      // Convertir arrays y objetos a JSON para almacenar
      const tagsJson = JSON.stringify(newQueueItem.tags);
      const metadataJson = JSON.stringify(newQueueItem.metadata);
      
      await db.run(
        `INSERT INTO queue
         (conversationId, from_number, phone_number_id, startTime, priority, tags, assignedAgent, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newQueueItem.conversationId,
          newQueueItem.from,
          newQueueItem.phone_number_id,
          newQueueItem.startTime,
          newQueueItem.priority,
          tagsJson,
          newQueueItem.assignedAgent,
          metadataJson
        ]
      );
      
      // Notificar a los agentes disponibles
      this.notifyQueueUpdated();
      
      logger.info(`Nueva conversación añadida a la cola: ${queueItem.conversationId}`);
    } catch (error) {
      logger.error(`Error al guardar nueva conversación en cola: ${queueItem.conversationId}`, { error });
    }
    
    return newQueueItem;
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
      await db.run(
        'UPDATE queue SET assignedAgent = ? WHERE conversationId = ?',
        [agentId, conversationId]
      );
      
      // Actualizar estado de la conversación
      await db.run(
        'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?',
        [ConversationStatus.ASSIGNED, Date.now(), conversationId]
      );
      
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
      logger.warn(`Intento de completar conversación inexistente: ${conversationId}`);
      return false;
    }
    
    // Obtener la conversación antes de eliminarla
    const conversation = this.agentQueues.get(conversationId);
    
    // Eliminar de la memoria
    this.agentQueues.delete(conversationId);
    
    try {
      const db = await initDatabaseConnection();
      
      // Actualizar estado en la base de datos (no eliminar para mantener historial)
      await db.run(
        'UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?',
        [ConversationStatus.COMPLETED, Date.now(), conversationId]
      );
      
      // Eliminar de la cola
      await db.run('DELETE FROM queue WHERE conversationId = ?', [conversationId]);
      
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
      return false;
    }
  }

  /**
   * Añadir un mensaje a una conversación
   */
  public async addMessage(conversationId: string, message: Omit<Message, 'id' | 'conversationId' | 'timestamp'>): Promise<Message | null> {
    const queueItem = this.agentQueues.get(conversationId);
    
    if (!queueItem) {
      logger.warn(`Intento de añadir mensaje a conversación inexistente: ${conversationId}`);
      return null;
    }
    
    const newMessage: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
      
      await db.run(
        `INSERT INTO messages
         (id, conversationId, from_type, text, timestamp, agentId, attachmentUrl, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newMessage.id,
          newMessage.conversationId,
          newMessage.from,
          newMessage.text,
          newMessage.timestamp,
          newMessage.agentId || null,
          newMessage.attachmentUrl || null,
          metadataJson
        ]
      );
      
      // Actualizar timestamp de actividad en la conversación
      await db.run(
        'UPDATE conversations SET lastActivity = ? WHERE conversationId = ?',
        [Date.now(), conversationId]
      );
      
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
    // Primero intentar desde memoria
    const queueItem = this.agentQueues.get(conversationId);
    
    if (queueItem) {
      return queueItem.messages;
    }
    
    // Si no está en memoria, buscar en SQLite
    try {
      const db = await initDatabaseConnection();
      const messages = await db.all(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC',
        [conversationId]
      );
      
      return messages.map((msg: any) => ({
        id: msg.id,
        conversationId: msg.conversationId,
        from: msg.from_type as MessageSender,
        text: msg.text,
        timestamp: msg.timestamp,
        agentId: msg.agentId || undefined,
        attachmentUrl: msg.attachmentUrl || undefined,
        metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined
      }));
    } catch (error) {
      logger.error(`Error al obtener mensajes desde SQLite: ${conversationId}`, { error });
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
      await db.run(
        'UPDATE queue SET priority = ? WHERE conversationId = ?',
        [priority, conversationId]
      );
      
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
      
      await db.run(
        'UPDATE queue SET tags = ? WHERE conversationId = ?',
        [tagsJson, conversationId]
      );
      
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
      
      await db.run(
        'UPDATE queue SET metadata = ? WHERE conversationId = ?',
        [metadataJson, conversationId]
      );
      
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