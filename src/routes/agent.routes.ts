import { Router } from 'express';
import agentController from '../controllers/agent.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Rutas públicas para autenticación de agentes
router.post('/register', agentController.registerAgent);

// Rutas protegidas que requieren autenticación
router.get('/queue', authMiddleware, agentController.getQueue);
router.get('/messages/:chatId', authMiddleware, agentController.getMessages);
router.post('/assign', authMiddleware, agentController.assignAgent);
router.post('/send', authMiddleware, agentController.sendMessage);
router.post('/complete', authMiddleware, agentController.completeConversation);
router.post('/priority', authMiddleware, agentController.updatePriority);
router.post('/tags', authMiddleware, agentController.updateTags);
router.post('/status', authMiddleware, agentController.updateAgentStatus);
router.get('/list', authMiddleware, agentController.getAgents);

// Nueva ruta para obtener conversaciones completadas
router.get('/completed', authMiddleware, agentController.getCompletedConversations);

export default router;
