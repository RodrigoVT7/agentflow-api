// src/database/repositories/message.repository.ts
import { SQLiteBatchRepository } from './sqlite-batch.repository';
import { Message } from '../../models/message.model';
import { IBatchRepository } from './base.repository';
import logger from '../../utils/logger';

/**
 * Repositorio para gestión de mensajes
 */
export class MessageRepository implements IBatchRepository<Message> {
  private repository: IBatchRepository<Message>;

  constructor() {
    // Inicializar el repositorio SQLite con operaciones batch y campo ID personalizado
    this.repository = new SQLiteBatchRepository<Message>('messages', 'id');
    logger.debug('MessageRepository inicializado con SQLite');
  }

  async create(data: Message): Promise<Message> {
    return this.repository.create(data);
  }

  async findById(id: string): Promise<Message | null> {
    return this.repository.findById(id);
  }

  async findAll(filter?: Partial<Message>): Promise<Message[]> {
    return this.repository.findAll(filter);
  }

  async update(id: string, data: Partial<Message>): Promise<Message | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async findOne(filter: Partial<Message>): Promise<Message | null> {
    return this.repository.findOne(filter);
  }

  async count(filter?: Partial<Message>): Promise<number> {
    return this.repository.count(filter);
  }

  async createMany(items: Message[]): Promise<Message[]> {
    return this.repository.createMany(items);
  }

  async updateMany(filter: Partial<Message>, data: Partial<Message>): Promise<number> {
    return this.repository.updateMany(filter, data);
  }

  async deleteMany(filter: Partial<Message>): Promise<number> {
    return this.repository.deleteMany(filter);
  }

  /**
   * Obtener mensajes de una conversación
   */
  async findByConversation(conversationId: string): Promise<Message[]> {
    const messages = await this.repository.findAll({ 
      conversationId 
    } as Partial<Message>);
    
    // Ordenar por timestamp (más antiguos primero)
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Obtener último mensaje de una conversación
   */
  async findLastMessage(conversationId: string): Promise<Message | null> {
    const messages = await this.findByConversation(conversationId);
    
    if (messages.length === 0) {
      return null;
    }
    
    // El último mensaje es el más reciente
    return messages[messages.length - 1];
  }
}