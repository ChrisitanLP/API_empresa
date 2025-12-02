const EventEmitter = require('events');
const logger = require('../conf/logger');

/**
 * Sistema de cola para procesamiento asíncrono de media
 * Gestiona descargas en segundo plano sin bloquear respuestas
 */
class MediaQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = new Map(); // messageId -> job
    this.processing = new Set();
    this.completed = new Map(); // messageId -> mediaData
    this.workers = [];
    this.maxWorkers = 3;
    this.retryAttempts = 2;
    this.jobTimeout = 30000; // 30 segundos
    
    this.startWorkers();
  }

  /**
   * Encolar descarga de media
   * @param {string} messageId - ID del mensaje
   * @param {Object} message - Objeto mensaje de whatsapp-web.js
   * @param {string} clientId - ID del cliente
   * @param {number} priority - Prioridad (0=alta, 1=normal, 2=baja)
   */
  enqueue(messageId, message, clientId, priority = 1) {
    if (this.completed.has(messageId)) {
      return { status: 'completed', data: this.completed.get(messageId) };
    }

    if (this.queue.has(messageId) || this.processing.has(messageId)) {
      return { status: 'processing' };
    }

    const job = {
      messageId,
      message,
      clientId,
      priority,
      attempts: 0,
      enqueuedAt: Date.now(),
      type: message.type
    };

    this.queue.set(messageId, job);
    this.emit('job:enqueued', messageId);
    
    return { status: 'enqueued' };
  }

  /**
   * Obtener estado de descarga
   */
  getStatus(messageId) {
    if (this.completed.has(messageId)) {
      return { status: 'completed', data: this.completed.get(messageId) };
    }
    if (this.processing.has(messageId)) {
      return { status: 'processing' };
    }
    if (this.queue.has(messageId)) {
      const job = this.queue.get(messageId);
      return { 
        status: 'queued', 
        position: this.getQueuePosition(messageId),
        enqueuedAt: job.enqueuedAt
      };
    }
    return { status: 'not_found' };
  }

  /**
   * Iniciar workers
   */
  startWorkers() {
    for (let i = 0; i < this.maxWorkers; i++) {
      this.workers.push(this.createWorker(i));
    }
    logger.info(`MediaQueue: ${this.maxWorkers} workers iniciados`);
  }

  /**
   * Crear worker individual
   */
  createWorker(workerId) {
    const worker = async () => {
      while (true) {
        try {
          const job = this.getNextJob();
          
          if (!job) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }

          await this.processJob(job, workerId);
          
        } catch (error) {
          logger.error(`Worker ${workerId} error:`, error.message);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    };

    worker().catch(error => {
      logger.error(`Worker ${workerId} crashed:`, error);
    });

    return worker;
  }

  /**
   * Obtener siguiente job por prioridad
   */
  getNextJob() {
    if (this.queue.size === 0) return null;

    const jobs = Array.from(this.queue.values())
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.enqueuedAt - b.enqueuedAt;
      });

    const job = jobs[0];
    this.queue.delete(job.messageId);
    this.processing.add(job.messageId);
    
    return job;
  }

  /**
   * Procesar job de descarga
   */
  async processJob(job, workerId) {
    const { messageId, message, clientId, type } = job;
    
    logger.info(`Worker ${workerId}: Procesando ${messageId} (${type})`);

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Job timeout')), this.jobTimeout)
    );

    try {
      const resultPromise = this.downloadAndProcessMedia(message, type);
      const mediaData = await Promise.race([resultPromise, timeoutPromise]);

      if (mediaData) {
        this.completed.set(messageId, {
          ...mediaData,
          processedAt: Date.now(),
          workerId
        });
        
        this.emit('job:completed', messageId, mediaData);
        logger.info(`Worker ${workerId}: ✅ Completado ${messageId}`);
      }

    } catch (error) {
      logger.error(`Worker ${workerId}: ❌ Error ${messageId}:`, error.message);
      
      job.attempts++;
      if (job.attempts < this.retryAttempts) {
        logger.info(`Worker ${workerId}: Reintentando ${messageId} (${job.attempts}/${this.retryAttempts})`);
        this.queue.set(messageId, job);
      } else {
        this.completed.set(messageId, {
          error: true,
          message: error.message,
          processedAt: Date.now()
        });
        this.emit('job:failed', messageId, error);
      }
    } finally {
      this.processing.delete(messageId);
    }
  }

  /**
   * Descargar y procesar media (lógica extraída de formatMessage)
   */
  async downloadAndProcessMedia(message, type) {
    const media = await this.attemptDownloadMedia(message);
    if (!media) return null;

    const mediaData = {
      mediaType: type,
      mediaMimeType: media.mimetype,
      downloadedAt: Date.now()
    };

    // Tipos ligeros: base64 directo
    if (['sticker', 'image', 'audio', 'ptt'].includes(type)) {
      mediaData.mediaBase64 = `data:${media.mimetype};base64,${media.data}`;
    } 
    // Tipos pesados: guardar archivo temporal
    else if (['document', 'video'].includes(type)) {
      const path = require('path');
      
      const extension = media.filename 
        ? path.extname(media.filename) 
        : `.${media.mimetype.split('/')[1]}`;
      
      const fileName = media.filename || `documento${extension}`;
      
      // 🔹 CAMBIO CRÍTICO: Usar messageId consistente
      const tempPath = await this.saveTempMedia(
        message.id._serialized, // ✅ ID completo del mensaje
        extension, 
        media.data
      );
      
      mediaData.mediaTempUrl = `http://localhost:5000/temp/${path.basename(tempPath)}`;
      mediaData.fileName = fileName;
      
      logger.info(`✅ Archivo guardado en: ${tempPath}`);
    }

    return mediaData;
  }

  /**
   * Intentar descarga con reintentos
   */
  async attemptDownloadMedia(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const media = await message.downloadMedia();
        if (media) return media;
      } catch (error) {
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    }
    return null;
  }

  /**
   * Guardar archivo temporal
   */
  async saveTempMedia(messageId, extension, data) {
    const path = require('path');
    const fs = require('fs').promises;
    
    const tempDir = path.join(__dirname, '../temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    // 🔹 FORMATO CONSISTENTE: media_<messageId><extension>
    const sanitizedId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(tempDir, `media_${sanitizedId}${extension}`);
    
    await fs.writeFile(tempPath, Buffer.from(data, 'base64'));
    
    logger.info(`📁 Archivo temporal creado: ${path.basename(tempPath)}`);
    
    return tempPath;
  }

  /**
   * Obtener posición en cola
   */
  getQueuePosition(messageId) {
    const jobs = Array.from(this.queue.values())
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.enqueuedAt - b.enqueuedAt;
      });
    
    return jobs.findIndex(j => j.messageId === messageId) + 1;
  }

  /**
   * Limpiar completados antiguos (> 1 hora)
   */
  cleanup() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    for (const [messageId, data] of this.completed.entries()) {
      if (data.processedAt < oneHourAgo) {
        this.completed.delete(messageId);
      }
    }
  }

  /**
   * Obtener estadísticas
   */
  getStats() {
    return {
      queued: this.queue.size,
      processing: this.processing.size,
      completed: this.completed.size,
      workers: this.maxWorkers
    };
  }
}

// Singleton
const mediaQueue = new MediaQueue();

// Limpieza periódica cada 30 minutos
setInterval(() => mediaQueue.cleanup(), 30 * 60 * 1000);

module.exports = mediaQueue;