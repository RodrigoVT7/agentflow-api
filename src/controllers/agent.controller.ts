// src/controllers/agent.controller.ts
import { Request, Response, NextFunction } from 'express';
import { initQueueService } from '../services/queue.service';
import { initConversationService } from '../services/conversation.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { Agent, AgentStatus } from '../models/agent.model';
import { MessageSender } from '../models/message.model';
import { initAgentService } from '../services/agent.service';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';
import { ConversationStatus } from '../models/conversation.model';

// Servicios
const queueService = initQueueService();
const conversationService = initConversationService();
const whatsappService = new WhatsAppService();
const agentService = initAgentService();

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
      logger.error('Error en getQueue', { error });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al obtener la cola' });
      }
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
      
      const messages = await queueService.getMessages(chatId);
      res.json(messages);
    } catch (error) {
      logger.error('Error en getMessages', { error, chatId: req.params.chatId });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al obtener los mensajes' });
      }
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
      
      logger.debug(`Asignando agente ${agentId} a conversación ${conversationId}`);
      
      // Verificar que el agente existe
      const agent = agentService.getAgentById(agentId);
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
      const success = await queueService.assignAgent(conversationId, agentId);
      
      if (success) {
        // Actualizar estado del agente
        const agentWithPassword = agentService.getAgentWithPasswordById(agentId);
        if (agentWithPassword) {
          // Asegurarse de que la conversación no esté duplicada en activeConversations
          const existingConversations = agentWithPassword.activeConversations || [];
          const newConversations = existingConversations.includes(conversationId) 
            ? existingConversations 
            : [...existingConversations, conversationId];
          
          const updatedAgent = {
            ...agentWithPassword,
            activeConversations: newConversations,
            status: newConversations.length >= agentWithPassword.maxConcurrentChats 
              ? AgentStatus.BUSY 
              : AgentStatus.ONLINE,
            lastActivity: Date.now()
          };
          
          agentService.setAgent(updatedAgent);
        }
        
        // Responder éxito
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'No se pudo asignar el agente' });
      }
    } catch (error) {
      logger.error('Error en assignAgent', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al asignar agente' });
      }
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
    
    logger.debug(`Enviando mensaje: Agente ${agentId}, Conversación ${conversationId}`);
    
    // Verificar que el agente existe
    const agent = agentService.getAgentById(agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agente no encontrado' });
      return;
    }
    
    // Verificar que la conversación existe
    const conversation = queueService.getConversation(conversationId);
    logger.debug(`Conversación encontrada:`, { conversation: JSON.stringify(conversation) });
    
    if (!conversation) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    
    // Verificar que el agente está asignado a esta conversación
    logger.debug(`Agente asignado: ${conversation.assignedAgent}, Solicitado: ${agentId}`);
    
    if (conversation.assignedAgent !== agentId) {
      // Rechazar el envío de mensajes si el agente no está asignado
      res.status(403).json({ 
        error: 'No estás asignado a esta conversación. Debes asignarte primero.'
      });
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
    
    // Responder inmediatamente para evitar timeout
    res.json({ success: true, messageId: newMessage.id });
    
    // Enviar mensaje al usuario vía WhatsApp de forma asíncrona
    (async () => {
      try {
        // CORRECCIÓN: Usar phone_number_id como emisor y from (número de teléfono) como destinatario
        await whatsappService.sendMessage(
          conversation.phone_number_id,  // ID del número de WhatsApp Business
          conversation.from,  // Número del usuario destinatario (CORREGIDO)
          message
        );
        logger.info(`Mensaje ${newMessage.id} enviado correctamente a WhatsApp`);
      } catch (whatsappError) {
        logger.error(`Error al enviar mensaje ${newMessage.id} a WhatsApp:`, { error: whatsappError });
      }
      
      // Actualizar última actividad del agente...
    })().catch(error => {
      logger.error(`Error en procesamiento asíncrono después de sendMessage:`, { error });
    });
    
  } catch (error) {
    logger.error("Error en sendMessage:", { error, body: req.body });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
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
        const agent = agentService.getAgentWithPasswordById(agentId);
        if (agent) {
          const updatedAgent = {
            ...agent,
            activeConversations: agent.activeConversations.filter(id => id !== conversationId),
            status: agent.activeConversations.length <= 1 ? AgentStatus.ONLINE : AgentStatus.BUSY,
            lastActivity: Date.now()
          };
          
          agentService.setAgent(updatedAgent);
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
      logger.error('Error en completeConversation', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al completar conversación' });
      }
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
      
      const success = await queueService.updatePriority(conversationId, priority);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Conversación no encontrada' });
      }
    } catch (error) {
      logger.error('Error en updatePriority', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al actualizar prioridad' });
      }
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
      
      const success = await queueService.updateTags(conversationId, tags);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Conversación no encontrada' });
      }
    } catch (error) {
      logger.error('Error en updateTags', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al actualizar tags' });
      }
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
      
      const agent = agentService.getAgentWithPasswordById(agentId);
      
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
      const updatedAgent = {
        ...agent,
        status: status as AgentStatus,
        lastActivity: Date.now()
      };
      
      agentService.setAgent(updatedAgent);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error en updateAgentStatus', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al actualizar estado del agente' });
      }
    }
  };

  /**
   * Registrar un nuevo agente
   */
  public registerAgent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, email, password, role = 'agent', maxConcurrentChats = 3 } = req.body;
      
      if (!name || !email) {
        res.status(400).json({ error: 'Se requieren name y email' });
        return;
      }
      
      // Verificar si ya existe
      const existingAgent = agentService.getAgentByEmail(email);
      
      if (existingAgent) {
        res.status(409).json({ error: 'Ya existe un agente con este email' });
        return;
      }
      
      // Si no se proporcionó contraseña, redirigir a AuthController.registerAgent
      if (!password) {
        res.status(400).json({ error: 'Se requiere password para registrar un nuevo agente' });
        return;
      }
      
      // Si llegamos aquí, necesitamos la contraseña, así que importamos AuthController
      const AuthController = require('../controllers/auth.controller').default;
      return await AuthController.registerAgent(req, res, next);
    } catch (error) {
      logger.error('Error en registerAgent', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al registrar agente' });
      }
    }
  };

  /**
   * Obtener todos los agentes
   */
  public getAgents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agents = agentService.getAgents();
      res.json(agents);
    } catch (error) {
      logger.error('Error en getAgents', { error });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al obtener agentes' });
      }
    }
  };

  /**
   * Crear una conversación de prueba
   */
  public createTestConversation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { conversationId, from, phone_number_id, metadata } = req.body;
      
      if (!conversationId || !from || !phone_number_id) {
        res.status(400).json({ error: 'Se requieren conversationId, from y phone_number_id' });
        return;
      }
      
      // Añadir a la cola
      const queueItem = await queueService.addToQueue({
        conversationId,
        from,
        phone_number_id,
        assignedAgent: null,
        metadata: metadata || {}
      });
      
      res.status(201).json(queueItem);
    } catch (error) {
      logger.error('Error en createTestConversation', { error, body: req.body });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al crear conversación de prueba' });
      }
    }
  };

/**
 * Obtener conversaciones completadas
 */
public getCompletedConversations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const db = await initDatabaseConnection();
    
    // Get conversations with status COMPLETED
    const completedConversations = db.prepare(
      'SELECT * FROM conversations WHERE status = ? ORDER BY lastActivity DESC LIMIT 50'
    ).all(ConversationStatus.COMPLETED);
    
    // For each conversation, get associated messages
    const result = [];
    for (const conv of completedConversations) {
      const messages = db.prepare(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC'
      ).all(conv.conversationId);
      
      // Convert to expected format for client
      const queueItem = {
        conversationId: conv.conversationId,
        from: conv.from_number,
        phone_number_id: conv.phone_number_id,
        startTime: conv.startTime || (conv.lastActivity - (24 * 60 * 60 * 1000)),
        messages: messages.map((msg: any) => ({
          id: msg.id,
          conversationId: msg.conversationId,
          from: msg.from_type,
          text: msg.text,
          timestamp: msg.timestamp,
          agentId: msg.agentId || undefined,
          attachmentUrl: msg.attachmentUrl || undefined,
          metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined
        })),
        priority: 0,
        tags: [],
        assignedAgent: null,
        metadata: {
          isCompleted: true,
          completedAt: conv.lastActivity,
          completedTimestamp: conv.lastActivity,
          uniqueSessionId: conv.conversationId,
          sessionStartDate: new Date(conv.startTime || (conv.lastActivity - (24 * 60 * 60 * 1000))).toISOString().split('T')[0]
        }
      };
      
      result.push(queueItem);
    }
    
    res.json(result);
  } catch (error) {
    logger.error('Error in getCompletedConversations', { error });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error getting completed conversations' });
    }
  }
};
  
}

export default new AgentController();