import { Router } from 'express';
import agentController from '../controllers/agent.controller';
import { authMiddleware, roleMiddleware } from '../middleware/auth.middleware';
import config from '../config/app.config';
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

// New routes for editing and deleting agents (admin only)
router.put('/update/:agentId', authMiddleware, roleMiddleware(['admin']), agentController.updateAgent);
router.delete('/delete/:agentId', authMiddleware, roleMiddleware(['admin']), agentController.deleteAgent);

// Nueva ruta para obtener conversaciones completadas
router.get('/completed', authMiddleware, agentController.getCompletedConversations);

router.get('/system/health', async (req, res) => {
    try {
      // Probar conexión a DirectLine
      const response = await fetch(
        `${config.powerPlatform.baseUrl}${config.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`
      );
      
      const statusInfo = {
        directLineStatus: response.ok ? 'OK' : 'ERROR',
        directLineStatusCode: response.status,
        directLineMessage: response.ok ? 'Connected' : await response.text(),
        environment: process.env.NODE_ENV,
        configValues: {
          baseUrl: config.powerPlatform.baseUrl ? '✓ Configurado' : '✗ No configurado',
          botEndpoint: config.powerPlatform.botEndpoint ? '✓ Configurado' : '✗ No configurado',
          directlineUrl: config.directline.url ? '✓ Configurado' : '✗ No configurado',
          whatsappToken: config.whatsapp.token ? '✓ Configurado' : '✗ No configurado'
        },
        timestamp: new Date().toISOString()
      };
      
      res.json(statusInfo);
    } catch (error) {
      res.status(500).json({
        status: 'ERROR',
        message: error instanceof Error ? error.message : String(error),
        stack: process.env.NODE_ENV === 'production' ? null : error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
    }
  });

export default router;