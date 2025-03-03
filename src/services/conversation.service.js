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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initConversationService = initConversationService;
// src/services/conversation.service.ts
const ws_1 = __importDefault(require("ws"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const conversation_model_1 = require("../models/conversation.model");
const whatsapp_service_1 = require("./whatsapp.service");
const queue_service_1 = require("./queue.service");
const message_model_1 = require("../models/message.model");
const app_config_1 = __importDefault(require("../config/app.config"));
class ConversationService {
    constructor() {
        this.queueService = (0, queue_service_1.initQueueService)();
        // Patrones para detectar escalamiento en mensajes del bot
        this.escalationPatterns = [
            "la remisión a un agente por chat",
            "te comunicaré con un agente",
            "hablar con un agente",
            "hablar con una persona",
            "hablar con alguien",
            "devolver llamada",
            "llamar al servicio"
        ];
        this.conversations = new Map();
        this.whatsappService = new whatsapp_service_1.WhatsAppService();
        // Iniciar limpieza periódica de conversaciones inactivas
        setInterval(() => this.cleanupInactiveConversations(), 15 * 60 * 1000);
    }
    /**
     * Obtener o crear una conversación para un usuario
     */
    getOrCreateConversation(from, phone_number_id) {
        return __awaiter(this, void 0, void 0, function* () {
            // Verificar si ya existe la conversación
            let conversation = this.conversations.get(from);
            if (!conversation) {
                // Crear una nueva conversación con DirectLine
                const directLineConversation = yield this.createDirectLineConversation();
                // Configurar WebSocket para recibir respuestas del bot
                const wsConnection = yield this.setupWebSocketConnection(directLineConversation.conversationId, directLineConversation.token, phone_number_id, from);
                // Crear nueva conversación
                conversation = {
                    conversationId: directLineConversation.conversationId,
                    token: directLineConversation.token,
                    wsConnection,
                    phone_number_id,
                    from,
                    isEscalated: false,
                    lastActivity: Date.now(),
                    status: conversation_model_1.ConversationStatus.BOT
                };
                this.conversations.set(from, conversation);
            }
            return conversation;
        });
    }
    /**
     * Crear una nueva conversación DirectLine
     */
    createDirectLineConversation() {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield (0, node_fetch_1.default)(`${app_config_1.default.directline.url}/conversations`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${yield this.getDirectLineToken()}`
                }
            });
            if (!response.ok) {
                throw new Error(`Error al crear conversación DirectLine: ${response.statusText}`);
            }
            return yield response.json();
        });
    }
    /**
     * Obtener token de DirectLine
     */
    getDirectLineToken() {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield (0, node_fetch_1.default)(`${app_config_1.default.powerPlatform.baseUrl}${app_config_1.default.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`);
            if (!response.ok) {
                throw new Error(`Error al obtener token DirectLine: ${response.statusText}`);
            }
            const data = yield response.json();
            return data.token;
        });
    }
    /**
     * Configurar conexión WebSocket para la conversación
     */
    setupWebSocketConnection(conversationId, token, phone_number_id, from) {
        return __awaiter(this, void 0, void 0, function* () {
            const wsConnection = new ws_1.default(`wss://directline.botframework.com/v3/directline/conversations/${conversationId}/stream?watermark=-1`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            wsConnection.on('message', (data) => __awaiter(this, void 0, void 0, function* () {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.activities && message.activities.length > 0) {
                        // Buscar respuesta del bot
                        const botResponse = message.activities.find((a) => {
                            var _a;
                            return ((_a = a.from) === null || _a === void 0 ? void 0 : _a.role) === 'bot' &&
                                a.type === 'message' &&
                                a.text;
                        });
                        if (botResponse && botResponse.text) {
                            // Verificar si es un mensaje de escalamiento
                            if (this.isEscalationMessage(botResponse.text)) {
                                yield this.handleEscalation(from, phone_number_id, botResponse.text);
                            }
                            else if (!this.isEscalated(from)) {
                                // Enviar respuesta normal si no está escalado
                                yield this.whatsappService.sendMessage(phone_number_id, from, botResponse.text);
                            }
                        }
                    }
                }
                catch (error) {
                    console.error('Error al procesar mensaje WebSocket:', error);
                }
            }));
            wsConnection.on('error', (error) => {
                console.error(`Error en WebSocket para conversación ${conversationId}:`, error);
            });
            return wsConnection;
        });
    }
    /**
     * Enviar mensaje a la conversación
     */
    sendMessage(from, phone_number_id, message) {
        return __awaiter(this, void 0, void 0, function* () {
            // Verificar si la conversación está escalada
            if (this.isEscalated(from)) {
                // Si está escalada, guardar el mensaje en la cola para el agente
                this.queueService.addMessage(from, {
                    from: message_model_1.MessageSender.USER,
                    text: message
                });
                return;
            }
            // Obtener o crear conversación
            const conversation = yield this.getOrCreateConversation(from, phone_number_id);
            // Actualizar tiempo de actividad
            conversation.lastActivity = Date.now();
            // Enviar mensaje al bot
            const response = yield (0, node_fetch_1.default)(`${app_config_1.default.directline.url}/conversations/${conversation.conversationId}/activities`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${conversation.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 'message',
                    from: { id: from },
                    text: message
                })
            });
            if (!response.ok) {
                throw new Error(`Error al enviar mensaje a DirectLine: ${response.statusText}`);
            }
        });
    }
    /**
     * Verificar si un mensaje indica que se debe escalar la conversación
     */
    isEscalationMessage(message) {
        const lowerMessage = message.toLowerCase();
        return this.escalationPatterns.some(phrase => lowerMessage.includes(phrase.toLowerCase()));
    }
    /**
     * Manejar el proceso de escalamiento
     */
    handleEscalation(from, phone_number_id, botMessage) {
        return __awaiter(this, void 0, void 0, function* () {
            // Actualizar estado de la conversación
            this.updateConversationStatus(from, true);
            // Enviar mensaje de confirmación al usuario
            const escalationMsg = "Tu conversación ha sido transferida a un agente. Pronto te atenderán.";
            yield this.whatsappService.sendMessage(phone_number_id, from, escalationMsg);
            // Añadir a la cola de agentes
            this.queueService.addToQueue({
                conversationId: from,
                from,
                phone_number_id,
                assignedAgent: null,
                metadata: {
                    escalationReason: botMessage
                }
            });
            // Añadir el mensaje del bot a la conversación en cola
            this.queueService.addMessage(from, {
                from: message_model_1.MessageSender.BOT,
                text: botMessage
            });
        });
    }
    /**
     * Verificar si una conversación está escalada
     */
    isEscalated(from) {
        const conversation = this.conversations.get(from);
        return conversation ? conversation.isEscalated : false;
    }
    /**
     * Actualizar estado de escalamiento de una conversación
     */
    updateConversationStatus(from, isEscalated) {
        const conversation = this.conversations.get(from);
        if (conversation) {
            conversation.isEscalated = isEscalated;
            conversation.status = isEscalated ? conversation_model_1.ConversationStatus.WAITING : conversation_model_1.ConversationStatus.BOT;
            conversation.lastActivity = Date.now();
        }
    }
    /**
     * Finalizar conversación con agente y volver al bot
     */
    completeAgentConversation(from) {
        return __awaiter(this, void 0, void 0, function* () {
            const conversation = this.conversations.get(from);
            if (!conversation) {
                return false;
            }
            // Actualizar estado
            conversation.isEscalated = false;
            conversation.status = conversation_model_1.ConversationStatus.BOT;
            conversation.lastActivity = Date.now();
            // Eliminar de la cola de agentes
            const completed = this.queueService.completeConversation(from);
            // Enviar mensaje de finalización
            if (yield completed) {
                yield this.whatsappService.sendMessage(conversation.phone_number_id, from, "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?");
            }
            return completed;
        });
    }
    /**
     * Limpiar conversaciones inactivas
     */
    cleanupInactiveConversations() {
        const INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
        for (const [from, conversation] of this.conversations.entries()) {
            if (Date.now() - conversation.lastActivity > INACTIVE_TIMEOUT) {
                // Cerrar WebSocket si existe
                if (conversation.wsConnection) {
                    try {
                        conversation.wsConnection.close();
                    }
                    catch (error) {
                        console.error(`Error al cerrar WebSocket para ${from}:`, error);
                    }
                }
                // Eliminar conversación
                this.conversations.delete(from);
                // Si estaba escalada, eliminar de la cola de agentes
                if (conversation.isEscalated) {
                    this.queueService.completeConversation(from);
                }
                console.log(`Conversación inactiva eliminada: ${from}`);
            }
        }
    }
}
// Singleton
let conversationServiceInstance = null;
function initConversationService() {
    if (!conversationServiceInstance) {
        conversationServiceInstance = new ConversationService();
    }
    return conversationServiceInstance;
}
exports.default = initConversationService;
