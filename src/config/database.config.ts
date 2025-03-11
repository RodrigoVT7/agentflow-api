// src/config/database.config.ts
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Cargar variables de entorno si no se ha hecho ya
if (!process.env.DATABASE_PATH) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

interface DatabaseConfig {
  filePath: string;
}

// Configuración para SQLite
const config: DatabaseConfig = {
  filePath: process.env.DATABASE_PATH || path.join(__dirname, '../../data/database.sqlite')
};

// Asegurar que el directorio existe
const dir = path.dirname(config.filePath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log(`SQLite configurado en: ${config.filePath}`);

export default config;