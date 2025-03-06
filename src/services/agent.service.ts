// src/services/agent.service.ts
import { Agent, AgentStatus } from '../models/agent.model';
import bcrypt from 'bcrypt';
import logger from '../utils/logger';

// Almacén compartido de agentes
const agentsDB = new Map<string, Agent & { password: string }>();

export class AgentService {
  // Obtener todos los agentes
  public getAgents(): Agent[] {
    return Array.from(agentsDB.values()).map(({ password, ...agent }) => agent);
  }

  // Obtener agente por ID
  public getAgentById(id: string): Agent | null {
    const agent = agentsDB.get(id);
    if (!agent) return null;
    
    const { password, ...agentWithoutPassword } = agent;
    return agentWithoutPassword;
  }

  // Obtener agente con contraseña por ID (para autenticación)
  public getAgentWithPasswordById(id: string): (Agent & { password: string }) | null {
    return agentsDB.get(id) || null;
  }

  // Obtener agente por email
  public getAgentByEmail(email: string): Agent | null {
    const agent = Array.from(agentsDB.values()).find(a => a.email === email);
    if (!agent) return null;
    
    const { password, ...agentWithoutPassword } = agent;
    return agentWithoutPassword;
  }

  // Obtener agente con contraseña por email (para autenticación)
  public getAgentWithPasswordByEmail(email: string): (Agent & { password: string }) | null {
    return Array.from(agentsDB.values()).find(a => a.email === email) || null;
  }

  // Crear o actualizar agente
  public setAgent(agent: Agent & { password: string }): void {
    agentsDB.set(agent.id, agent);
  }

  // Eliminar agente
  public deleteAgent(id: string): boolean {
    return agentsDB.delete(id);
  }

  // Inicializar agentes de prueba
  public async initTestAgents(): Promise<void> {
    if (process.env.NODE_ENV === 'production') return;

    try {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      
      agentsDB.set('agent_test_1', {
        id: 'agent_test_1',
        name: 'Agente de Prueba',
        email: 'agent@test.com',
        password: hashedPassword,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats: 3,
        role: 'agent',
        lastActivity: Date.now()
      });
      
      agentsDB.set('admin_test_1', {
        id: 'admin_test_1',
        name: 'Administrador',
        email: 'admin@test.com',
        password: hashedPassword,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats: 5,
        role: 'admin',
        lastActivity: Date.now()
      });
      
      logger.info('Agentes de prueba creados');
    } catch (error) {
      logger.error('Error al crear agentes de prueba', { error });
    }
  }
}

// Instancia singleton
let agentServiceInstance: AgentService | null = null;

export function initAgentService(): AgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new AgentService();
    // Inicializar agentes de prueba
    agentServiceInstance.initTestAgents();
  }
  return agentServiceInstance;
}

export default initAgentService;