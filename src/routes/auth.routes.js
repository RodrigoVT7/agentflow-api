"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = __importDefault(require("../controllers/auth.controller"));
const router = (0, express_1.Router)();
// Rutas para autenticación
router.post('/register', auth_controller_1.default.registerAgent);
router.post('/login', auth_controller_1.default.login);
router.post('/refresh', auth_controller_1.default.refreshToken);
router.post('/logout', auth_controller_1.default.logout);
exports.default = router;
