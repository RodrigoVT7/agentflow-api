// src/config/database.config.ts
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno si no se ha hecho ya
if (!process.env.DATABASE_TYPE) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

// Tipos de base de datos soportados
export enum DatabaseType {
  MEMORY = 'memory',
  MONGODB = 'mongodb',
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  SQLITE = 'sqlite'
}

interface DatabaseConfig {
  type: DatabaseType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  url?: string;
  options?: Record<string, any>;
  // Opciones para bases de datos locales/fichero
  filePath?: string;
}

// Determinar tipo de base de datos
const dbType = (process.env.DATABASE_TYPE || 'memory').toLowerCase() as DatabaseType;

// Configuración base
const config: DatabaseConfig = {
  type: dbType as DatabaseType,
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }
};

// Configurar según el tipo de base de datos
switch (dbType) {
  case DatabaseType.MONGODB:
    config.url = process.env.MONGODB_URI;
    config.database = process.env.MONGODB_DB;
    break;
    
  case DatabaseType.POSTGRES:
    config.host = process.env.POSTGRES_HOST || 'localhost';
    config.port = parseInt(process.env.POSTGRES_PORT || '5432', 10);
    config.username = process.env.POSTGRES_USER;
    config.password = process.env.POSTGRES_PASSWORD;
    config.database = process.env.POSTGRES_DB;
    break;
    
  case DatabaseType.MYSQL:
    config.host = process.env.MYSQL_HOST || 'localhost';
    config.port = parseInt(process.env.MYSQL_PORT || '3306', 10);
    config.username = process.env.MYSQL_USER;
    config.password = process.env.MYSQL_PASSWORD;
    config.database = process.env.MYSQL_DB;
    break;
    
  case DatabaseType.SQLITE:
    config.filePath = process.env.SQLITE_FILE_PATH || path.join(__dirname, '../../data/database.sqlite');
    break;
    
  case DatabaseType.MEMORY:
  default:
    // No se necesita configuración adicional para memoria
    break;
}

// Validar configuración
if (dbType !== DatabaseType.MEMORY) {
  if (dbType === DatabaseType.MONGODB && !config.url) {
    console.warn('⚠️ MONGODB_URI no está configurado. Se recomienda configurarlo para conexiones a MongoDB.');
  } else if (dbType === DatabaseType.SQLITE && !config.filePath) {
    console.warn('⚠️ SQLITE_FILE_PATH no está configurado. Usando la ruta predeterminada.');
  } else if ((dbType === DatabaseType.POSTGRES || dbType === DatabaseType.MYSQL) && 
             (!config.username || !config.password || !config.database)) {
    console.warn(`⚠️ Configuración incompleta para ${dbType}. Verifica las variables de entorno.`);
  }
}

export default config;