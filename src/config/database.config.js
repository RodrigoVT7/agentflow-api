"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseType = void 0;
// src/config/database.config.ts
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Cargar variables de entorno si no se ha hecho ya
if (!process.env.DATABASE_TYPE) {
    dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
}
// Tipos de base de datos soportados
var DatabaseType;
(function (DatabaseType) {
    DatabaseType["MEMORY"] = "memory";
    DatabaseType["MONGODB"] = "mongodb";
    DatabaseType["POSTGRES"] = "postgres";
    DatabaseType["MYSQL"] = "mysql";
    DatabaseType["SQLITE"] = "sqlite";
})(DatabaseType || (exports.DatabaseType = DatabaseType = {}));
// Determinar tipo de base de datos
const dbType = (process.env.DATABASE_TYPE || 'memory').toLowerCase();
// Configuración base
const config = {
    type: dbType,
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
        config.filePath = process.env.SQLITE_FILE_PATH || path_1.default.join(__dirname, '../../data/database.sqlite');
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
    }
    else if (dbType === DatabaseType.SQLITE && !config.filePath) {
        console.warn('⚠️ SQLITE_FILE_PATH no está configurado. Usando la ruta predeterminada.');
    }
    else if ((dbType === DatabaseType.POSTGRES || dbType === DatabaseType.MYSQL) &&
        (!config.username || !config.password || !config.database)) {
        console.warn(`⚠️ Configuración incompleta para ${dbType}. Verifica las variables de entorno.`);
    }
}
exports.default = config;
