import { Router } from 'express';
import webhookController from '../controllers/webhook.controller';

const router = Router();

// Rutas para webhook de WhatsApp
router.get('/', webhookController.verifyWebhook);
router.post('/', webhookController.processWebhook);

export default router;