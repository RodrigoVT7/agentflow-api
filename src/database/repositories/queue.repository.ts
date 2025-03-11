// src/database/repositories/queue.repository.ts
import { SQLiteBatchRepository } from './sqlite-batch.repository';
import { QueueItem } from '../../models/queue.model';
import { IBatchRepository } from './base.repository';
import logger from '../../utils/logger';

/**
 * Repositorio para gestión de cola de espera
 */
export class QueueRepository implements IBatchRepository<QueueItem> {
  private repository: IBatchRepository<QueueItem>;

  constructor() {
    // Inicializar el repositorio SQLite con operaciones batch y campo ID personalizado
    this.repository = new SQLiteBatchRepository<QueueItem>('queue', 'conversationId');
    logger.debug('QueueRepository inicializado con SQLite');
  }

  async create(data: QueueItem): Promise<QueueItem> {
    return this.repository.create(data);
  }

  async findById(id: string): Promise<QueueItem | null> {
    return this.repository.findById(id);
  }

  async findAll(filter?: Partial<QueueItem>): Promise<QueueItem[]> {
    return this.repository.findAll(filter);
  }

  async update(id: string, data: Partial<QueueItem>): Promise<QueueItem | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async findOne(filter: Partial<QueueItem>): Promise<QueueItem | null> {
    return this.repository.findOne(filter);
  }

  async count(filter?: Partial<QueueItem>): Promise<number> {
    return this.repository.count(filter);
  }

  async createMany(items: QueueItem[]): Promise<QueueItem[]> {
    return this.repository.createMany(items);
  }

  async updateMany(filter: Partial<QueueItem>, data: Partial<QueueItem>): Promise<number> {
    return this.repository.updateMany(filter, data);
  }

  async deleteMany(filter: Partial<QueueItem>): Promise<number> {
    return this.repository.deleteMany(filter);
  }

  /**
   * Buscar conversaciones en cola sin asignar
   */
  async findUnassigned(): Promise<QueueItem[]> {
    return this.repository.findAll({ assignedAgent: null } as Partial<QueueItem>);
  }

  /**
   * Buscar conversaciones asignadas a un agente específico
   */
  async findByAgent(agentId: string): Promise<QueueItem[]> {
    return this.repository.findAll({ assignedAgent: agentId } as Partial<QueueItem>);
  }

  /**
   * Buscar conversaciones por prioridad
   */
  async findByPriority(priority: number): Promise<QueueItem[]> {
    return this.repository.findAll({ priority } as Partial<QueueItem>);
  }

  /**
   * Encontrar la conversación más antigua sin asignar
   */
  async findOldestUnassigned(): Promise<QueueItem | null> {
    const unassigned = await this.findUnassigned();
    if (unassigned.length === 0) {
      return null;
    }
    
    // Ordenar por tiempo de inicio y prioridad
    return unassigned.sort((a, b) => {
      // Primero por prioridad (mayor primero)
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // Luego por tiempo de espera (más antiguo primero)
      return a.startTime - b.startTime;
    })[0];
  }
}