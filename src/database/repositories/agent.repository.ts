// src/database/repositories/agent.repository.ts
import { SQLiteRepository } from './sqlite.repository';
import { Agent } from '../../models/agent.model';
import { IRepository } from './base.repository';
import logger from '../../utils/logger';

/**
 * Repositorio para gestión de agentes
 */
export class AgentRepository implements IRepository<Agent> {
  private repository: IRepository<Agent>;

  constructor() {
    // Inicializar el repositorio SQLite con campo ID personalizado
    this.repository = new SQLiteRepository<Agent>('agents', 'id');
    logger.debug('AgentRepository inicializado con SQLite');
  }

  async create(data: Agent): Promise<Agent> {
    return this.repository.create(data);
  }

  async findById(id: string): Promise<Agent | null> {
    return this.repository.findById(id);
  }

  async findAll(filter?: Partial<Agent>): Promise<Agent[]> {
    return this.repository.findAll(filter);
  }

  async update(id: string, data: Partial<Agent>): Promise<Agent | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async findOne(filter: Partial<Agent>): Promise<Agent | null> {
    return this.repository.findOne(filter);
  }

  async count(filter?: Partial<Agent>): Promise<number> {
    return this.repository.count(filter);
  }

  /**
   * Buscar un agente por email
   */
  async findByEmail(email: string): Promise<Agent | null> {
    return this.repository.findOne({ email } as Partial<Agent>);
  }

  /**
   * Obtener agentes por estado
   */
  async findByStatus(status: string): Promise<Agent[]> {
    return this.repository.findAll({ status } as Partial<Agent>);
  }

  /**
   * Obtener agentes disponibles (online y no ocupados)
   */
  async findAvailableAgents(): Promise<Agent[]> {
    // Obtener todos los agentes y filtrar en memoria
    const agents = await this.repository.findAll();
    return agents.filter(agent => 
      agent.status === 'online' && 
      agent.activeConversations.length < agent.maxConcurrentChats
    );
  }
}