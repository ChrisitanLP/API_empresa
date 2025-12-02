// utils/clientStateManager.js
const logger = require('../conf/logger');

class ClientStateManager {
    constructor() {
        this.states = new Map();
        this.stateHistory = new Map();
        this.CLIENT_STATES = {
            INITIALIZING: 'INITIALIZING',
            WAITING_QR: 'WAITING_QR',
            AUTHENTICATING: 'AUTHENTICATING',
            AUTHENTICATED: 'AUTHENTICATED',
            READY: 'READY',
            DISCONNECTED: 'DISCONNECTED',
            AUTH_FAILURE: 'AUTH_FAILURE',
            ERROR: 'ERROR',
            RECONNECTING: 'RECONNECTING',
            ZOMBIE: 'ZOMBIE' // Proceso colgado
        };
    }

    setState(number, state, metadata = {}) {
        const previousState = this.states.get(number);
        const stateChange = {
            number,
            from: previousState?.state || 'UNKNOWN',
            to: state,
            timestamp: new Date(),
            metadata
        };

        this.states.set(number, {
            state,
            timestamp: new Date(),
            metadata,
            previousState: previousState?.state
        });

        // Mantener historial (últimos 50 cambios)
        if (!this.stateHistory.has(number)) {
            this.stateHistory.set(number, []);
        }
        const history = this.stateHistory.get(number);
        history.push(stateChange);
        if (history.length > 50) history.shift();

        logger.info(`[State Change] ${number}: ${stateChange.from} → ${state}`, metadata);
        
        return stateChange;
    }

    getState(number) {
        return this.states.get(number);
    }

    getHistory(number) {
        return this.stateHistory.get(number) || [];
    }

    isHealthy(number) {
        const state = this.getState(number);
        if (!state) return false;
        
        return [
            this.CLIENT_STATES.AUTHENTICATED,
            this.CLIENT_STATES.READY
        ].includes(state.state);
    }

    isRecoverable(number) {
        const state = this.getState(number);
        if (!state) return true;
        
        // Estados que permiten reconexión
        return ![
            this.CLIENT_STATES.ZOMBIE,
            this.CLIENT_STATES.ERROR
        ].includes(state.state);
    }

    getStateAge(number) {
        const state = this.getState(number);
        if (!state) return null;
        return Date.now() - state.timestamp.getTime();
    }

    clearState(number) {
        this.states.delete(number);
        this.stateHistory.delete(number);
    }
}

module.exports = new ClientStateManager();