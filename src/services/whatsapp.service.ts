// src/services/whatsapp.service.ts
import fetch from 'node-fetch';
// Use global AbortController (available in Node.js 16.0.0+)
import whatsappConfig from '../config/whatsapp.config';
import logger from '../utils/logger';

/**
 * Tipos de mensaje de WhatsApp soportados
 */
export enum WhatsAppMessageType {
  TEXT = 'text',
  IMAGE = 'image',
  DOCUMENT = 'document',
  AUDIO = 'audio',
  VIDEO = 'video',
  STICKER = 'sticker',
  LOCATION = 'location',
  CONTACTS = 'contacts',
  INTERACTIVE = 'interactive',
  TEMPLATE = 'template'
}

/**
 * Interfaz para mensajes de texto
 */
interface TextMessage {
  messaging_product: string;
  recipient_type?: string;
  to: string;
  type: WhatsAppMessageType.TEXT;
  text: {
    body: string;
    preview_url?: boolean;
  };
}

/**
 * Interfaz para mensajes con plantilla
 */
interface TemplateMessage {
  messaging_product: string;
  recipient_type?: string;
  to: string;
  type: WhatsAppMessageType.TEMPLATE;
  template: {
    name: string;
    language: {
      code: string;
    };
    components?: Array<{
      type: string;
      parameters: Array<any>;
    }>;
  };
}

/**
 * Interfaz para mensajes interactivos (botones)
 */
interface InteractiveMessage {
  messaging_product: string;
  recipient_type?: string;
  to: string;
  type: WhatsAppMessageType.INTERACTIVE;
  interactive: {
    type: 'button' | 'list';
    header?: {
      type: 'text' | 'image' | 'document' | 'video';
      text?: string;
      image?: { link: string };
      document?: { link: string };
      video?: { link: string };
    };
    body: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: {
      buttons?: Array<{
        type: 'reply';
        reply: {
          id: string;
          title: string;
        };
      }>;
      button?: string;
      sections?: Array<{
        title?: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
    };
  };
}

/**
 * Tipo para cualquier mensaje de WhatsApp soportado
 */
type WhatsAppMessage = TextMessage | TemplateMessage | InteractiveMessage;

/**
 * Servicio para interactuar con la API de WhatsApp
 */
export class WhatsAppService {
  private token: string;
  private graphApiBaseUrl: string;
  private graphApiVersion: string;
  
  constructor() {
    this.token = whatsappConfig.token;
    this.graphApiBaseUrl = whatsappConfig.graphApiBaseUrl;
    this.graphApiVersion = whatsappConfig.graphApiVersion;
    
    if (!this.token) {
      logger.warn('WhatsApp token no configurado. La integración no funcionará');
    }
  }

  /**
   * Formatear número de teléfono
   * Asegura que el número tenga el formato correcto para WhatsApp
   */
  private formatPhoneNumber(phoneNumber: string): string {
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
  public async sendMessage(
    phone_number_id: string,
    recipient: string,
    text: string,
    preview_url: boolean = false
  ): Promise<boolean> {
    try {
      const formattedRecipient = this.formatPhoneNumber(recipient);
      
      const message: TextMessage = {
        messaging_product: "whatsapp",
        to: formattedRecipient,
        type: WhatsAppMessageType.TEXT,
        text: {
          body: text,
          preview_url
        }
      };
      
      return await this.sendWhatsAppRequest(phone_number_id, message);
    } catch (error) {
      logger.error('Error al enviar mensaje de texto a WhatsApp', { error, recipient, text });
      return false;
    }
  }

  /**
   * Enviar mensaje con plantilla a WhatsApp
   */
  public async sendTemplateMessage(
    phone_number_id: string,
    recipient: string,
    templateName: string,
    languageCode: string = 'es',
    components: Array<any> = []
  ): Promise<boolean> {
    try {
      const formattedRecipient = this.formatPhoneNumber(recipient);
      
      const message: TemplateMessage = {
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
      
      return await this.sendWhatsAppRequest(phone_number_id, message);
    } catch (error) {
      logger.error('Error al enviar mensaje de plantilla a WhatsApp', { 
        error, recipient, templateName 
      });
      return false;
    }
  }

  /**
   * Enviar mensaje interactivo con botones a WhatsApp
   */
  public async sendButtonMessage(
    phone_number_id: string,
    recipient: string,
    bodyText: string,
    buttons: Array<{ id: string, title: string }>,
    headerText?: string,
    footerText?: string
  ): Promise<boolean> {
    try {
      const formattedRecipient = this.formatPhoneNumber(recipient);
      
      const message: InteractiveMessage = {
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
      
      return await this.sendWhatsAppRequest(phone_number_id, message);
    } catch (error) {
      logger.error('Error al enviar mensaje con botones a WhatsApp', { 
        error, recipient, bodyText, buttons 
      });
      return false;
    }
  }

  /**
   * Enviar mensaje con lista de opciones a WhatsApp
   */
  public async sendListMessage(
    phone_number_id: string,
    recipient: string,
    bodyText: string,
    buttonText: string,
    sections: Array<{
      title?: string;
      items: Array<{ id: string; title: string; description?: string }>;
    }>,
    headerText?: string,
    footerText?: string
  ): Promise<boolean> {
    try {
      const formattedRecipient = this.formatPhoneNumber(recipient);
      
      const message: InteractiveMessage = {
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
      
      return await this.sendWhatsAppRequest(phone_number_id, message);
    } catch (error) {
      logger.error('Error al enviar mensaje con lista a WhatsApp', { 
        error, recipient, bodyText 
      });
      return false;
    }
  }

  /**
   * Enviar solicitud a la API de WhatsApp con manejo adecuado de timeout
   */
  private async sendWhatsAppRequest(
    phone_number_id: string,
    message: WhatsAppMessage
  ): Promise<boolean> {
    if (!this.token) {
      logger.error('No se puede enviar mensaje: Token de WhatsApp no configurado');
      return false;
    }
    
    const url = `${this.graphApiBaseUrl}/${this.graphApiVersion}/${phone_number_id}/messages`;
    
    let success = false;
    let retryCount = 0;
    const maxRetries = whatsappConfig.messageRetryAttempts;
    
    while (!success && retryCount < maxRetries) {
      try {
        // Usar AbortController para manejar timeouts
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), whatsappConfig.messageTimeout);
        
        const response = await fetch(url, {
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
          const errorData = await response.json();
          throw new Error(`Error API WhatsApp: ${response.status} - ${JSON.stringify(errorData)}`);
        }
        
        const responseData: any = await response.json();
        logger.debug('Mensaje enviado a WhatsApp correctamente', { 
          phoneNumberId: phone_number_id, 
          recipient: message.to,
          messageId: responseData.messages?.[0]?.id 
        });
        
        success = true;
      } catch (error: any) {
        retryCount++;
        
        const isAbortError = error.name === 'AbortError';
        const logMessage = isAbortError 
          ? `Timeout al enviar mensaje después de ${whatsappConfig.messageTimeout}ms` 
          : 'Error al enviar mensaje a WhatsApp';
        
        if (retryCount >= maxRetries) {
          logger.error(`${logMessage} después de varios intentos`, { 
            error: isAbortError ? 'Timeout' : error, 
            phoneNumberId: phone_number_id, 
            recipient: message.to 
          });
          return false;
        }
        
        logger.warn(`Reintentando envío de mensaje (${retryCount}/${maxRetries})`, { 
          error: isAbortError ? 'Timeout' : error, 
          phoneNumberId: phone_number_id
        });
        
        // Esperar antes de reintentar con backoff exponencial
        await new Promise(resolve => 
          setTimeout(resolve, whatsappConfig.messageRetryDelay * Math.pow(2, retryCount - 1))
        );
      }
    }
    
    return success;
  }
}

export default WhatsAppService;