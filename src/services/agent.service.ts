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
      const existingAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id);
      
      if (existingAgent) {
        // Actualizar
        db.prepare(
          `UPDATE agents SET 
            name = ?, 
            email = ?, 
            password = ?, 
            status = ?, 
            activeConversations = ?, 
            maxConcurrentChats = ?, 
            role = ?, 
            lastActivity = ?
          WHERE id = ?`
        ).run(
          agent.name, 
          agent.email, 
          agent.password, 
          agent.status, 
          activeConversationsStr, 
          agent.maxConcurrentChats, 
          agent.role, 
          agent.lastActivity, 
          agent.id
        );
      } else {
        // Insertar
        db.prepare(
          `INSERT INTO agents
            (id, name, email, password, status, activeConversations, maxConcurrentChats, role, lastActivity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          agent.id, 
          agent.name, 
          agent.email, 
          agent.password, 
          agent.status, 
          activeConversationsStr, 
          agent.maxConcurrentChats, 
          agent.role, 
          agent.lastActivity
        );
      }
    } catch (error) {
      logger.error('Error al persistir agente en SQLite', { error, agentId: agent.id });
    }
  }

  // Eliminar agente
  public async deleteAgent(id: string): Promise<boolean> {
    const result = agentsDB.delete(id);
    
    // Delete from database
    try {
      const db = await initDatabaseConnection();
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    } catch (error) {
      logger.error('Error deleting agent from SQLite', { error, agentId: id });
    }
    
    return result;
  }

  public async loadAgentsFromDB(): Promise<void> {
    try {
      const db = await initDatabaseConnection();
      // better-sqlite3 uses .all() synchronously
      const dbAgents = db.prepare('SELECT * FROM agents').all();
      
      if (dbAgents && dbAgents.length > 0) {
        // Clear current map
        agentsDB.clear();
        
        // Load agents from database
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
        
        logger.info(`${dbAgents.length} agents loaded from SQLite`);
      } else {
        // If no agents, create default ones
        await this.initDefaultAgents();
      }
    } catch (error) {
      logger.error('Error loading agents from SQLite', { error });
      
      // If error loading, initialize with default agents
      await this.initDefaultAgents();
    }
  }

// src/services/agent.service.ts
public async initDefaultAgents(): Promise<void> {
  try {
    // Verify if agents already exist
    const agents = Array.from(agentsDB.values());
    if (agents.length > 0) {
      logger.info(`Already have ${agents.length} agents in the system`);
      return;
    }
    
    const hashedPassword = await bcrypt.hash('agent123', 10);
    const adminPassword = await bcrypt.hash('admin123', 10);
    
    // Create the database connection
    const db = await initDatabaseConnection();
    
    // Begin a transaction for all inserts
    const transaction = db.transaction((defaultAgents: any) => {
      const insertStmt = db.prepare(`
        INSERT INTO agents
        (id, name, email, password, status, activeConversations, maxConcurrentChats, role, lastActivity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const agent of defaultAgents) {
        // Convert array to string for SQLite storage
        const activeConversationsStr = JSON.stringify(agent.activeConversations);
        
        insertStmt.run(
          agent.id,
          agent.name,
          agent.email,
          agent.password,
          agent.status,
          activeConversationsStr,
          agent.maxConcurrentChats,
          agent.role,
          agent.lastActivity
        );
        
        // Also add to memory map
        agentsDB.set(agent.id, agent);
      }
    });
    
    // Create default agents array
    const defaultAgents = [
      {
        id: 'agent',
        name: 'Agente',
        email: 'agent@metrobot.com',
        password: hashedPassword,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats: 3,
        role: 'agent' as 'agent' | 'supervisor' | 'admin',
        lastActivity: Date.now()
      },
      {
        id: 'supervisor',
        name: 'Supervisor',
        email: 'supervisor@metrobot.com',
        password: hashedPassword,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats: 5,
        role: 'supervisor' as 'agent' | 'supervisor' | 'admin',
        lastActivity: Date.now()
      },
      {
        id: 'admin',
        name: 'Administrador',
        email: 'admin@metrobot.com',
        password: adminPassword,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats: 10,
        role: 'admin' as 'agent' | 'supervisor' | 'admin',
        lastActivity: Date.now()
      }
    ];
    
    // Execute the transaction with our agents array
    transaction(defaultAgents);
    
    logger.info('5 default agents created successfully');
  } catch (error) {
    // More detailed error logging
    logger.error('Error creating default agents', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
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