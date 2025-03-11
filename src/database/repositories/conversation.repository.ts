// src/database/repositories/conversation.repository.ts
import { SQLiteBatchRepository } from './sqlite-batch.repository';
import { ConversationData } from '../../models/conversation.model';
import { IBatchRepository } from './base.repository';
import logger from '../../utils/logger';

/**
 * Repositorio para gestión de conversaciones
 */
export class ConversationRepository implements IBatchRepository<ConversationData> {
  private repository: IBatchRepository<ConversationData>;

  constructor() {
    // Inicializar el repositorio SQLite con operaciones batch y campo ID personalizado
    this.repository = new SQLiteBatchRepository<ConversationData>('conversations', 'conversationId');
    logger.debug('ConversationRepository inicializado con SQLite');
  }

  async create(data: ConversationData): Promise<ConversationData> {
    return this.repository.create(data);
  }

  async findById(id: string): Promise<ConversationData | null> {
    return this.repository.findById(id);
  }

  async findAll(filter?: Partial<ConversationData>): Promise<ConversationData[]> {
    return this.repository.findAll(filter);
  }

  async update(id: string, data: Partial<ConversationData>): Promise<ConversationData | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async findOne(filter: Partial<ConversationData>): Promise<ConversationData | null> {
    return this.repository.findOne(filter);
  }

  async count(filter?: Partial<ConversationData>): Promise<number> {
    return this.repository.count(filter);
  }

  async createMany(items: ConversationData[]): Promise<ConversationData[]> {
    return this.repository.createMany(items);
  }

  async updateMany(filter: Partial<ConversationData>, data: Partial<ConversationData>): Promise<number> {
    return this.repository.updateMany(filter, data);
  }

  async deleteMany(filter: Partial<ConversationData>): Promise<number> {
    return this.repository.deleteMany(filter);
  }

  /**
   * Buscar conversaciones inactivas
   */
  async findInactiveConversations(thresholdTime: number): Promise<ConversationData[]> {
    const allConversations = await this.repository.findAll();
    const now = Date.now();
    
    return allConversations.filter(conversation => 
      now - conversation.lastActivity > thresholdTime
    );
  }

  /**
   * Buscar conversación por número de teléfono
   */
  async findByPhoneNumber(from: string): Promise<ConversationData | null> {
    return this.repository.findOne({ from } as Partial<ConversationData>);
  }
}