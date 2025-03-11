// src/services/agent.service.ts
import { Agent, AgentStatus } from '../models/agent.model';
import bcrypt from 'bcrypt';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';

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
  public async setAgent(agent: Agent & { password: string }): Promise<void> {
    agentsDB.set(agent.id, agent);
    
    // Persistir en la base de datos SQLite
    try {
      const db = await initDatabaseConnection();
      
      // Convertir array a JSON string para almacenar
      const activeConversationsStr = JSON.stringify(agent.activeConversations);
      
      // Verificar si el agente ya existe
      const existingAgent = await db.get('SELECT id FROM agents WHERE id = ?', [agent.id]);
      
      if (existingAgent) {
        // Actualizar
        await db.run(
          `UPDATE agents SET 
            name = ?, 
            email = ?, 
            password = ?, 
            status = ?, 
            activeConversations = ?, 
            maxConcurrentChats = ?, 
            role = ?, 
            lastActivity = ?
          WHERE id = ?`,
          [
            agent.name, 
            agent.email, 
            agent.password, 
            agent.status, 
            activeConversationsStr, 
            agent.maxConcurrentChats, 
            agent.role, 
            agent.lastActivity, 
            agent.id
          ]
        );
      } else {
        // Insertar
        await db.run(
          `INSERT INTO agents
            (id, name, email, password, status, activeConversations, maxConcurrentChats, role, lastActivity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            agent.id, 
            agent.name, 
            agent.email, 
            agent.password, 
            agent.status, 
            activeConversationsStr, 
            agent.maxConcurrentChats, 
            agent.role, 
            agent.lastActivity
          ]
        );
      }
    } catch (error) {
      logger.error('Error al persistir agente en SQLite', { error, agentId: agent.id });
    }
  }

  // Eliminar agente
  public async deleteAgent(id: string): Promise<boolean> {
    const result = agentsDB.delete(id);
    
    // Eliminar de la base de datos
    try {
      const db = await initDatabaseConnection();
      await db.run('DELETE FROM agents WHERE id = ?', [id]);
    } catch (error) {
      logger.error('Error al eliminar agente de SQLite', { error, agentId: id });
    }
    
    return result;
  }

  // Cargar agentes desde SQLite
  public async loadAgentsFromDB(): Promise<void> {
    try {
      const db = await initDatabaseConnection();
      const dbAgents = await db.all('SELECT * FROM agents');
      
      if (dbAgents && dbAgents.length > 0) {
        // Limpiar mapa actual
        agentsDB.clear();
        
        // Cargar agentes desde la base de datos
        for (const dbAgent of dbAgents) {
          const agent: Agent & { password: string } = {
            id: dbAgent.id,
            name: dbAgent.name,
            email: dbAgent.email,
            password: dbAgent.password,
            status: dbAgent.status as AgentStatus,
            activeConversations: JSON.parse(dbAgent.activeConversations || '[]'),
            maxConcurrentChats: dbAgent.maxConcurrentChats,
            role: dbAgent.role as 'agent' | 'supervisor' | 'admin',
            lastActivity: dbAgent.lastActivity
          };
          
          agentsDB.set(agent.id, agent);
        }
        
        logger.info(`${dbAgents.length} agentes cargados desde SQLite`);
      } else {
        // Si no hay agentes, crear los predeterminados
        await this.initDefaultAgents();
      }
    } catch (error) {
      logger.error('Error al cargar agentes desde SQLite', { error });
      
      // Si hay error al cargar, inicializar con agentes predeterminados
      await this.initDefaultAgents();
    }
  }

  // Inicializar 5 agentes predeterminados
  public async initDefaultAgents(): Promise<void> {
    try {
      // Verificar si ya existen agentes
      const agents = Array.from(agentsDB.values());
      if (agents.length > 0) {
        logger.info(`Ya existen ${agents.length} agentes en el sistema`);
        return;
      }
      
      const hashedPassword = await bcrypt.hash('agent123', 10);
      const adminPassword = await bcrypt.hash('admin123', 10);
      
      // Crear 5 agentes predeterminados
      const defaultAgents = [
        {
          id: 'agent_1',
          name: 'Agente 1',
          email: 'agent1@example.com',
          password: hashedPassword,
          status: AgentStatus.ONLINE,
          activeConversations: [],
          maxConcurrentChats: 3,
          role: 'agent' as 'agent' | 'supervisor' | 'admin',
          lastActivity: Date.now()
        },
        {
          id: 'agent_2',
          name: 'Agente 2',
          email: 'agent2@example.com',
          password: hashedPassword,
          status: AgentStatus.ONLINE,
          activeConversations: [],
          maxConcurrentChats: 3,
          role: 'agent' as 'agent' | 'supervisor' | 'admin',
          lastActivity: Date.now()
        },
        {
          id: 'agent_3',
          name: 'Agente 3',
          email: 'agent3@example.com',
          password: hashedPassword,
          status: AgentStatus.ONLINE,
          activeConversations: [],
          maxConcurrentChats: 3,
          role: 'agent' as 'agent' | 'supervisor' | 'admin',
          lastActivity: Date.now()
        },
        {
          id: 'supervisor_1',
          name: 'Supervisor',
          email: 'supervisor@example.com',
          password: hashedPassword,
          status: AgentStatus.ONLINE,
          activeConversations: [],
          maxConcurrentChats: 5,
          role: 'supervisor' as 'agent' | 'supervisor' | 'admin',
          lastActivity: Date.now()
        },
        {
          id: 'admin_1',
          name: 'Administrador',
          email: 'admin@example.com',
          password: adminPassword,
          status: AgentStatus.ONLINE,
          activeConversations: [],
          maxConcurrentChats: 10,
          role: 'admin' as 'agent' | 'supervisor' | 'admin',
          lastActivity: Date.now()
        }
      ];
      
      // Registrar todos los agentes
      for (const agent of defaultAgents) {
        await this.setAgent(agent);
      }
      
      logger.info('5 agentes predeterminados creados correctamente');
    } catch (error) {
      logger.error('Error al crear agentes predeterminados', { error });
    }
  }
}

// Instancia singleton
let agentServiceInstance: AgentService | null = null;

export function initAgentService(): AgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new AgentService();
    // Cargar agentes desde la base de datos al iniciar
    agentServiceInstance.loadAgentsFromDB().catch(error => {
      logger.error('Error al inicializar agentes', { error });
    });
  }
  return agentServiceInstance;
}

export default initAgentService;