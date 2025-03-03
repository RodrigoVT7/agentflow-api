"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.initDatabaseConnection = initDatabaseConnection;
exports.closeDatabaseConnection = closeDatabaseConnection;
// src/database/connection.ts
const mongoose_1 = __importDefault(require("mongoose"));
const pg_1 = require("pg");
const promise_1 = require("mysql2/promise");
const sqlite3_1 = __importDefault(require("sqlite3"));
const sqlite_1 = require("sqlite");
const database_config_1 = __importStar(require("../config/database.config"));
const logger_1 = __importDefault(require("../utils/logger"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Variable para almacenar la conexión activa
let connection = null;
/**
 * Inicializar conexión a la base de datos según la configuración
 */
function initDatabaseConnection() {
    return __awaiter(this, void 0, void 0, function* () {
        if (connection) {
            return connection;
        }
        try {
            switch (database_config_1.default.type) {
                case database_config_1.DatabaseType.MONGODB:
                    if (!database_config_1.default.url) {
                        throw new Error('MongoDB URI no configurada');
                    }
                    // Conectar a MongoDB
                    connection = yield mongoose_1.default.connect(database_config_1.default.url, Object.assign({ dbName: database_config_1.default.database }, database_config_1.default.options));
                    logger_1.default.info('Conexión a MongoDB establecida correctamente');
                    break;
                case database_config_1.DatabaseType.POSTGRES:
                    // Conectar a PostgreSQL
                    connection = new pg_1.Pool({
                        host: database_config_1.default.host,
                        port: database_config_1.default.port,
                        user: database_config_1.default.username,
                        password: database_config_1.default.password,
                        database: database_config_1.default.database
                    });
                    // Verificar conexión
                    const pgClient = yield connection.connect();
                    pgClient.release();
                    logger_1.default.info('Conexión a PostgreSQL establecida correctamente');
                    break;
                case database_config_1.DatabaseType.MYSQL:
                    // Conectar a MySQL
                    connection = yield (0, promise_1.createConnection)({
                        host: database_config_1.default.host,
                        port: database_config_1.default.port,
                        user: database_config_1.default.username,
                        password: database_config_1.default.password,
                        database: database_config_1.default.database,
                        connectionLimit: 10
                    });
                    logger_1.default.info('Conexión a MySQL establecida correctamente');
                    break;
                case database_config_1.DatabaseType.SQLITE:
                    if (!database_config_1.default.filePath) {
                        throw new Error('Ruta de archivo SQLite no configurada');
                    }
                    // Asegurar que el directorio existe
                    const dir = path_1.default.dirname(database_config_1.default.filePath);
                    if (!fs_1.default.existsSync(dir)) {
                        fs_1.default.mkdirSync(dir, { recursive: true });
                    }
                    // Conectar a SQLite
                    connection = yield (0, sqlite_1.open)({
                        filename: database_config_1.default.filePath,
                        driver: sqlite3_1.default.Database
                    });
                    logger_1.default.info('Conexión a SQLite establecida correctamente');
                    break;
                case database_config_1.DatabaseType.MEMORY:
                default:
                    // "Conexión" en memoria (no se necesita realmente una conexión)
                    connection = {
                        type: 'memory',
                        isConnected: true
                    };
                    logger_1.default.info('Utilizando almacenamiento en memoria');
                    break;
            }
            return connection;
        }
        catch (error) {
            logger_1.default.error(`Error al conectar a la base de datos (${database_config_1.default.type})`, { error });
            throw error;
        }
    });
}
/**
 * Cerrar conexión a la base de datos
 */
function closeDatabaseConnection() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!connection) {
            return;
        }
        try {
            switch (database_config_1.default.type) {
                case database_config_1.DatabaseType.MONGODB:
                    yield mongoose_1.default.disconnect();
                    break;
                case database_config_1.DatabaseType.POSTGRES:
                    yield connection.end();
                    break;
                case database_config_1.DatabaseType.MYSQL:
                    yield connection.end();
                    break;
                case database_config_1.DatabaseType.SQLITE:
                    yield connection.close();
                    break;
                case database_config_1.DatabaseType.MEMORY:
                default:
                    // No se necesita cerrar nada para almacenamiento en memoria
                    break;
            }
            connection = null;
            logger_1.default.info(`Conexión a base de datos (${database_config_1.default.type}) cerrada correctamente`);
        }
        catch (error) {
            logger_1.default.error(`Error al cerrar conexión a base de datos (${database_config_1.default.type})`, { error });
            throw error;
        }
    });
}
exports.default = { initDatabaseConnection, closeDatabaseConnection };
