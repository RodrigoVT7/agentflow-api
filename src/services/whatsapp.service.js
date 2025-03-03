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
exports.WhatsAppService = exports.WhatsAppMessageType = void 0;
// src/services/whatsapp.service.ts
const node_fetch_1 = __importDefault(require("node-fetch"));
// Use global AbortController (available in Node.js 16.0.0+)
const whatsapp_config_1 = __importDefault(require("../config/whatsapp.config"));
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Tipos de mensaje de WhatsApp soportados
 */
var WhatsAppMessageType;
(function (WhatsAppMessageType) {
    WhatsAppMessageType["TEXT"] = "text";
    WhatsAppMessageType["IMAGE"] = "image";
    WhatsAppMessageType["DOCUMENT"] = "document";
    WhatsAppMessageType["AUDIO"] = "audio";
    WhatsAppMessageType["VIDEO"] = "video";
    WhatsAppMessageType["STICKER"] = "sticker";
    WhatsAppMessageType["LOCATION"] = "location";
    WhatsAppMessageType["CONTACTS"] = "contacts";
    WhatsAppMessageType["INTERACTIVE"] = "interactive";
    WhatsAppMessageType["TEMPLATE"] = "template";
})(WhatsAppMessageType || (exports.WhatsAppMessageType = WhatsAppMessageType = {}));
/**
 * Servicio para interactuar con la API de WhatsApp
 */
class WhatsAppService {
    constructor() {
        this.token = whatsapp_config_1.default.token;
        this.graphApiBaseUrl = whatsapp_config_1.default.graphApiBaseUrl;
        this.graphApiVersion = whatsapp_config_1.default.graphApiVersion;
        if (!this.token) {
            logger_1.default.warn('WhatsApp token no configurado. La integración no funcionará');
        }
    }
    /**
     * Formatear número de teléfono
     * Asegura que el número tenga el formato correcto para WhatsApp
     */
    formatPhoneNumber(phoneNumber) {
        // Quitar cualquier carácter no numérico
        let cleaned = phoneNumber.replace(/\D/g, '');
        // Si empieza con 521, cambiarlo a 52
        if (cleaned.startsWith('521')) {
            cleaned = '52' + cleaned.substring(3);
        }
        return cleaned;
    }
    /**
     * Enviar mensaje de texto a WhatsApp
     */
    sendMessage(phone_number_id_1, recipient_1, text_1) {
        return __awaiter(this, arguments, void 0, function* (phone_number_id, recipient, text, preview_url = false) {
            try {
                const formattedRecipient = this.formatPhoneNumber(recipient);
                const message = {
                    messaging_product: "whatsapp",
                    to: formattedRecipient,
                    type: WhatsAppMessageType.TEXT,
                    text: {
                        body: text,
                        preview_url
                    }
                };
                return yield this.sendWhatsAppRequest(phone_number_id, message);
            }
            catch (error) {
                logger_1.default.error('Error al enviar mensaje de texto a WhatsApp', { error, recipient, text });
                return false;
            }
        });
    }
    /**
     * Enviar mensaje con plantilla a WhatsApp
     */
    sendTemplateMessage(phone_number_id_1, recipient_1, templateName_1) {
        return __awaiter(this, arguments, void 0, function* (phone_number_id, recipient, templateName, languageCode = 'es', components = []) {
            try {
                const formattedRecipient = this.formatPhoneNumber(recipient);
                const message = {
                    messaging_product: "whatsapp",
                    to: formattedRecipient,
                    type: WhatsAppMessageType.TEMPLATE,
                    template: {
                        name: templateName,
                        language: {
                            code: languageCode
                        }
                    }
                };
                if (components.length > 0) {
                    message.template.components = components;
                }
                return yield this.sendWhatsAppRequest(phone_number_id, message);
            }
            catch (error) {
                logger_1.default.error('Error al enviar mensaje de plantilla a WhatsApp', {
                    error, recipient, templateName
                });
                return false;
            }
        });
    }
    /**
     * Enviar mensaje interactivo con botones a WhatsApp
     */
    sendButtonMessage(phone_number_id, recipient, bodyText, buttons, headerText, footerText) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const formattedRecipient = this.formatPhoneNumber(recipient);
                const message = {
                    messaging_product: "whatsapp",
                    to: formattedRecipient,
                    type: WhatsAppMessageType.INTERACTIVE,
                    interactive: {
                        type: 'button',
                        body: {
                            text: bodyText
                        },
                        action: {
                            buttons: buttons.map(button => ({
                                type: 'reply',
                                reply: {
                                    id: button.id,
                                    title: button.title
                                }
                            }))
                        }
                    }
                };
                if (headerText) {
                    message.interactive.header = {
                        type: 'text',
                        text: headerText
                    };
                }
                if (footerText) {
                    message.interactive.footer = {
                        text: footerText
                    };
                }
                return yield this.sendWhatsAppRequest(phone_number_id, message);
            }
            catch (error) {
                logger_1.default.error('Error al enviar mensaje con botones a WhatsApp', {
                    error, recipient, bodyText, buttons
                });
                return false;
            }
        });
    }
    /**
     * Enviar mensaje con lista de opciones a WhatsApp
     */
    sendListMessage(phone_number_id, recipient, bodyText, buttonText, sections, headerText, footerText) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const formattedRecipient = this.formatPhoneNumber(recipient);
                const message = {
                    messaging_product: "whatsapp",
                    to: formattedRecipient,
                    type: WhatsAppMessageType.INTERACTIVE,
                    interactive: {
                        type: 'list',
                        body: {
                            text: bodyText
                        },
                        action: {
                            button: buttonText,
                            sections: sections.map(section => ({
                                title: section.title,
                                rows: section.items.map(item => ({
                                    id: item.id,
                                    title: item.title,
                                    description: item.description
                                }))
                            }))
                        }
                    }
                };
                if (headerText) {
                    message.interactive.header = {
                        type: 'text',
                        text: headerText
                    };
                }
                if (footerText) {
                    message.interactive.footer = {
                        text: footerText
                    };
                }
                return yield this.sendWhatsAppRequest(phone_number_id, message);
            }
            catch (error) {
                logger_1.default.error('Error al enviar mensaje con lista a WhatsApp', {
                    error, recipient, bodyText
                });
                return false;
            }
        });
    }
    /**
     * Enviar solicitud a la API de WhatsApp con manejo adecuado de timeout
     */
    sendWhatsAppRequest(phone_number_id, message) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            if (!this.token) {
                logger_1.default.error('No se puede enviar mensaje: Token de WhatsApp no configurado');
                return false;
            }
            const url = `${this.graphApiBaseUrl}/${this.graphApiVersion}/${phone_number_id}/messages`;
            let success = false;
            let retryCount = 0;
            const maxRetries = whatsapp_config_1.default.messageRetryAttempts;
            while (!success && retryCount < maxRetries) {
                try {
                    // Usar AbortController para manejar timeouts
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), whatsapp_config_1.default.messageTimeout);
                    const response = yield (0, node_fetch_1.default)(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(message),
                        signal: controller.signal
                    });
                    // Limpiar el timeout si la petición completa antes del timeout
                    clearTimeout(timeoutId);
                    if (!response.ok) {
                        const errorData = yield response.json();
                        throw new Error(`Error API WhatsApp: ${response.status} - ${JSON.stringify(errorData)}`);
                    }
                    const responseData = yield response.json();
                    logger_1.default.debug('Mensaje enviado a WhatsApp correctamente', {
                        phoneNumberId: phone_number_id,
                        recipient: message.to,
                        messageId: (_b = (_a = responseData.messages) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id
                    });
                    success = true;
                }
                catch (error) {
                    retryCount++;
                    const isAbortError = error.name === 'AbortError';
                    const logMessage = isAbortError
                        ? `Timeout al enviar mensaje después de ${whatsapp_config_1.default.messageTimeout}ms`
                        : 'Error al enviar mensaje a WhatsApp';
                    if (retryCount >= maxRetries) {
                        logger_1.default.error(`${logMessage} después de varios intentos`, {
                            error: isAbortError ? 'Timeout' : error,
                            phoneNumberId: phone_number_id,
                            recipient: message.to
                        });
                        return false;
                    }
                    logger_1.default.warn(`Reintentando envío de mensaje (${retryCount}/${maxRetries})`, {
                        error: isAbortError ? 'Timeout' : error,
                        phoneNumberId: phone_number_id
                    });
                    // Esperar antes de reintentar con backoff exponencial
                    yield new Promise(resolve => setTimeout(resolve, whatsapp_config_1.default.messageRetryDelay * Math.pow(2, retryCount - 1)));
                }
            }
            return success;
        });
    }
}
exports.WhatsAppService = WhatsAppService;
exports.default = WhatsAppService;
