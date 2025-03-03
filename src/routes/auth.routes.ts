import { Router } from 'express';
import authController from '../controllers/auth.controller';

const router = Router();

// Rutas para autenticación
router.post('/register', authController.registerAgent);
router.post('/login', authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

export default router;