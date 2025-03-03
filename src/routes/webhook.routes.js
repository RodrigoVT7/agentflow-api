"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const webhook_controller_1 = __importDefault(require("../controllers/webhook.controller"));
const router = (0, express_1.Router)();
// Rutas para webhook de WhatsApp
router.get('/', webhook_controller_1.default.verifyWebhook);
router.post('/', webhook_controller_1.default.processWebhook);
exports.default = router;
