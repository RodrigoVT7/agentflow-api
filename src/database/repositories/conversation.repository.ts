// src/database/repositories/conversation.repository.ts

import { MemoryRepository } from './memory.repository';
import { ConversationData } from '../../models/conversation.model';
import { IBatchRepository } from './base.repository';
import path from 'path';
import dbConfig, { DatabaseType } from '../../config/database.config';

/**
 * Repositorio para gestión de conversaciones
 */
export class ConversationRepository implements IBatchRepository<ConversationData> {
  private repository: IBatchRepository<ConversationData>;

  constructor() {
    switch (dbConfig.type) {
      case DatabaseType.MEMORY:
      default:
        this.repository = new MemoryRepository<any>(
          'conversations',
          path.join(__dirname, '../../../data/conversations.json')
        );
        break;
    }
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
