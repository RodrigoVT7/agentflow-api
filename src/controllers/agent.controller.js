"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentController = void 0;
const queue_service_1 = require("../services/queue.service");
const conversation_service_1 = require("../services/conversation.service");
const whatsapp_service_1 = require("../services/whatsapp.service");
const agent_model_1 = require("../models/agent.model");
// Servicios
const queueService = (0, queue_service_1.initQueueService)();
const conversationService = (0, conversation_service_1.initConversationService)();
const whatsappService = new whatsapp_service_1.WhatsAppService();
// Mock de base de datos de agentes (en producción debería estar en una DB)
const agentsDB = new Map();
class AgentController {
    constructor() {
        /**
         * Obtener lista de conversaciones en cola
         */
        this.getQueue = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Obtener mensajes de una conversación específica
         */
        this.getMessages = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                const chatId = req.params.chatId;
                const conversation = queueService.getConversation(chatId);
                if (!conversation) {
                    res.status(404).json({ error: 'Conversación no encontrada' });
                    return;
                }
                res.json(queueService.getMessages(chatId));
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Asignar agente a una conversación
         */
        this.assignAgent = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
                if (yield success) {
                    // Actualizar estado del agente
                    agent.activeConversations.push(conversationId);
                    agent.status = agent.activeConversations.length >= agent.maxConcurrentChats
                        ? agent_model_1.AgentStatus.BUSY
                        : agent_model_1.AgentStatus.ONLINE;
                    agentsDB.set(agentId, agent);
                    res.json({ success: true });
                }
                else {
                    res.status(500).json({ error: 'No se pudo asignar el agente' });
                }
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Enviar mensaje desde un agente
         */
        this.sendMessage = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
                const newMessage = yield queueService.addMessage(conversationId, {
                    from: 'agent',
                    text: message,
                    agentId
                });
                if (!newMessage) {
                    res.status(500).json({ error: 'No se pudo añadir el mensaje' });
                    return;
                }
                // Enviar mensaje al usuario vía WhatsApp
                yield whatsappService.sendMessage(conversation.phone_number_id, conversationId, message);
                // Actualizar última actividad del agente
                agent.lastActivity = Date.now();
                agentsDB.set(agentId, agent);
                res.json({ success: true, messageId: newMessage.id });
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Finalizar conversación y devolver al bot
         */
        this.completeConversation = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
                        agent.status = agent.activeConversations.length === 0 ? agent_model_1.AgentStatus.ONLINE : agent_model_1.AgentStatus.BUSY;
                        agent.lastActivity = Date.now();
                        agentsDB.set(agentId, agent);
                    }
                }
                // Finalizar conversación
                const completed = yield conversationService.completeAgentConversation(conversationId);
                if (completed) {
                    res.json({ success: true });
                }
                else {
                    res.status(500).json({ error: 'No se pudo finalizar la conversación' });
                }
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Actualizar prioridad de una conversación
         */
        this.updatePriority = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { conversationId, priority } = req.body;
                if (!conversationId || priority === undefined) {
                    res.status(400).json({ error: 'Se requieren conversationId y priority' });
                    return;
                }
                const success = queueService.updatePriority(conversationId, priority);
                if (yield success) {
                    res.json({ success: true });
                }
                else {
                    res.status(404).json({ error: 'Conversación no encontrada' });
                }
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Actualizar tags de una conversación
         */
        this.updateTags = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { conversationId, tags } = req.body;
                if (!conversationId || !Array.isArray(tags)) {
                    res.status(400).json({ error: 'Se requieren conversationId y tags (array)' });
                    return;
                }
                const success = queueService.updateTags(conversationId, tags);
                if (yield success) {
                    res.json({ success: true });
                }
                else {
                    res.status(404).json({ error: 'Conversación no encontrada' });
                }
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Actualizar estado de un agente
         */
        this.updateAgentStatus = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
                if (!Object.values(agent_model_1.AgentStatus).includes(status)) {
                    res.status(400).json({ error: 'Estado no válido' });
                    return;
                }
                // Actualizar estado
                agent.status = status;
                agent.lastActivity = Date.now();
                agentsDB.set(agentId, agent);
                res.json({ success: true });
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Registrar un nuevo agente
         */
        this.registerAgent = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
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
                const newAgent = {
                    id: `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    name,
                    email,
                    status: agent_model_1.AgentStatus.ONLINE,
                    activeConversations: [],
                    maxConcurrentChats,
                    role: role,
                    lastActivity: Date.now()
                };
                agentsDB.set(newAgent.id, newAgent);
                res.status(201).json(newAgent);
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Obtener todos los agentes
         */
        this.getAgents = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                const agents = Array.from(agentsDB.values());
                res.json(agents);
            }
            catch (error) {
                next(error);
            }
        });
    }
}
exports.AgentController = AgentController;
exports.default = new AgentController();
