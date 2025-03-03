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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const uuid_1 = require("uuid");
const agent_model_1 = require("../models/agent.model");
const app_config_1 = __importDefault(require("../config/app.config"));
const logger_1 = __importDefault(require("../utils/logger"));
// Almacén temporal de agentes (en producción debe usarse una base de datos)
const agentsDB = new Map();
// Almacén de tokens de refresco
const refreshTokens = new Map();
// Añadir algunos agentes de prueba
if (process.env.NODE_ENV !== 'production') {
    // Crear un hash para la contraseña "admin123"
    const createTestAgents = () => __awaiter(void 0, void 0, void 0, function* () {
        const hashedPassword = yield bcrypt_1.default.hash('admin123', 10);
        agentsDB.set('agent_test_1', {
            id: 'agent_test_1',
            name: 'Agente de Prueba',
            email: 'agent@test.com',
            password: hashedPassword,
            status: agent_model_1.AgentStatus.ONLINE,
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
            status: agent_model_1.AgentStatus.ONLINE,
            activeConversations: [],
            maxConcurrentChats: 5,
            role: 'admin',
            lastActivity: Date.now()
        });
        logger_1.default.info('Agentes de prueba creados');
    });
    createTestAgents();
}
class AuthController {
    constructor() {
        /**
         * Iniciar sesión de agente
         */
        this.login = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { email, password } = req.body;
                if (!email || !password) {
                    res.status(400).json({ error: 'Se requieren email y password' });
                    return;
                }
                // Buscar agente por email (en producción debería ser una consulta a la base de datos)
                const foundAgent = Array.from(agentsDB.values()).find(agent => agent.email === email);
                if (!foundAgent) {
                    res.status(401).json({ error: 'Credenciales inválidas' });
                    return;
                }
                // Verificar contraseña
                const isPasswordValid = yield bcrypt_1.default.compare(password, foundAgent.password);
                if (!isPasswordValid) {
                    res.status(401).json({ error: 'Credenciales inválidas' });
                    logger_1.default.warn(`Intento de inicio de sesión fallido para ${email}`);
                    return;
                }
                // Generar token JWT
                const token = jsonwebtoken_1.default.sign({
                    agentId: foundAgent.id,
                    email: foundAgent.email,
                    role: foundAgent.role
                }, app_config_1.default.auth.jwtSecret, { expiresIn: app_config_1.default.auth.jwtExpiresIn });
                // Generar token de refresco
                const refreshToken = (0, uuid_1.v4)();
                const refreshExpiresIn = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
                refreshTokens.set(refreshToken, {
                    agentId: foundAgent.id,
                    expiresAt: Date.now() + refreshExpiresIn
                });
                // Actualizar estado del agente
                const { password: _ } = foundAgent, agentWithoutPassword = __rest(foundAgent, ["password"]);
                agentWithoutPassword.status = agent_model_1.AgentStatus.ONLINE;
                agentWithoutPassword.lastActivity = Date.now();
                // Guardar agente actualizado
                agentsDB.set(foundAgent.id, Object.assign(Object.assign({}, foundAgent), { status: agent_model_1.AgentStatus.ONLINE, lastActivity: Date.now() }));
                logger_1.default.info(`Inicio de sesión exitoso para ${email}`);
                // Enviar respuesta
                const response = {
                    token,
                    agent: agentWithoutPassword,
                    expiresIn: parseInt(app_config_1.default.auth.jwtExpiresIn.replace(/\D/g, '')) * 1000 // convertir a milisegundos
                };
                // Enviar refresh token como cookie segura
                res.cookie('refreshToken', refreshToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    maxAge: refreshExpiresIn,
                    sameSite: 'strict'
                });
                res.json(response);
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Refrescar token JWT
         */
        this.refreshToken = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                // Obtener refresh token de la cookie o del cuerpo
                const refreshToken = ((_a = req.cookies) === null || _a === void 0 ? void 0 : _a.refreshToken) || ((_b = req.body) === null || _b === void 0 ? void 0 : _b.refreshToken);
                if (!refreshToken) {
                    res.status(400).json({ error: 'Se requiere token de refresco' });
                    return;
                }
                // Verificar si el refresh token existe y es válido
                const tokenData = refreshTokens.get(refreshToken);
                if (!tokenData || tokenData.expiresAt < Date.now()) {
                    refreshTokens.delete(refreshToken);
                    res.status(401).json({ error: 'Token de refresco inválido o expirado' });
                    return;
                }
                // Obtener agente
                const agent = agentsDB.get(tokenData.agentId);
                if (!agent) {
                    refreshTokens.delete(refreshToken);
                    res.status(404).json({ error: 'Agente no encontrado' });
                    return;
                }
                // Generar nuevo token JWT
                const token = jsonwebtoken_1.default.sign({
                    agentId: agent.id,
                    email: agent.email,
                    role: agent.role
                }, app_config_1.default.auth.jwtSecret, { expiresIn: app_config_1.default.auth.jwtExpiresIn });
                // Generar nuevo refresh token
                const newRefreshToken = (0, uuid_1.v4)();
                const refreshExpiresIn = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
                // Guardar nuevo refresh token
                refreshTokens.set(newRefreshToken, {
                    agentId: agent.id,
                    expiresAt: Date.now() + refreshExpiresIn
                });
                // Eliminar el refresh token anterior
                refreshTokens.delete(refreshToken);
                // Actualizar última actividad del agente
                const { password: _ } = agent, agentWithoutPassword = __rest(agent, ["password"]);
                // Enviar respuesta
                const response = {
                    token: token,
                    agent: agentWithoutPassword,
                    expiresIn: parseInt(app_config_1.default.auth.jwtExpiresIn.replace(/\D/g, '')) * 1000 // convertir a milisegundos
                };
                // Enviar nuevo refresh token como cookie segura
                res.cookie('refreshToken', newRefreshToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    maxAge: refreshExpiresIn,
                    sameSite: 'strict'
                });
                res.json(response);
                logger_1.default.info(`Token refrescado para ${agent.email}`);
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Cerrar sesión de agente
         */
        this.logout = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                // Obtener refresh token de la cookie o del cuerpo
                const refreshToken = ((_a = req.cookies) === null || _a === void 0 ? void 0 : _a.refreshToken) || ((_b = req.body) === null || _b === void 0 ? void 0 : _b.refreshToken);
                if (refreshToken) {
                    // Eliminar refresh token
                    refreshTokens.delete(refreshToken);
                }
                // Obtener agente del token (si está autenticado)
                if (req.agent) {
                    const agent = agentsDB.get(req.agent.id);
                    if (agent) {
                        // Actualizar estado del agente
                        agentsDB.set(agent.id, Object.assign(Object.assign({}, agent), { status: agent_model_1.AgentStatus.OFFLINE, lastActivity: Date.now() }));
                        logger_1.default.info(`Cierre de sesión para ${agent.email}`);
                    }
                }
                // Limpiar cookie
                res.clearCookie('refreshToken');
                res.json({ success: true, message: 'Sesión cerrada correctamente' });
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Registrar un nuevo agente (solo para administradores)
         */
        this.registerAgent = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                // En producción, verificar que el usuario es administrador
                // if (req.agent?.role !== 'admin') {
                //   res.status(403).json({ error: 'No autorizado para esta acción' });
                //   return;
                // }
                console.log('Método registerAgent ejecutándose');
                const { name, email, password, role = 'agent', maxConcurrentChats = 3 } = req.body;
                if (!name || !email || !password) {
                    res.status(400).json({ error: 'Se requieren name, email y password' });
                    return;
                }
                // Validar que el email no existe
                const existingAgent = Array.from(agentsDB.values()).find(agent => agent.email === email);
                if (existingAgent) {
                    res.status(409).json({ error: 'Ya existe un agente con este email' });
                    return;
                }
                // Validar rol
                if (!['agent', 'supervisor', 'admin'].includes(role)) {
                    res.status(400).json({ error: 'Rol inválido. Debe ser agent, supervisor o admin' });
                    return;
                }
                // Encriptar contraseña
                const hashedPassword = yield bcrypt_1.default.hash(password, 10);
                // Crear agente
                const newAgentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                const newAgent = {
                    id: newAgentId,
                    name,
                    email,
                    password: hashedPassword,
                    status: agent_model_1.AgentStatus.OFFLINE,
                    activeConversations: [],
                    maxConcurrentChats: maxConcurrentChats,
                    role: role,
                    lastActivity: Date.now()
                };
                // Guardar agente
                agentsDB.set(newAgentId, newAgent);
                // Enviar respuesta sin la contraseña
                const { password: _ } = newAgent, agentWithoutPassword = __rest(newAgent, ["password"]);
                logger_1.default.info(`Nuevo agente registrado: ${email}`);
                res.status(201).json(agentWithoutPassword);
            }
            catch (error) {
                next(error);
            }
        });
        /**
         * Cambiar contraseña
         */
        this.changePassword = (req, res, next) => __awaiter(this, void 0, void 0, function* () {
            try {
                if (!req.agent) {
                    res.status(401).json({ error: 'No autenticado' });
                    return;
                }
                const { currentPassword, newPassword } = req.body;
                if (!currentPassword || !newPassword) {
                    res.status(400).json({ error: 'Se requieren currentPassword y newPassword' });
                    return;
                }
                // Obtener agente
                const agent = agentsDB.get(req.agent.id);
                if (!agent) {
                    res.status(404).json({ error: 'Agente no encontrado' });
                    return;
                }
                // Verificar contraseña actual
                const isPasswordValid = yield bcrypt_1.default.compare(currentPassword, agent.password);
                if (!isPasswordValid) {
                    res.status(401).json({ error: 'Contraseña actual incorrecta' });
                    return;
                }
                // Encriptar nueva contraseña
                const hashedPassword = yield bcrypt_1.default.hash(newPassword, 10);
                // Actualizar contraseña
                agentsDB.set(agent.id, Object.assign(Object.assign({}, agent), { password: hashedPassword }));
                logger_1.default.info(`Contraseña cambiada para ${agent.email}`);
                res.json({ success: true, message: 'Contraseña actualizada correctamente' });
            }
            catch (error) {
                next(error);
            }
        });
    }
}
exports.AuthController = AuthController;
exports.default = new AuthController();
