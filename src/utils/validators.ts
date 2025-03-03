// src/utils/validators.ts
import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../middleware/error.middleware';

/**
 * Interfaz para esquema de validación de campos
 */
interface ValidationSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'email' | 'phone';
    required?: boolean;
    min?: number;
    max?: number;
    pattern?: RegExp;
    values?: any[];
    custom?: (value: any) => boolean | string;
  };
}

/**
 * Middleware para validar datos de solicitud
 * @param schema Esquema de validación
 * @param source Fuente de los datos (body, query, params)
 */
export const validateRequest = (
  schema: ValidationSchema,
  source: 'body' | 'query' | 'params' = 'body'
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const errors: string[] = [];

    // Validar cada campo según el esquema
    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      // Verificar si es requerido
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`El campo '${field}' es obligatorio`);
        continue;
      }

      // Si no está presente y no es requerido, continuar
      if (value === undefined || value === null || value === '') {
        continue;
      }

      // Validar tipo
      switch (rules.type) {
        case 'string':
          if (typeof value !== 'string') {
            errors.push(`El campo '${field}' debe ser una cadena de texto`);
          } else {
            // Validar longitud mínima
            if (rules.min !== undefined && value.length < rules.min) {
              errors.push(`El campo '${field}' debe tener al menos ${rules.min} caracteres`);
            }
            // Validar longitud máxima
            if (rules.max !== undefined && value.length > rules.max) {
              errors.push(`El campo '${field}' debe tener máximo ${rules.max} caracteres`);
            }
            // Validar patrón
            if (rules.pattern && !rules.pattern.test(value)) {
              errors.push(`El campo '${field}' no tiene un formato válido`);
            }
          }
          break;
        
        case 'number':
          if (typeof value !== 'number' && isNaN(Number(value))) {
            errors.push(`El campo '${field}' debe ser un número`);
          } else {
            const numValue = Number(value);
            // Validar valor mínimo
            if (rules.min !== undefined && numValue < rules.min) {
              errors.push(`El campo '${field}' debe ser mayor o igual a ${rules.min}`);
            }
            // Validar valor máximo
            if (rules.max !== undefined && numValue > rules.max) {
              errors.push(`El campo '${field}' debe ser menor o igual a ${rules.max}`);
            }
          }
          break;
        
        case 'boolean':
          if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
            errors.push(`El campo '${field}' debe ser un valor booleano`);
          }
          break;
        
        case 'array':
          if (!Array.isArray(value)) {
            errors.push(`El campo '${field}' debe ser un array`);
          } else {
            // Validar longitud mínima
            if (rules.min !== undefined && value.length < rules.min) {
              errors.push(`El campo '${field}' debe tener al menos ${rules.min} elementos`);
            }
            // Validar longitud máxima
            if (rules.max !== undefined && value.length > rules.max) {
              errors.push(`El campo '${field}' debe tener máximo ${rules.max} elementos`);
            }
          }
          break;
        
        case 'object':
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push(`El campo '${field}' debe ser un objeto`);
          }
          break;
        
        case 'email':
          const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
          if (typeof value !== 'string' || !emailRegex.test(value)) {
            errors.push(`El campo '${field}' debe ser un email válido`);
          }
          break;
        
        case 'phone':
          const phoneRegex = /^\+?[0-9]{10,15}$/;
          if (typeof value !== 'string' || !phoneRegex.test(value)) {
            errors.push(`El campo '${field}' debe ser un número de teléfono válido`);
          }
          break;
      }

      // Validar valores permitidos
      if (rules.values && !rules.values.includes(value)) {
        errors.push(`El campo '${field}' debe ser uno de los siguientes valores: ${rules.values.join(', ')}`);
      }

      // Validación personalizada
      if (rules.custom) {
        const customResult = rules.custom(value);
        if (typeof customResult === 'string') {
          errors.push(customResult);
        } else if (customResult === false) {
          errors.push(`El campo '${field}' no cumple con la validación personalizada`);
        }
      }
    }

    // Si hay errores, responder con error 400
    if (errors.length > 0) {
      next(new HttpError(`Validación fallida: ${errors.join('. ')}`, 400));
    } else {
      next();
    }
  };
};

/**
 * Validar formato de email
 */
export const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
};

/**
 * Validar formato de número de teléfono
 */
export const isValidPhoneNumber = (phone: string): boolean => {
  // Eliminar cualquier carácter no numérico excepto el signo +
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  
  // Debe tener entre 10 y 15 dígitos, opcionalmente con un + al inicio
  const phoneRegex = /^\+?[0-9]{10,15}$/;
  return phoneRegex.test(cleanPhone);
};

/**
 * Validar formato de URL
 */
export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Validar si un texto puede contener código malicioso
 */
export const isSafeText = (text: string): boolean => {
  // Detectar posibles intentos de inyección de scripts
  const unsafePatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/gi,
    /on\w+=/gi,
    /data:text\/html/gi
  ];
  
  return !unsafePatterns.some(pattern => pattern.test(text));
};

/**
 * Sanitizar texto para prevenir inyección
 */
export const sanitizeText = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

/**
 * Esquemas de validación comunes
 */
export const validationSchemas = {
  login: {
    email: {
      type: 'email',
      required: true
    },
    password: {
      type: 'string',
      required: true,
      min: 6
    }
  },
  
  registerAgent: {
    name: {
      type: 'string',
      required: true,
      min: 2,
      max: 100
    },
    email: {
      type: 'email',
      required: true
    },
    password: {
      type: 'string',
      required: true,
      min: 6,
      max: 100
    },
    role: {
      type: 'string',
      values: ['agent', 'supervisor', 'admin']
    },
    maxConcurrentChats: {
      type: 'number',
      min: 1,
      max: 10
    }
  },
  
  sendMessage: {
    agentId: {
      type: 'string',
      required: true
    },
    conversationId: {
      type: 'string',
      required: true
    },
    message: {
      type: 'string',
      required: true,
      min: 1,
      max: 4000,
      custom: (value: string) => isSafeText(value) || 'El mensaje contiene contenido no permitido'
    }
  },
  
  updatePriority: {
    conversationId: {
      type: 'string',
      required: true
    },
    priority: {
      type: 'number',
      required: true,
      min: 1,
      max: 5
    }
  }
};