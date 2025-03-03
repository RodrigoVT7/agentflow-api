// src/controllers/webhook.controller.ts
import { Request, Response, NextFunction } from 'express';
import { initConversationService } from '../services/conversation.service';
import config from '../config/app.config';

// Servicios
const conversationService = initConversationService();

export class WebhookController {
  /**
   * Verificar webhook (requerido por Meta)
   */
  public verifyWebhook = (req: Request, res: Response): void => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
      console.log('Webhook verificado correctamente');
      res.status(200).send(challenge);
    } else {
      console.error('Verificación de webhook fallida');
      res.sendStatus(403);
    }
  };

  /**
   * Procesar mensajes entrantes de WhatsApp
   */
  public processWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validar que es un evento válido
      if (!req.body.object) {
        res.sendStatus(404);
        return;
      }
      
      // Validar que hay un mensaje entrante
      if (
        !req.body.entry ||
        !req.body.entry[0].changes ||
        !req.body.entry[0].changes[0].value.messages ||
        !req.body.entry[0].changes[0].value.messages[0]
      ) {
        res.sendStatus(200); // Aceptar el evento pero no procesarlo
        return;
      }
      
      // Extraer información del mensaje
      const phone_number_id = req.body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = req.body.entry[0].changes[0].value.messages[0].from;
      
      // Procesar por tipo de mensaje
      const messageObject = req.body.entry[0].changes[0].value.messages[0];
      
      if (messageObject.type === 'text' && messageObject.text && messageObject.text.body) {
        // Mensaje de texto
        const msg_body = messageObject.text.body;
        
        console.log(`Mensaje de texto recibido de ${from}: ${msg_body}`);
        
        // Procesar el mensaje con el servicio de conversación
        await conversationService.sendMessage(from, phone_number_id, msg_body);
      } 
      else if (messageObject.type === 'image') {
        // Mensaje de imagen
        console.log(`Imagen recibida de ${from}`);
        
        // Mensaje predeterminado para imágenes
        await conversationService.sendMessage(
          from, 
          phone_number_id, 
          "He recibido tu imagen, pero actualmente solo puedo procesar mensajes de texto."
        );
      }
      else if (messageObject.type === 'audio') {
        // Mensaje de audio
        console.log(`Audio recibido de ${from}`);
        
        // Mensaje predeterminado para audio
        await conversationService.sendMessage(
          from, 
          phone_number_id, 
          "He recibido tu mensaje de voz, pero actualmente solo puedo procesar mensajes de texto."
        );
      }
      else if (messageObject.type === 'document') {
        // Documento
        console.log(`Documento recibido de ${from}`);
        
        // Mensaje predeterminado para documentos
        await conversationService.sendMessage(
          from, 
          phone_number_id, 
          "He recibido tu documento, pero actualmente solo puedo procesar mensajes de texto."
        );
      }
      else {
        // Otro tipo de mensaje no soportado
        console.log(`Mensaje no soportado recibido de ${from} (tipo: ${messageObject.type})`);
        
        await conversationService.sendMessage(
          from, 
          phone_number_id, 
          "Lo siento, este tipo de mensaje no es compatible actualmente."
        );
      }
      
      // Responder correctamente a Meta
      res.sendStatus(200);
    } catch (error) {
      console.error('Error al procesar webhook:', error);
      
      // Siempre devolver 200 a Meta para evitar reenvíos
      res.sendStatus(200);
      
      // Pasar el error al siguiente middleware
      next(error);
    }
  };
}

export default new WebhookController();