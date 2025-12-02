// utils/reconnectionManager.js
const logger = require('../conf/logger');
const config = require('../conf/config');

class ReconnectionManager {
    constructor() {
        this.reconnectAttempts = new Map();
        this.reconnectTimers = new Map();
        this.lastReconnectTime = new Map();
        
        // Configuración de backoff exponencial
        this.config = {
            baseDelay: config.reconnectDelay || 5000,
            maxDelay: 300000, // 5 minutos máximo
            maxAttempts: config.maxRetries || 10,
            backoffMultiplier: 2,
            jitterFactor: 0.1 // 10% de variación aleatoria
        };
    }

    getAttempts(number) {
        return this.reconnectAttempts.get(number) || 0;
    }

    incrementAttempts(number) {
        const current = this.getAttempts(number);
        this.reconnectAttempts.set(number, current + 1);
        return current + 1;
    }

    resetAttempts(number) {
        this.reconnectAttempts.delete(number);
        this.clearTimer(number);
        this.lastReconnectTime.delete(number);
    }

    calculateDelay(attempt) {
        // Backoff exponencial: baseDelay * (2 ^ attempt)
        let delay = this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt);
        
        // Aplicar límite máximo
        delay = Math.min(delay, this.config.maxDelay);
        
        // Añadir jitter (variación aleatoria)
        const jitter = delay * this.config.jitterFactor * (Math.random() * 2 - 1);
        delay = Math.floor(delay + jitter);
        
        return delay;
    }

    canReconnect(number) {
        const attempts = this.getAttempts(number);
        
        if (attempts >= this.config.maxAttempts) {
            logger.error(`[Reconnection] Max attempts (${this.config.maxAttempts}) reached for ${number}`);
            return false;
        }

        // Evitar reconexiones muy rápidas
        const lastAttempt = this.lastReconnectTime.get(number);
        if (lastAttempt && Date.now() - lastAttempt < 2000) {
            logger.warn(`[Reconnection] Too fast reconnection attempt for ${number}`);
            return false;
        }

        return true;
    }

    scheduleReconnection(number, callback) {
        if (!this.canReconnect(number)) {
            logger.error(`[Reconnection] Cannot reconnect ${number}`);
            return null;
        }

        const attempt = this.incrementAttempts(number);
        const delay = this.calculateDelay(attempt);

        logger.info(`[Reconnection] Scheduling reconnection for ${number} (attempt ${attempt}/${this.config.maxAttempts}) in ${delay}ms`);

        // Limpiar timer anterior si existe
        this.clearTimer(number);

        // Crear nuevo timer
        const timer = setTimeout(async () => {
            this.lastReconnectTime.set(number, Date.now());
            
            try {
                await callback();
                logger.info(`[Reconnection] Successful reconnection for ${number}`);
                this.resetAttempts(number);
            } catch (error) {
                logger.error(`[Reconnection] Failed for ${number}:`, error.message);
                
                // Intentar de nuevo si no se alcanzó el límite
                if (this.canReconnect(number)) {
                    this.scheduleReconnection(number, callback);
                }
            }
        }, delay);

        this.reconnectTimers.set(number, timer);
        return { attempt, delay };
    }

    clearTimer(number) {
        const timer = this.reconnectTimers.get(number);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(number);
        }
    }

    getStatus(number) {
        return {
            attempts: this.getAttempts(number),
            maxAttempts: this.config.maxAttempts,
            hasScheduledReconnect: this.reconnectTimers.has(number),
            lastReconnectTime: this.lastReconnectTime.get(number),
            canReconnect: this.canReconnect(number)
        };
    }

    cleanup(number) {
        this.clearTimer(number);
        this.reconnectAttempts.delete(number);
        this.lastReconnectTime.delete(number);
    }
}

module.exports = new ReconnectionManager();