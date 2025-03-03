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
exports.BotService = void 0;
exports.initBotService = initBotService;
// src/services/bot.service.ts
const node_fetch_1 = __importDefault(require("node-fetch"));
const ws_1 = __importDefault(require("ws"));
const directline_config_1 = __importDefault(require("../config/directline.config"));
const app_config_1 = __importDefault(require("../config/app.config"));
const logger_1 = __importDefault(require("../utils/logger"));
const events_1 = require("events");
class BotService {
    constructor() {
        this.directLineToken = null;
        this.tokenExpiration = 0;
        this.events = new events_1.EventEmitter();
        // Configurar renovación periódica del token
        if (directline_config_1.default.tokenRefreshMinutes > 0) {
            setInterval(() => {
                this.refreshDirectLineToken();
            }, directline_config_1.default.tokenRefreshMinutes * 60 * 1000);
        }
    }
    /**
     * Obtener un token de DirectLine, ya sea nuevo o el existente si es válido
     */
    getDirectLineToken() {
        return __awaiter(this, void 0, void 0, function* () {
            // Si ya tenemos un token válido, devolverlo
            if (this.directLineToken && Date.now() < this.tokenExpiration) {
                return this.directLineToken;
            }
            return this.refreshDirectLineToken();
        });
    }
    /**
     * Forzar la renovación del token de DirectLine
     */
    refreshDirectLineToken() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield (0, node_fetch_1.default)(`${app_config_1.default.powerPlatform.baseUrl}${app_config_1.default.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`);
                if (!response.ok) {
                    throw new Error(`Error al obtener token DirectLine: ${response.statusText}`);
                }
                const data = yield response.json();
                this.directLineToken = data.token || '';
                // Establecer expiración (30 minutos menos que lo indicado para renovar antes)
                const expiresIn = (data.expiresIn || 3600) - 1800;
                this.tokenExpiration = Date.now() + (expiresIn * 1000);
                logger_1.default.info('Token DirectLine renovado correctamente');
                if (!this.directLineToken) {
                    throw new Error('Token value is null');
                }
                return this.directLineToken;
            }
            catch (error) {
                logger_1.default.error('Error al renovar token DirectLine', { error });
                // Si hay un error y tenemos un token anterior, usarlo
                if (this.directLineToken) {
                    return this.directLineToken;
                }
                throw error;
            }
        });
    }
    /**
     * Crear una nueva conversación con el bot
     */
    createConversation() {
        return __awaiter(this, void 0, void 0, function* () {
            const token = yield this.getDirectLineToken();
            const response = yield (0, node_fetch_1.default)(`${directline_config_1.default.url}/conversations`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            if (!response.ok) {
                throw new Error(`Error al crear conversación DirectLine: ${response.statusText}`);
            }
            const conversation = yield response.json();
            logger_1.default.info(`Nueva conversación DirectLine creada: ${conversation.conversationId}`);
            return conversation;
        });
    }
    /**
     * Enviar mensaje al bot
     */
    sendMessageToBot(conversationId, from, text) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = yield this.getDirectLineToken();
            const activity = {
                type: 'message',
                from: { id: from },
                text: text
            };
            const response = yield (0, node_fetch_1.default)(`${directline_config_1.default.url}/conversations/${conversationId}/activities`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(activity)
            });
            if (!response.ok) {
                throw new Error(`Error al enviar mensaje a DirectLine: ${response.statusText}`);
            }
            logger_1.default.debug(`Mensaje enviado a bot en conversación ${conversationId}`, { from, text });
        });
    }
    /**
     * Configurar conexión WebSocket para recibir respuestas del bot
     */
    createWebSocketConnection(conversationId, token, onMessageReceived) {
        return __awaiter(this, void 0, void 0, function* () {
            // Preparar URL del WebSocket
            const streamUrl = directline_config_1.default.streamUrlPath.replace('{conversationId}', conversationId);
            const wsUrl = `wss://${directline_config_1.default.url.replace(/^https?:\/\//, '')}${streamUrl}?watermark=-1`;
            const wsConnection = new ws_1.default(wsUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            let reconnectAttempts = 0;
            wsConnection.on('open', () => {
                logger_1.default.info(`Conexión WebSocket establecida para conversación ${conversationId}`);
                reconnectAttempts = 0;
                this.events.emit(`ws:connected:${conversationId}`);
            });
            wsConnection.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.activities && message.activities.length > 0) {
                        message.activities.forEach((activity) => {
                            var _a;
                            if (((_a = activity.from) === null || _a === void 0 ? void 0 : _a.role) === 'bot' && activity.type === 'message') {
                                logger_1.default.debug(`Mensaje recibido del bot en conversación ${conversationId}`, {
                                    text: activity.text
                                });
                                onMessageReceived(activity);
                                this.events.emit(`message:${conversationId}`, activity);
                            }
                        });
                    }
                }
                catch (error) {
                    logger_1.default.error(`Error al procesar mensaje WebSocket para conversación ${conversationId}`, { error });
                }
            });
            wsConnection.on('error', (error) => {
                logger_1.default.error(`Error en WebSocket para conversación ${conversationId}`, { error });
                this.events.emit(`ws:error:${conversationId}`, error);
            });
            wsConnection.on('close', (code, reason) => {
                logger_1.default.warn(`Conexión WebSocket cerrada para conversación ${conversationId}`, { code, reason });
                this.events.emit(`ws:closed:${conversationId}`, { code, reason });
                // Intentar reconectar si no fue un cierre limpio
                if (code !== 1000 && reconnectAttempts < directline_config_1.default.reconnectAttempts) {
                    reconnectAttempts++;
                    const delay = directline_config_1.default.reconnectDelay * Math.pow(2, reconnectAttempts - 1);
                    logger_1.default.info(`Intentando reconectar WebSocket para conversación ${conversationId} en ${delay}ms (intento ${reconnectAttempts})`);
                    setTimeout(() => {
                        this.createWebSocketConnection(conversationId, token, onMessageReceived)
                            .then(newWs => {
                            this.events.emit(`ws:reconnected:${conversationId}`, newWs);
                        })
                            .catch(error => {
                            logger_1.default.error(`Error al reconectar WebSocket para conversación ${conversationId}`, { error });
                        });
                    }, delay);
                }
            });
            return wsConnection;
        });
    }
    /**
     * Suscribirse a eventos
     */
    on(event, listener) {
        this.events.on(event, listener);
    }
    /**
     * Cancelar suscripción a eventos
     */
    off(event, listener) {
        this.events.off(event, listener);
    }
}
exports.BotService = BotService;
// Instancia singleton
let botServiceInstance = null;
function initBotService() {
    if (!botServiceInstance) {
        botServiceInstance = new BotService();
    }
    return botServiceInstance;
}
exports.default = initBotService;
