// src/controllers/agent.controller.ts
import { Request, Response, NextFunction } from 'express';
import { initQueueService } from '../services/queue.service';
import { initConversationService } from '../services/conversation.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { Agent, AgentStatus } from '../models/agent.model';
import { MessageSender } from '../models/message.model';

// Servicios
const queueService = initQueueService();
const conversationService = initConversationService();
const whatsappService = new WhatsAppService();

// Mock de base de datos de agentes (en producción debería estar en una DB)
const agentsDB = new Map<string, Agent>();

export class AgentController {
  /**
   * Obtener lista de conversaciones en cola
   */
  public getQueue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const queueData = queueService.getQueue().map(item => ({
        id: item.conversationId,
        waitTime: Math.floor((Date.now() - item.startTime) / 1000), // segundos en espera
        messageCount: item.messages.length,
        assignedAgent: item.assignedAgent,
        priority: item.priority,
        tags: item.tags
      }));
      
      res.json(queueData);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Obtener mensajes de una conversación específica
   */
  public getMessages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const chatId = req.params.chatId;
      
      const conversation = queueService.getConversation(chatId);
      
      if (!conversation) {
        res.status(404).json({ error: 'Conversación no encontrada' });
        return;
      }
      
      res.json(queueService.getMessages(chatId));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Asignar agente a una conversación
   */
  public assignAgent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { agentId, conversationId } = req.body;
      
      if (!agentId || !conversationId) {
        res.status(400).json({ error: 'Se requieren agentId y conversationId' });
        return;
      }
      
      // Verificar que el agente existe
      const agent = agentsDB.get(agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agente no encontrado' });
        return;
      }
      
      // Verificar que la conversación existe
      const conversation = queueService.getConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversación no encontrada' });
        return;
      }
      
      // Verificar si ya está asignada a otro agente
      if (conversation.assignedAgent && conversation.assignedAgent !== agentId) {
        res.status(403).json({ error: 'Conversación ya asignada a otro agente' });
        return;
      }
      
      // Asignar agente
      const success = queueService.assignAgent(conversationId, agentId);
      
      if (await success) {
        // Actualizar estado del agente
        agent.activeConversations.push(conversationId);
        agent.status = agent.activeConversations.length >= agent.maxConcurrentChats 
          ? AgentStatus.BUSY 
          : AgentStatus.ONLINE;
        
        agentsDB.set(agentId, agent);
        
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'No se pudo asignar el agente' });
      }
    } catch (error) {
      next(error);
    }
  };

  /**
   * Enviar mensaje desde un agente
   */
  public sendMessage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { agentId, conversationId, message } = req.body;
      
      if (!agentId || !conversationId || !message) {
        res.status(400).json({ error: 'Se requieren agentId, conversationId y message' });
        return;
      }
      
      // Verificar que el agente existe
      const agent = agentsDB.get(agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agente no encontrado' });
        return;
      }
      
      // Verificar que la conversación existe
      const conversation = queueService.getConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversación no encontrada' });
        return;
      }
      
      // Verificar que el agente está asignado a esta conversación
      if (conversation.assignedAgent !== agentId) {
        res.status(403).json({ error: 'El agente no está asignado a esta conversación' });
        return;
      }
      
      // Añadir mensaje a la conversación
      const newMessage = await queueService.addMessage(conversationId, {
        from: 'agent' as MessageSender,
        text: message,
        agentId
      });
      
      if (!newMessage) {
        res.status(500).json({ error: 'No se pudo añadir el mensaje' });
        return;
      }
      
      // Enviar mensaje al usuario vía WhatsApp
      await whatsappService.sendMessage(
        conversation.phone_number_id,
        conversationId,
        message
      );
      
      // Actualizar última actividad del agente
      agent.lastActivity = Date.now();
      agentsDB.set(agentId, agent);
      
      res.json({ success: true, messageId: newMessage.id });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Finalizar conversación y devolver al bot
   */
  public completeConversation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { conversationId, agentId } = req.body;
      
      if (!conversationId) {
        res.status(400).json({ error: 'Se requiere conversationId' });
        return;
      }
      
      // Si se proporciona agentId, verificar que el agente está asignado
      if (agentId) {
        const conversation = queueService.getConversation(conversationId);
        if (conversation && conversation.assignedAgent !== agentId) {
          res.status(403).json({ error: 'El agente no está asignado a esta conversación' });
          return;
        }
        
        // Actualizar estado del agente
        const agent = agentsDB.get(agentId);
        if (agent) {
          agent.activeConversations = agent.activeConversations.filter(id => id !== conversationId);
          agent.status = agent.activeConversations.length === 0 ? AgentStatus.ONLINE : AgentStatus.BUSY;
          agent.lastActivity = Date.now();
          agentsDB.set(agentId, agent);
        }
      }
      
      // Finalizar conversación
      const completed = await conversationService.completeAgentConversation(conversationId);
      
      if (completed) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'No se pudo finalizar la conversación' });
      }
    } catch (error) {
      next(error);
    }
  };

  /**
   * Actualizar prioridad de una conversación
   */
  public updatePriority = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { conversationId, priority } = req.body;
      
      if (!conversationId || priority === undefined) {
        res.status(400).json({ error: 'Se requieren conversationId y priority' });
        return;
      }
      
      const success = queueService.updatePriority(conversationId, priority);
      
      if (await success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Conversación no encontrada' });
      }
    } catch (error) {
      next(error);
    }
  };

  /**
   * Actualizar tags de una conversación
   */
  public updateTags = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { conversationId, tags } = req.body;
      
      if (!conversationId || !Array.isArray(tags)) {
        res.status(400).json({ error: 'Se requieren conversationId y tags (array)' });
        return;
      }
      
      const success = queueService.updateTags(conversationId, tags);
      
      if (await success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Conversación no encontrada' });
      }
    } catch (error) {
      next(error);
    }
  };

  /**
   * Actualizar estado de un agente
   */
  public updateAgentStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { agentId, status } = req.body;
      
      if (!agentId || !status) {
        res.status(400).json({ error: 'Se requieren agentId y status' });
        return;
      }
      
      const agent = agentsDB.get(agentId);
      
      if (!agent) {
        res.status(404).json({ error: 'Agente no encontrado' });
        return;
      }
      
      // Validar estado
      if (!Object.values(AgentStatus).includes(status as AgentStatus)) {
        res.status(400).json({ error: 'Estado no válido' });
        return;
      }
      
      // Actualizar estado
      agent.status = status as AgentStatus;
      agent.lastActivity = Date.now();
      
      agentsDB.set(agentId, agent);
      
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Registrar un nuevo agente
   */
  public registerAgent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, email, role = 'agent', maxConcurrentChats = 3 } = req.body;
      
      if (!name || !email) {
        res.status(400).json({ error: 'Se requieren name y email' });
        return;
      }
      
      // Verificar si ya existe
      const existingAgents = Array.from(agentsDB.values());
      const existingAgent = existingAgents.find(a => a.email === email);
      
      if (existingAgent) {
        res.status(409).json({ error: 'Ya existe un agente con este email' });
        return;
      }
      
      // Crear nuevo agente
      const newAgent: Agent = {
        id: `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name,
        email,
        status: AgentStatus.ONLINE,
        activeConversations: [],
        maxConcurrentChats,
        role: role as 'agent' | 'supervisor' | 'admin',
        lastActivity: Date.now()
      };
      
      agentsDB.set(newAgent.id, newAgent);
      
      res.status(201).json(newAgent);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Obtener todos los agentes
   */
  public getAgents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agents = Array.from(agentsDB.values());
      res.json(agents);
    } catch (error) {
      next(error);
    }
  };
}

export default new AgentController();