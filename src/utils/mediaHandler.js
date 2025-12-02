// utils/mediaHandler.js
const fs = require('fs').promises;
const path = require('path');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const mime = require('mime-types');
const logger = require('../conf/logger');

class MediaHandler {
    constructor() {
        this.tempDir = path.join(__dirname, '../temp');
        this.maxInMemorySize = 5 * 1024 * 1024; // 5MB
        this.allowedMimeTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
            'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
            'application/pdf', 'application/zip', 'application/x-rar-compressed',
            'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];
        this.maxFileSize = 100 * 1024 * 1024; // 100MB
        this.ensureTempDirectory();
    }

    async ensureTempDirectory() {
        try {
            await fs.access(this.tempDir);
        } catch {
            await fs.mkdir(this.tempDir, { recursive: true });
            logger.info(`Created temp directory at ${this.tempDir}`);
        }
    }

    generateFileId() {
        return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    }

    isHeavyMedia(mimetype) {
        if (!mimetype) return false;
        
        return mimetype.startsWith('video/') || 
               mimetype.startsWith('audio/') ||
               mimetype === 'application/pdf' ||
               mimetype === 'application/zip' ||
               mimetype === 'application/x-rar-compressed';
    }

    validateMimeType(mimetype) {
        if (!this.allowedMimeTypes.includes(mimetype)) {
            throw new Error(`Tipo de archivo no permitido: ${mimetype}`);
        }
    }

    async estimateMediaSize(media) {
        if (!media || !media.data) return 0;
        
        // Estimar tamaño desde base64
        const base64Length = media.data.length;
        const estimatedSize = (base64Length * 3) / 4;
        
        return estimatedSize;
    }

    /**
     * Procesa media: si es pesado lo guarda en disco, si es liviano retorna base64
     */
    async processMedia(media, messageId) {
        try {
            if (!media || !media.data) {
                logger.warn('Media data is null or undefined');
                return null;
            }

            const mimetype = media.mimetype || 'application/octet-stream';
            this.validateMimeType(mimetype);

            const estimatedSize = await this.estimateMediaSize(media);
            
            if (estimatedSize > this.maxFileSize) {
                throw new Error(`Archivo demasiado grande: ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`);
            }

            const isHeavy = this.isHeavyMedia(mimetype) || estimatedSize > this.maxInMemorySize;

            if (isHeavy) {
                return await this.saveToFile(media, messageId);
            } else {
                return this.createInMemoryResponse(media, messageId);
            }

        } catch (error) {
            logger.error('Error processing media:', error);
            throw error;
        }
    }

    /**
     * Guarda archivo pesado en disco usando streaming
     */
    async saveToFile(media, messageId) {
        const fileId = this.generateFileId();
        const extension = mime.extension(media.mimetype) || 'bin';
        const filename = `media_${fileId}.${extension}`;
        const filepath = path.join(this.tempDir, filename);

        try {
            // Convertir base64 a buffer en chunks para evitar memory overflow
            const buffer = Buffer.from(media.data, 'base64');
            
            // Escribir usando stream
            const writeStream = createWriteStream(filepath);
            await new Promise((resolve, reject) => {
                writeStream.write(buffer, (err) => {
                    if (err) reject(err);
                    else {
                        writeStream.end();
                        resolve();
                    }
                });
            });

            logger.info(`Media saved to file: ${filename}`);

            return {
                isFile: true,
                fileId: fileId,
                filename: filename,
                filepath: filepath,
                mimetype: media.mimetype,
                size: buffer.length,
                url: `/api/media/${fileId}`,
                // Mantener campos originales como null para compatibilidad
                base64Data: null
            };

        } catch (error) {
            logger.error('Error saving media to file:', error);
            // Limpiar archivo si hay error
            try {
                await fs.unlink(filepath);
            } catch {}
            throw error;
        }
    }

    /**
     * Retorna respuesta para archivos pequeños (en memoria)
     */
    createInMemoryResponse(media, messageId) {
        const extension = mime.extension(media.mimetype) || 'bin';
        
        return {
            isFile: false,
            filename: `media_${messageId}.${extension}`,
            base64Data: media.data,
            mimetype: media.mimetype,
            size: Buffer.from(media.data, 'base64').length
        };
    }

    /**
     * Recupera archivo desde disco usando streaming
     */
    async getMediaStream(fileId) {
        const files = await fs.readdir(this.tempDir);
        const targetFile = files.find(f => f.includes(fileId));

        if (!targetFile) {
            throw new Error('File not found');
        }

        const filepath = path.join(this.tempDir, targetFile);
        const stats = await fs.stat(filepath);
        const mimetype = mime.lookup(filepath) || 'application/octet-stream';

        return {
            stream: createReadStream(filepath),
            mimetype,
            size: stats.size,
            filename: targetFile
        };
    }

    /**
     * Limpia archivos antiguos (más de 24 horas)
     */
    async cleanupOldFiles() {
        try {
            const files = await fs.readdir(this.tempDir);
            const now = Date.now();
            const maxAge = 24 * 60 * 60 * 1000; // 24 horas

            for (const file of files) {
                const filepath = path.join(this.tempDir, file);
                const stats = await fs.stat(filepath);
                
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filepath);
                    logger.info(`Deleted old file: ${file}`);
                }
            }
        } catch (error) {
            logger.error('Error cleaning up old files:', error);
        }
    }

    /**
     * Inicia limpieza automática cada 6 horas
     */
    startAutoCleanup() {
        setInterval(() => {
            this.cleanupOldFiles();
        }, 6 * 60 * 60 * 1000);
        
        logger.info('Auto cleanup started');
    }
}

const mediaHandler = new MediaHandler();
mediaHandler.startAutoCleanup();

module.exports = mediaHandler;