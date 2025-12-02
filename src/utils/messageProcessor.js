// utils/messageProcessor.js
const mime = require('mime-types');
const logger = require('../conf/logger');
const mediaHandler = require('./mediaHandler');

class MessageProcessor {
    async processMessage(number, message) {
        try {
            if (message.hasMedia) return await this.processMediaMessage(number, message);
            if (message.type === 'location') return this.processLocationMessage(number, message);
            return this.processTextMessage(number, message);
        } catch (error) {
            logger.error('Error processing message:', error);
            throw error;
        }
    }

    async processMediaMessage(number, message) {
        try {
            // Descargar media con timeout
            const media = await Promise.race([
                message.downloadMedia(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Media download timeout')), 30000)
                )
            ]);

            if (!media) {
                logger.warn(`Media download returned null for message ${message.id._serialized}`);
                return { number, message };
            }

            // 🆕 Procesar media según su tamaño
            const processedMedia = await mediaHandler.processMedia(media, message.id._serialized);

            if (!processedMedia) {
                return { number, message };
            }

            // 🆕 Construir respuesta manteniendo estructura original
            const response = {
                number,
                media: {
                    media: {
                        filename: processedMedia.filename,
                        mimetype: processedMedia.mimetype,
                        base64Data: processedMedia.base64Data, // null si es archivo pesado
                    }
                },
                message
            };

            // 🆕 Si es archivo pesado, agregar campos adicionales
            if (processedMedia.isFile) {
                response.media.media.isFile = true;
                response.media.media.fileId = processedMedia.fileId;
                response.media.media.url = processedMedia.url;
                response.media.media.size = processedMedia.size;
            }

            return response;

        } catch (error) {
            logger.error(`Error processing media message from ${number}:`, error.message);
            return { number, message };
        }
    }

    processLocationMessage(number, message) {
        return {
            number,
            location: {
                location: {
                    latitude: message.location.latitude,
                    longitude: message.location.longitude,
                    description: message.location.description || 'Sin descripción',
                    address: message.location.address || 'Sin dirección',
                    name: message.location.name || 'Sin nombre'
                }
            },
            message
        };
    }

    processTextMessage(number, message) {
        return { number, message };
    }
}

const messageProcessor = new MessageProcessor();
module.exports = messageProcessor;