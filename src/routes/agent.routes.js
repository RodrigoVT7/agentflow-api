"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const agent_controller_1 = __importDefault(require("../controllers/agent.controller"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
// Rutas públicas para autenticación de agentes
router.post('/register', agent_controller_1.default.registerAgent);
// Rutas protegidas que requieren autenticación
router.get('/queue', auth_middleware_1.authMiddleware, agent_controller_1.default.getQueue);
router.get('/messages/:chatId', auth_middleware_1.authMiddleware, agent_controller_1.default.getMessages);
router.post('/assign', auth_middleware_1.authMiddleware, agent_controller_1.default.assignAgent);
router.post('/send', auth_middleware_1.authMiddleware, agent_controller_1.default.sendMessage);
router.post('/complete', auth_middleware_1.authMiddleware, agent_controller_1.default.completeConversation);
router.post('/priority', auth_middleware_1.authMiddleware, agent_controller_1.default.updatePriority);
router.post('/tags', auth_middleware_1.authMiddleware, agent_controller_1.default.updateTags);
router.post('/status', auth_middleware_1.authMiddleware, agent_controller_1.default.updateAgentStatus);
router.get('/list', auth_middleware_1.authMiddleware, agent_controller_1.default.getAgents);
exports.default = router;
