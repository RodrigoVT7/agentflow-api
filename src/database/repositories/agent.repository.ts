// src/database/repositories/agent.repository.ts
import { MemoryRepository } from './memory.repository';
import { Agent } from '../../models/agent.model';
import { IRepository } from './base.repository';
import path from 'path';
import dbConfig, { DatabaseType } from '../../config/database.config';

/**
 * Repositorio para gestión de agentes
 */
export class AgentRepository implements IRepository<Agent> {
  private repository: IRepository<Agent>;

  constructor() {
    // Según el tipo de base de datos, inicializar el repositorio correspondiente
    switch (dbConfig.type) {
      case DatabaseType.MEMORY:
      default:
        // Usar repositorio en memoria con persistencia a archivo
        this.repository = new MemoryRepository<Agent>(
          'agents',
          path.join(__dirname, '../../../data/agents.json')
        );
        break;

      // Aquí se pueden añadir implementaciones para otros tipos de base de datos
    }
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
    // En una implementación real con SQL, esto sería una consulta más compleja
    const agents = await this.repository.findAll();
    return agents.filter(agent => 
      agent.status === 'online' && 
      agent.activeConversations.length < agent.maxConcurrentChats
    );
  }
}
