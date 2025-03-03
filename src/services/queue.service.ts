// src/services/queue.service.ts
import { EventEmitter } from 'events';
import { QueueItem } from '../models/queue.model';
import { Message, MessageSender } from '../models/message.model';
import { ConversationStatus } from '../models/conversation.model';
import { WebSocketService } from '../websocket/server';
import { QueueRepository } from '../database/repositories/queue.repository';
import { MessageRepository } from '../database/repositories/message.repository';
import logger from '../utils/logger';

class QueueService {
  private agentQueues: Map<string, QueueItem>;
  private events: EventEmitter;
  private queueRepository: QueueRepository;
  private messageRepository: MessageRepository;
  private webSocketService?: WebSocketService;

  constructor() {
    this.agentQueues = new Map<string, QueueItem>();
    this.events = new EventEmitter();
    this.queueRepository = new QueueRepository();
    this.messageRepository = new MessageRepository();
    
    // Cargar estado inicial
    this.loadInitialState();
    
    // Configurar guardado periódico
    setInterval(() => this.saveQueueState(), 5 * 60 * 1000); // cada 5 minutos
  }

  /**
   * Cargar estado inicial de la cola desde la base de datos
   */
  private async loadInitialState(): Promise<void> {
    try {
      // Cargar conversaciones en cola
      const queueItems = await this.queueRepository.findAll();
      
      // Llenar el mapa en memoria
      for (const item of queueItems) {
        // Cargar los mensajes asociados a esta conversación
        const messages = await this.messageRepository.findByConversation(item.conversationId);
        
        // Actualizar con los mensajes más recientes
        const queueItemWithMessages = {
          ...item,
          messages: messages || []
        };
        
        this.agentQueues.set(item.conversationId, queueItemWithMessages);
      }
      
      logger.info(`Cargadas ${this.agentQueues.size} conversaciones en cola desde la base de datos`);
    } catch (error) {
      logger.error('Error al cargar estado inicial de cola', { error });
    }
  }

  /**
   * Guardar estado actual en la base de datos
   */
  public async saveQueueState(): Promise<void> {
    try {
      const updatePromises: Promise<QueueItem | null>[] = [];
      
      for (const [id, item] of this.agentQueues.entries()) {
        // No guardar los mensajes en la tabla de cola para evitar duplicación
        const { messages, ...queueItemWithoutMessages } = item;
        
        // Actualizar o crear en la base de datos
        updatePromises.push(
          this.queueRepository.update(id, queueItemWithoutMessages as QueueItem)
            .then(updated => {
              if (!updated) {
                // Si no existe, crear nuevo
                return this.queueRepository.create(queueItemWithoutMessages as QueueItem);
              }
              return updated;
            })
        );
      }
      
      await Promise.all(updatePromises);
      logger.info(`Estado de cola guardado en base de datos (${this.agentQueues.size} conversaciones)`);
    } catch (error) {
      logger.error('Error al guardar estado de cola', { error });
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
    
    // Guardar en base de datos
    await this.queueRepository.create(newQueueItem);
    
    // Notificar a los agentes disponibles
    this.notifyQueueUpdated();
    
    logger.info(`Nueva conversación añadida a la cola: ${queueItem.conversationId}`);
    
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
    
    // Actualizar en base de datos
    await this.queueRepository.update(conversationId, { assignedAgent: agentId });
    
    // Añadir mensaje de sistema
    await this.addSystemMessage(conversationId, `Agente ${agentId} se ha unido a la conversación`);
    
    // Notificar actualización
    this.notifyQueueUpdated();
    this.notifyConversationUpdated(conversationId);
    
    logger.info(`Conversación ${conversationId} asignada al agente ${agentId}`);
    
    return true;
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
    
    // Eliminar de la base de datos
    await this.queueRepository.delete(conversationId);
    
    // No eliminamos los mensajes de la base de datos para mantener historial
    
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
    
    // Guardar en base de datos
    await this.messageRepository.create(newMessage);
    
    // Notificar actualización
    this.notifyConversationUpdated(conversationId);
    
    // Emitir evento de nuevo mensaje
    this.events.emit('message:added', newMessage);
    
    logger.debug(`Nuevo mensaje añadido a conversación ${conversationId}`, {
      from: newMessage.from,
      messageId: newMessage.id
    });
    
    return newMessage;
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
    
    // Si no está en memoria, buscar en la base de datos
    return this.messageRepository.findByConversation(conversationId);
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
    
    // Actualizar en base de datos
    await this.queueRepository.update(conversationId, { priority });
    
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
    
    // Actualizar en base de datos
    await this.queueRepository.update(conversationId, { tags });
    
    // Notificar actualización
    this.notifyQueueUpdated();
    
    logger.info(`Tags de conversación ${conversationId} actualizados: ${tags.join(', ')}`);
    
    return true;
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
    
    // Actualizar en base de datos
    await this.queueRepository.update(conversationId, { 
      metadata: queueItem.metadata 
    });
    
    logger.debug(`Metadata de conversación ${conversationId} actualizada`);
    
    return true;
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
      this.webSocketService.sendToAgent(
        conversation.assignedAgent,
        'conversation:updated',
        conversation
      );
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